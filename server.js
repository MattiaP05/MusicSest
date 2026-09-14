import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { Session } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const socketInfo = new Map();
let trackCounter = 0;
const nextTrackId = () => 't' + (++trackCounter);

function genCode() {//Genera un codice sessione di 5 caratteri dal alfabetto CODE_CHARS
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (sessions.has(code));
  return code;
}


function getSession(socket) {
  const info = socketInfo.get(socket.id);
  if (!info) return null;
  return sessions.get(info.code) || null;
}

/* Socket handlers                                                     */

io.on('connection', (socket) => {

  socket.on('session:create', ({ name } = {}, cb) => {
    const masterName = (name || 'Master').toString().trim().slice(0, 24) || 'Master';
    const code = genCode();
    const session = new Session(code, socket.id, masterName, io);
    sessions.set(code, session);
    socketInfo.set(socket.id, { code, role: 'master' });
    socket.join(code);
    cb?.({ ok: true, code });
    session.broadcast();
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
    session.broadcast();
  });

  socket.on('master:setPlaylist', ({ tracks } = {}, cb) => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket))
      return cb?.({ ok: false, error: 'Solo il master può modificare la playlist' });

    session.setPlaylist(Array.isArray(tracks) ? tracks : [], nextTrackId);
    cb?.({ ok: true, count: session.playlist.length });
    session.broadcast();
  });

  socket.on('master:setCandidateCount', ({ count } = {}) => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;

    session.setCandidateCount(count);
    session.broadcast();
  });

  socket.on('master:playTrack', ({ trackId, random } = {}) => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;
    if (session.playlist.length === 0) return;

    let id = trackId;
    if (random || !id) {
      id = session.playlist[Math.floor(Math.random() * session.playlist.length)].id;
    }
    const offset = (session.current && session.current.id === id && !session.isPlaying)
      ? (session.pausedElapsed || 0) : 0;
    session.startTrack(id, offset);
  });

  socket.on('master:skip', () => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;

    session.advance();
  });

  socket.on('master:block', () => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;

    session.block();
    session.broadcast();
  });

  socket.on('master:resume', () => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;

    session.resume();
  });

  socket.on('vote', ({ trackId } = {}) => {
    const session = getSession(socket);
    if (!session) return;

    session.vote(socket.id, trackId);
    session.broadcast();
  });

  socket.on('disconnect', () => {
    const info = socketInfo.get(socket.id);
    socketInfo.delete(socket.id);
    if (!info) return;

    const session = sessions.get(info.code);
    if (!session) return;

    session.removeUser(socket.id);

    if (session.isMaster(socket)) {
      session.close();
      io.to(session.code).emit('session:closed', { reason: 'Il master ha chiuso la sessione' });
      sessions.delete(session.code);
    } else {
      session.broadcast();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`🎧 MusicSest beta in ascolto su http://localhost:${PORT}`);
});