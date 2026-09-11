import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Stato in memoria                                                    */
/* ------------------------------------------------------------------ */

const sessions = new Map();
const socketInfo = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code;
  do {
    code = Array.from({ length: 5 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (sessions.has(code));
  return code;
}

let trackCounter = 0;

function getSession(socket) {
  const info = socketInfo.get(socket.id);
  if (!info) return null;
  return sessions.get(info.code) || null;
}
const isMaster = (socket, session) => session && session.masterId === socket.id;

/* ------------------------------------------------------------------ */
/* Utility di stato                                                    */
/* ------------------------------------------------------------------ */

function publicState(session) {
  return {
    code: session.code,
    masterId: session.masterId,
    masterName: session.masterName,
    playlist: session.playlist.map(t => ({
      id: t.id, title: t.title, artist: t.artist, duration: t.duration
    })),
    current: session.current,
    isPlaying: session.isPlaying,
    startedAt: session.startedAt,
    pausedElapsed: session.pausedElapsed || 0,
    candidatesCount: session.candidatesCount,
    candidates: session.candidates.map(id => {
      const t = session.playlist.find(x => x.id === id) || {};
      return {
        id,
        title: t.title,
        artist: t.artist,
        duration: t.duration,
        voters: [...(session.votes.get(id) || [])]
      };
    }),
    users: [...session.users.entries()].map(([id, name]) => ({
      id, name, isMaster: id === session.masterId
    }))
  };
}

function broadcast(code) {
  const s = sessions.get(code);
  if (!s) return;
  io.to(code).emit('state', publicState(s));
}

/* ------------------------------------------------------------------ */
/* Logica di gioco                                                     */
/* ------------------------------------------------------------------ */

function pickCandidates(session) {
  const exclude = new Set();
  if (session.current) exclude.add(session.current.id);
  const pool = session.playlist.filter(t => !exclude.has(t.id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const n = Math.min(session.candidatesCount, pool.length);
  return pool.slice(0, n).map(t => t.id);
}

function pickWinner(session) {
  if (session.candidates.length === 0) return null;
  let max = -1;
  let tied = [];
  for (const id of session.candidates) {
    const votes = (session.votes.get(id) || new Set()).size;
    if (votes > max) { max = votes; tied = [id]; }
    else if (votes === max) tied.push(id);
  }
  return tied[Math.floor(Math.random() * tied.length)];
}

function stopTimer(session) {
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
}

// offsetMs: da dove far partire la canzone (0 = dall'inizio)
function startTrack(session, trackId, offsetMs = 0) {
  const track = session.playlist.find(t => t.id === trackId);
  if (!track) return;
  stopTimer(session);

  const isSameTrack = session.current && session.current.id === trackId;

  session.current = track;
  session.isPlaying = true;
  session.startedAt = Date.now() - offsetMs;   // startedAt "spostato" indietro
  session.pausedElapsed = offsetMs;

  // rigenera i candidati solo se è una traccia diversa (o lista vuota)
  if (!isSameTrack || session.candidates.length === 0) {
    session.candidates = pickCandidates(session);
    session.votes = new Map();
  }

  const dur = Math.max(5, Number(track.duration) || 30) * 1000;
  const remaining = Math.max(1000, dur - offsetMs);
  session.timer = setTimeout(() => advance(session.code), remaining);
  broadcast(session.code);
}

function advance(code) {
  const session = sessions.get(code);
  if (!session || !session.isPlaying) return;

  const winner = pickWinner(session);
  if (winner) return startTrack(session, winner, 0);

  const others = session.playlist.filter(t => t.id !== session.current?.id);
  if (others.length === 0) {
    session.isPlaying = false;
    broadcast(code);
    return;
  }
  const r = others[Math.floor(Math.random() * others.length)];
  startTrack(session, r.id, 0);
}

/* ------------------------------------------------------------------ */
/* Socket handlers                                                     */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {

  socket.on('session:create', ({ name } = {}, cb) => {
    const masterName = (name || 'Master').toString().trim().slice(0, 24) || 'Master';
    const code = genCode();
    const session = {
      code,
      masterId: socket.id,
      masterName,
      playlist: [],
      current: null,
      isPlaying: false,
      startedAt: null,
      pausedElapsed: 0,
      candidates: [],
      candidatesCount: 5,
      votes: new Map(),
      users: new Map([[socket.id, masterName]]),
      timer: null
    };
    sessions.set(code, session);
    socketInfo.set(socket.id, { code, role: 'master' });
    socket.join(code);
    cb?.({ ok: true, code });
    broadcast(code);
  });

  socket.on('session:join', ({ code, name } = {}, cb) => {
    const c = (code || '').toString().trim().toUpperCase();
    const session = sessions.get(c);
    if (!session) return cb?.({ ok: false, error: 'Sessione non trovata' });
    const userName = (name || 'Ospite').toString().trim().slice(0, 24) || 'Ospite';
    session.users.set(socket.id, userName);
    socketInfo.set(socket.id, { code: c, role: 'listener' });
    socket.join(c);
    cb?.({ ok: true, code: c });
    broadcast(c);
  });

  socket.on('master:setPlaylist', ({ tracks } = {}, cb) => {
    const session = getSession(socket);
    if (!isMaster(socket, session))
      return cb?.({ ok: false, error: 'Solo il master può modificare la playlist' });

    const list = Array.isArray(tracks) ? tracks : [];
    session.playlist = list.map(t => ({
      id: 't' + (++trackCounter),
      title: (t.title || 'Senza titolo').toString().slice(0, 120),
      artist: (t.artist || '').toString().slice(0, 120),
      duration: Math.max(5, Math.min(3600, Number(t.duration) || 30))
    }));
    stopTimer(session);
    session.current = null;
    session.isPlaying = false;
    session.startedAt = null;
    session.pausedElapsed = 0;
    session.candidates = [];
    session.votes = new Map();
    cb?.({ ok: true, count: session.playlist.length });
    broadcast(session.code);
  });

  socket.on('master:setCandidateCount', ({ count } = {}) => {
    const session = getSession(socket);
    if (!isMaster(socket, session)) return;
    session.candidatesCount = Math.max(1, Math.min(20, Number(count) || 5));
    broadcast(session.code);
  });

  socket.on('master:playTrack', ({ trackId, random } = {}) => {
    const session = getSession(socket);
    if (!isMaster(socket, session)) return;
    if (session.playlist.length === 0) return;
    let id = trackId;
    if (random || !id) {
      id = session.playlist[Math.floor(Math.random() * session.playlist.length)].id;
    }
    // se sto ripremendo la stessa traccia in pausa -> riprendi da dov'era
    const offset = (session.current && session.current.id === id && !session.isPlaying)
      ? (session.pausedElapsed || 0) : 0;
    startTrack(session, id, offset);
  });

  socket.on('master:skip', () => {
    const session = getSession(socket);
    if (!isMaster(socket, session)) return;
    advance(session.code);
  });

  // Blocca: salva la posizione corrente e ferma il timer
  socket.on('master:block', () => {
    const session = getSession(socket);
    if (!isMaster(socket, session)) return;
    if (!session.isPlaying || !session.startedAt) return;
    session.pausedElapsed = Date.now() - session.startedAt;
    stopTimer(session);
    session.isPlaying = false;
    broadcast(session.code);
  });

  // Riprendi: fa ripartire la traccia corrente dalla posizione salvata
  socket.on('master:resume', () => {
    const session = getSession(socket);
    if (!isMaster(socket, session)) return;
    if (session.isPlaying || !session.current) return;
    startTrack(session, session.current.id, session.pausedElapsed || 0);
  });

  // Il master ora può votare (nessun check di ruolo)
  socket.on('vote', ({ trackId } = {}) => {
    const session = getSession(socket);
    if (!session) return;
    if (!session.candidates.includes(trackId)) return;

    const alreadyVoted = session.votes.get(trackId)?.has(socket.id);
    for (const set of session.votes.values()) set.delete(socket.id);
    if (!alreadyVoted) {
      if (!session.votes.has(trackId)) session.votes.set(trackId, new Set());
      session.votes.get(trackId).add(socket.id);
    }
    broadcast(session.code);
  });

  socket.on('disconnect', () => {
    const info = socketInfo.get(socket.id);
    socketInfo.delete(socket.id);
    if (!info) return;
    const session = sessions.get(info.code);
    if (!session) return;

    session.users.delete(socket.id);
    for (const set of session.votes.values()) set.delete(socket.id);

    if (session.masterId === socket.id) {
      stopTimer(session);
      io.to(session.code).emit('session:closed', { reason: 'Il master ha chiuso la sessione' });
      sessions.delete(session.code);
    } else {
      broadcast(session.code);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`🎧 MusicSest beta in ascolto su http://localhost:${PORT}`);
});