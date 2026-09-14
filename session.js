const CANDIDATE_MIN = 1, CANDIDATE_MAX = 20;

export class Session {
  constructor(code, masterId, masterName, io) {
    this.code = code;
    this.masterId = masterId;
    this.masterName = masterName;
    this.io = io; // riferimento per emettere eventi

    this.playlist = [];
    this.current = null;
    this.isPlaying = false;
    this.startedAt = null;
    this.pausedElapsed = 0;
    this.candidates = [];
    this.candidatesCount = 5;
    this.votes = new Map();
    this.users = new Map([[masterId, masterName]]);
    this.timer = null;
  }

  isMaster(socket) {
    return this.masterId === socket.id;
  }

  toPublicState() {
    return {
      code: this.code,
      masterId: this.masterId,
      masterName: this.masterName,
      playlist: this.playlist.map(t => ({
        id: t.id, title: t.title, artist: t.artist, duration: t.duration
      })),
      current: this.current,
      isPlaying: this.isPlaying,
      startedAt: this.startedAt,
      pausedElapsed: this.pausedElapsed || 0,
      candidatesCount: this.candidatesCount,
      candidates: this.candidates.map(id => {
        const t = this.playlist.find(x => x.id === id) || {};
        return {
          id, title: t.title, artist: t.artist, duration: t.duration,
          voters: [...(this.votes.get(id) || [])]
        };
      }),
      users: [...this.users.entries()].map(([id, name]) => ({
        id, name, isMaster: id === this.masterId
      }))
    };
  }

  broadcast() {
    this.io.to(this.code).emit('state', this.toPublicState());
  }

  #stopTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  #pickCandidates() {
    const exclude = new Set();
    if (this.current) exclude.add(this.current.id);
    const pool = this.playlist.filter(t => !exclude.has(t.id));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const n = Math.min(this.candidatesCount, pool.length);
    return pool.slice(0, n).map(t => t.id);
  }

  #pickWinner() {
    if (this.candidates.length === 0) return null;
    let max = -1, tied = [];
    for (const id of this.candidates) {
      const votes = (this.votes.get(id) || new Set()).size;
      if (votes > max) { max = votes; tied = [id]; }
      else if (votes === max) tied.push(id);
    }
    return tied[Math.floor(Math.random() * tied.length)];
  }

  setPlaylist(tracks, trackIdFactory) {
    this.playlist = tracks.map(t => ({
      id: trackIdFactory(),
      title: (t.title || 'Senza titolo').toString().slice(0, 120),
      artist: (t.artist || '').toString().slice(0, 120),
      duration: Math.max(5, Math.min(3600, Number(t.duration) || 30))
    }));
    this.#stopTimer();
    this.current = null;
    this.isPlaying = false;
    this.startedAt = null;
    this.pausedElapsed = 0;
    this.candidates = [];
    this.votes = new Map();
  }

  setCandidateCount(count) {
    this.candidatesCount = Math.max(CANDIDATE_MIN, Math.min(CANDIDATE_MAX, Number(count) || 5));
  }

  startTrack(trackId, offsetMs = 0) {
    const track = this.playlist.find(t => t.id === trackId);
    if (!track) return;
    this.#stopTimer();

    const isSameTrack = this.current && this.current.id === trackId;
    this.current = track;
    this.isPlaying = true;
    this.startedAt = Date.now() - offsetMs;
    this.pausedElapsed = offsetMs;

    if (!isSameTrack || this.candidates.length === 0) {
      this.candidates = this.#pickCandidates();
      this.votes = new Map();
    }

    const dur = Math.max(5, Number(track.duration) || 30) * 1000;
    const remaining = Math.max(1000, dur - offsetMs);
    this.timer = setTimeout(() => this.advance(), remaining);
    this.broadcast();
  }

  advance() {
    if (!this.isPlaying) return;
    const winner = this.#pickWinner();
    if (winner) return this.startTrack(winner, 0);

    const others = this.playlist.filter(t => t.id !== this.current?.id);
    if (others.length === 0) {
      this.isPlaying = false;
      this.broadcast();
      return;
    }
    const r = others[Math.floor(Math.random() * others.length)];
    this.startTrack(r.id, 0);
  }

  block() {
    if (!this.isPlaying || !this.startedAt) return;
    this.pausedElapsed = Date.now() - this.startedAt;
    this.#stopTimer();
    this.isPlaying = false;
  }

  resume() {
    if (this.isPlaying || !this.current) return;
    this.startTrack(this.current.id, this.pausedElapsed || 0);
  }

  vote(socketId, trackId) {
    if (!this.candidates.includes(trackId)) return;
    const alreadyVoted = this.votes.get(trackId)?.has(socketId);
    for (const set of this.votes.values()) set.delete(socketId);
    if (!alreadyVoted) {
      if (!this.votes.has(trackId)) this.votes.set(trackId, new Set());
      this.votes.get(trackId).add(socketId);
    }
  }

  removeUser(socketId) {
    this.users.delete(socketId);
    for (const set of this.votes.values()) set.delete(socketId);
  }

  close() {
    this.#stopTimer();
  }
}