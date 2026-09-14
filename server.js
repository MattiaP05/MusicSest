import crypto from 'crypto';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import cookieParser from 'cookie-parser';
import { Session } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || '';
const SPOTIFY_SCOPES = 'playlist-read-private playlist-read-collaborative streaming user-read-private user-read-email user-modify-playback-state user-read-playback-state';

function resolveSpotifyRedirectUri(req) {
  const host = req.headers.host || '127.0.0.1:3000';
  return `http://${host}/spotify/callback`;
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const socketInfo = new Map();
let trackCounter = 0;
const nextTrackId = () => 't' + (++trackCounter);

function buildSpotifyAuthorizeUrl(req, state) {
  const redirectUri = resolveSpotifyRedirectUri(req);
  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES,
    state,
    show_dialog: 'true'
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function spotifyFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    let errorMessage = 'Errore Spotify';
    try {
      const body = JSON.parse(text);
      errorMessage = body?.error?.message || errorMessage;
    } catch {
      // noop
    }
    const error = new Error(errorMessage);
    error.status = response.status;
    throw error;
  }

  return text ? JSON.parse(text) : null;
}

function genCode() {
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

function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function getSpotifyTokenFromSocket(socket) {
  return getCookieValue(socket.request?.headers?.cookie || '', 'spotify_access_token');
}

async function pauseSpotifyPlayback(socket) {
  const token = getSpotifyTokenFromSocket(socket);
  if (!token) return false;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });
    return response.status === 204 || response.ok;
  } catch (err) {
    console.error('Spotify pause error:', err);
    return false;
  }
}

async function resumeSpotifyPlayback(socket, positionMs = 0) {
  const token = getSpotifyTokenFromSocket(socket);
  if (!token) return false;

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ position_ms: Math.max(0, Math.floor(positionMs)) })
    });
    return response.status === 204 || response.ok;
  } catch (err) {
    console.error('Spotify resume error:', err);
    return false;
  }
}

app.get('/spotify/login', (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(500).send('Configura SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET prima di usare Spotify.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = resolveSpotifyRedirectUri(req);
  res.cookie('spotify_state', state, { httpOnly: true, sameSite: 'lax', path: '/' });
  console.log('Spotify login redirect URI:', redirectUri);
  res.redirect(buildSpotifyAuthorizeUrl(req, state));
});

app.get('/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.cookies?.spotify_state;
  const redirectUri = resolveSpotifyRedirectUri(req);

  if (error) return res.status(400).send(`Spotify rejected the request: ${error}`);
  if (!code || !state || state !== expectedState) {
    console.error('Spotify callback mismatch:', {
      host: req.headers.host,
      redirectUri,
      receivedState: state || null,
      expectedState: expectedState || null,
      cookieNames: req.headers.cookie ? Object.keys(Object.fromEntries(new URLSearchParams(req.headers.cookie.split('; ').join('&')))) : []
    });
    return res.status(400).send('Invalid Spotify callback state.');
  }

  try {
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData?.error_description || 'Spotify token error');
    }

    res.cookie('spotify_access_token', tokenData.access_token, { httpOnly: true, sameSite: 'lax' });
    if (tokenData.refresh_token) {
      res.cookie('spotify_refresh_token', tokenData.refresh_token, { httpOnly: true, sameSite: 'lax' });
    }
    res.clearCookie('spotify_state');
    res.redirect('/?spotify=connected');
  } catch (err) {
    console.error('Spotify callback error:', err);
    res.status(500).send(`Errore durante la connessione a Spotify: ${err.message}`);
  }
});

app.get('/api/spotify/me', async (req, res) => {
  const token = req.cookies?.spotify_access_token;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Spotify not connected' });
  }

  try {
    const profile = await spotifyFetch('https://api.spotify.com/v1/me', token);
    res.json({ ok: true, profile });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/spotify/playlists', async (req, res) => {
  const token = req.cookies?.spotify_access_token;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Spotify not connected' });
  }

  try {
    const data = await spotifyFetch('https://api.spotify.com/v1/me/playlists?limit=50', token);
    res.json({
      ok: true,
      playlists: (data?.items || []).map(item => ({
        id: item.id,
        name: item.name,
        tracks: item.tracks?.total || 0,
        image: item.images?.[0]?.url || null,
        uri: item.uri
      }))
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/spotify/playlists/:playlistId/tracks', async (req, res) => {
  const token = req.cookies?.spotify_access_token;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Spotify not connected' });
  }

  try {
    const data = await spotifyFetch(`https://api.spotify.com/v1/playlists/${req.params.playlistId}/tracks?limit=100`, token);
    const tracks = (data?.items || [])
      .map(item => item.track)
      .filter(Boolean)
      .map(track => ({
        id: track.id,
        title: track.name,
        artist: (track.artists || []).map(a => a.name).join(', '),
        duration: Math.max(5, Math.round((track.duration_ms || 30000) / 1000)),
        uri: track.uri
      }));

    res.json({ ok: true, tracks });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/spotify/play', async (req, res) => {
  const token = req.cookies?.spotify_access_token;
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Spotify not connected' });
  }

  const { uri } = req.body || {};
  if (!uri) {
    return res.status(400).json({ ok: false, error: 'URI della traccia richiesta' });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uris: [uri] })
    });

    if (response.status === 204) {
      return res.json({ ok: true });
    }

    const text = await response.text();
    let message = 'Impossibile avviare la riproduzione su Spotify';
    try {
      message = JSON.parse(text)?.error?.message || message;
    } catch {
      // noop
    }
    return res.status(response.status).json({ ok: false, error: message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/spotify/logout', (req, res) => {
  res.clearCookie('spotify_access_token');
  res.clearCookie('spotify_refresh_token');
  res.json({ ok: true });
});

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

  socket.on('master:block', async () => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;

    session.block();
    await pauseSpotifyPlayback(socket);
    session.broadcast();
  });

  socket.on('master:resume', async () => {
    const session = getSession(socket);
    if (!session || !session.isMaster(socket)) return;

    session.resume();
    await resumeSpotifyPlayback(socket, session.pausedElapsed || 0);
    session.broadcast();
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
  console.log(`🎧 MusicSest beta in ascolto su http://127.0.0.1:${PORT}`);
});