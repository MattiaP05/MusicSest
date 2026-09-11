/* global io */
const socket = io();
const app = document.getElementById('app');

const state = {
  session: null,
  closed: null,
  error: null,
  name: '',
  joinCode: '',
  playlistText: '',
  showImport: false,
  candidateCount: 5,
  playlistSearch: ''    // <-- nuovo: filtro playlist
};

/* ---------------- helpers ---------------- */

const el = (id) => document.getElementById(id);
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const isMaster = () => state.session && state.session.masterId === socket.id;

/* ---------------- socket ---------------- */

socket.on('state', (s) => {
  state.session = s;
  state.closed = null;
  if (s.candidatesCount) state.candidateCount = s.candidatesCount;
  render();
});

socket.on('session:closed', ({ reason }) => {
  state.closed = reason || 'Sessione chiusa';
  state.session = null;
  render();
});

/* ---------------- render ---------------- */

function render() {
  if (state.closed) return renderClosed();
  if (!state.session) return renderHome();
  if (isMaster()) return renderMaster();
  return renderListener();
}

/* ---------- HOME ---------- */

function renderHome() {
  app.innerHTML = `
    <div class="card" style="max-width:460px;margin:60px auto;">
      <h1>🎧 MusicSest <span class="beta">beta</span></h1>
      <p class="sub">Il pubblico vota la prossima canzone. Tu decidi quando cambiare.</p>

      <label>Il tuo nome</label>
      <input id="nameInput" value="${escapeHtml(state.name)}" placeholder="Es. Luca" maxlength="24" />

      <button id="createBtn" class="primary">Crea sessione (Master)</button>

      <hr />

      <label>Codice sessione</label>
      <input id="joinCodeInput" value="${escapeHtml(state.joinCode)}" placeholder="Es. AB3XY"
             maxlength="5" style="text-transform:uppercase;letter-spacing:.2em;font-weight:700;" />
      <button id="joinBtn" class="blue">Unisciti come ospite</button>

      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
    </div>
  `;

  el('nameInput').addEventListener('input', e => state.name = e.target.value);
  el('joinCodeInput').addEventListener('input', e => state.joinCode = e.target.value.toUpperCase());

  el('createBtn').addEventListener('click', () => {
    state.error = null;
    socket.emit('session:create', { name: state.name }, (res) => {
      if (!res?.ok) { state.error = res?.error || 'Errore'; render(); }
    });
  });

  el('joinBtn').addEventListener('click', () => {
    state.error = null;
    socket.emit('session:join', { code: state.joinCode, name: state.name }, (res) => {
      if (!res?.ok) { state.error = res?.error || 'Errore'; render(); }
    });
  });
}

/* ---------- CLOSED ---------- */

function renderClosed() {
  app.innerHTML = `
    <div class="card" style="max-width:460px;margin:60px auto;text-align:center;">
      <h1>Sessione terminata</h1>
      <p class="sub">${escapeHtml(state.closed)}</p>
      <button class="primary" id="homeBtn">Torna alla home</button>
    </div>
  `;
  el('homeBtn').addEventListener('click', () => {
    state.closed = null;
    render();
  });
}

/* ---------- MASTER ---------- */

function renderMaster() {
  const s = state.session;
  const showResume = !s.isPlaying && !!s.current;

  app.innerHTML = `
    <div class="topbar">
      <div>
        <div class="label">Codice sessione</div>
        <div class="code">${escapeHtml(s.code)}</div>
      </div>
      <div class="topbar-actions">
        <button id="copyBtn">🔗 Copia link</button>
        <button id="leaveBtn" class="ghost">Esci</button>
      </div>
    </div>

    <div class="card">
      <h2>👥 Partecipanti (${s.users.length})</h2>
      <div class="users">
        ${s.users.map(u => `<span class="user ${u.isMaster ? 'master' : ''}">${escapeHtml(u.name)}${u.isMaster ? ' · master' : ''}</span>`).join('')}
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>▶️ In riproduzione</h2>
        ${renderNowPlaying(s)}
        <div class="controls">
          <button id="playRandomBtn">🎲 Avvia casuale</button>
          ${showResume ? `<button id="resumeBtn" class="primary" style="margin-top:0;">▶️ Riprendi</button>` : ''}
          <button id="skipBtn" ${s.playlist.length === 0 ? 'disabled' : ''}>⏭️ Skip</button>
          <button id="blockBtn" class="danger" ${(!s.current || !s.isPlaying) ? 'disabled' : ''}>⏹️ Blocca</button>
        </div>
      </div>

      <div class="card">
        <h2>🗳️ Prossima canzone (${s.candidates.length})</h2>
        ${renderCandidates(s, true)}
      </div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <h2 style="margin:0">📃 Playlist (${s.playlist.length} brani)</h2>
        <div style="display:flex;gap:8px;">
          <label style="margin:0;display:flex;align-items:center;gap:6px;text-transform:none;">
            Candidati:
            <select id="candidateSelect" style="width:auto;padding:6px 8px;">
              ${[3,5,7,10,15].map(n => `<option value="${n}" ${n === s.candidatesCount ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </label>
          <button id="toggleImportBtn" class="ghost">${state.showImport ? 'Chiudi' : 'Importa'}</button>
        </div>
      </div>
      ${state.showImport ? `
        <div style="margin-top:12px;">${renderImport()}</div>
      ` : `
        <input id="playlistSearch" placeholder="🔍 Cerca nella playlist..."
               value="${escapeHtml(state.playlistSearch)}" style="margin-top:12px;" />
        <div id="playlistList" style="margin-top:12px;">${renderPlaylist(s)}</div>
      `}
    </div>
  `;

  attachMasterEvents();
}

function renderNowPlaying(s) {
  if (!s.current) return `<p class="muted">Nessuna canzone in riproduzione. Avviane una dalla playlist o in modo casuale.</p>`;

  const dur = Math.max(5, s.current.duration || 30) * 1000;
  let elapsed = 0;
  if (s.isPlaying && s.startedAt) {
    elapsed = Date.now() - s.startedAt;
  } else if (s.pausedElapsed != null) {
    elapsed = s.pausedElapsed;
  }
  const pct = Math.max(0, Math.min(100, (elapsed / dur) * 100));
  const remaining = Math.max(0, Math.ceil((dur - elapsed) / 1000));

  return `
    <div>
      <div class="track-title">${escapeHtml(s.current.title)}</div>
      <div class="track-artist">${escapeHtml(s.current.artist || 'Artista sconosciuto')}</div>
    </div>
    <div class="progress">
      <div class="progress-bar" id="progressBar" style="width:${pct.toFixed(2)}%"></div>
    </div>
    <div class="muted small">
      <span id="timeLeft">${remaining}s</span> · ${s.isPlaying ? 'in riproduzione' : 'in pausa'}
    </div>
  `;
}

function renderCandidates(s, votable) {
  if (s.candidates.length === 0) {
    return `<p class="muted">Nessun candidato al momento. Avvia una canzone per generarne la lista.</p>`;
  }
  return s.candidates.map(c => {
    const iVoted = c.voters.includes(socket.id);
    return `
      <div class="candidate ${iVoted ? 'voted' : ''}">
        <div class="candidate-info">
          <div class="track-title">${escapeHtml(c.title)}</div>
          <div class="track-artist">${escapeHtml(c.artist || '')}</div>
        </div>
        ${votable
          ? `<button class="${iVoted ? '' : 'ghost'}" data-vote="${c.id}">${iVoted ? '✓ Votata' : 'Vota'}</button>`
          : ''}
        <span class="votes">${c.voters.length}</span>
      </div>
    `;
  }).join('');
}

function renderPlaylist(s) {
  if (s.playlist.length === 0) return `<p class="muted">Playlist vuota. Clicca "Importa" per aggiungere i brani.</p>`;

  const q = state.playlistSearch.trim().toLowerCase();
  const filtered = q
    ? s.playlist.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q))
    : s.playlist;

  if (filtered.length === 0) {
    return `<p class="muted">Nessun risultato per "${escapeHtml(state.playlistSearch)}".</p>`;
  }

  return filtered.map(t => `
    <div class="playlist-item">
      <div class="candidate-info">
        <div class="track-title">${escapeHtml(t.title)}</div>
        <div class="track-artist">${escapeHtml(t.artist || '')} · ${t.duration}s</div>
      </div>
      <button data-play="${t.id}">▶️</button>
    </div>
  `).join('');
}

function renderImport() {
  return `
    <p class="muted small">
      Una canzone per riga. Formato: <code>Titolo - Artista | durata_sec</code> (durata opzionale, default 30s).
    </p>
    <textarea id="playlistText" placeholder="Bohemian Rhapsody - Queen | 355
Blinding Lights - The Weeknd | 200
Levitating - Dua Lipa">${escapeHtml(state.playlistText)}</textarea>
    <div class="controls">
      <button id="demoBtn" class="ghost">Carica esempio</button>
      <button id="importBtn" class="blue" style="margin-top:0;">Importa playlist</button>
    </div>
  `;
}

// Aggiorna SOLO la lista playlist (evita di perdere il focus dell'input di ricerca)
function refreshPlaylistList() {
  const container = el('playlistList');
  if (!container || !state.session) return;
  container.innerHTML = renderPlaylist(state.session);
  container.querySelectorAll('[data-play]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('master:playTrack', { trackId: btn.dataset.play });
    });
  });
}

function attachMasterEvents() {
  const s = state.session;

  el('copyBtn')?.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?join=${s.code}`;
    try { await navigator.clipboard.writeText(url); el('copyBtn').textContent = '✓ Copiato'; }
    catch { prompt('Copia il link:', url); }
    setTimeout(() => { const b = el('copyBtn'); if (b) b.textContent = '🔗 Copia link'; }, 1500);
  });

  el('leaveBtn')?.addEventListener('click', () => location.reload());

  el('playRandomBtn')?.addEventListener('click', () => {
    if (s.playlist.length === 0) { state.showImport = true; render(); return; }
    socket.emit('master:playTrack', { random: true });
  });

  el('resumeBtn')?.addEventListener('click', () => socket.emit('master:resume'));
  el('skipBtn')?.addEventListener('click', () => socket.emit('master:skip'));
  el('blockBtn')?.addEventListener('click', () => socket.emit('master:block'));

  el('candidateSelect')?.addEventListener('change', (e) => {
    socket.emit('master:setCandidateCount', { count: Number(e.target.value) });
  });

  el('toggleImportBtn')?.addEventListener('click', () => {
    state.showImport = !state.showImport;
    render();
  });

  el('demoBtn')?.addEventListener('click', () => {
    state.playlistText = `Bohemian Rhapsody - Queen | 355
Blinding Lights - The Weeknd | 200
Levitating - Dua Lipa | 203
Don't Stop Me Now - Queen | 209
Take On Me - a-ha | 225
Africa - Toto | 295
Mr. Brightside - The Killers | 222
Rolling in the Deep - Adele | 228
Somebody That I Used to Know - Gotye | 244
Uptown Funk - Mark Ronson | 270`;
    render();
  });

  el('playlistText')?.addEventListener('input', e => state.playlistText = e.target.value);

  el('importBtn')?.addEventListener('click', () => {
    const tracks = parsePlaylist(state.playlistText);
    if (tracks.length === 0) return;
    socket.emit('master:setPlaylist', { tracks }, (res) => {
      if (res?.ok) {
        state.showImport = false;
        state.playlistSearch = '';
        render();
      }
    });
  });

  // ricerca playlist (aggiorna solo il contenitore, non l'intera pagina)
  el('playlistSearch')?.addEventListener('input', (e) => {
    state.playlistSearch = e.target.value;
    refreshPlaylistList();
  });

  document.querySelectorAll('[data-play]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('master:playTrack', { trackId: btn.dataset.play });
    });
  });

  // Il master ora vota come tutti gli altri
  document.querySelectorAll('[data-vote]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('vote', { trackId: btn.dataset.vote });
    });
  });
}

/* ---------- LISTENER ---------- */

function renderListener() {
  const s = state.session;

  app.innerHTML = `
    <div class="topbar">
      <div>
        <div class="label">Sessione</div>
        <div class="code">${escapeHtml(s.code)}</div>
      </div>
      <div class="topbar-actions">
        <span class="user master">Master: ${escapeHtml(s.masterName)}</span>
        <button id="leaveBtn" class="ghost">Esci</button>
      </div>
    </div>

    <div class="card">
      <h2>▶️ In riproduzione</h2>
      ${renderNowPlaying(s)}
    </div>

    <div class="card">
      <h2>🗳️ Vota la prossima canzone</h2>
      ${renderCandidates(s, true)}
    </div>

    <div class="card">
      <h2>👥 Partecipanti (${s.users.length})</h2>
      <div class="users">
        ${s.users.map(u => `<span class="user ${u.isMaster ? 'master' : ''}">${escapeHtml(u.name)}</span>`).join('')}
      </div>
    </div>
  `;

  el('leaveBtn')?.addEventListener('click', () => location.reload());

  document.querySelectorAll('[data-vote]').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('vote', { trackId: btn.dataset.vote });
    });
  });
}

/* ---------- parsing playlist ---------- */

function parsePlaylist(text) {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [mainRaw, durRaw] = line.split('|').map(x => (x || '').trim());
      const duration = durRaw ? parseInt(durRaw, 10) : 30;
      let title = mainRaw;
      let artist = '';
      const idx = mainRaw.lastIndexOf(' - ');
      if (idx > 0) {
        title = mainRaw.slice(0, idx).trim();
        artist = mainRaw.slice(idx + 3).trim();
      }
      return { title, artist, duration: Number.isFinite(duration) ? duration : 30 };
    });
}

/* ---------- ticker progress bar ---------- */

setInterval(() => {
  const bar = el('progressBar');
  const timeEl = el('timeLeft');
  const s = state.session;
  if (!bar || !s || !s.current) return;

  const dur = Math.max(5, s.current.duration || 30) * 1000;
  let elapsed;
  if (s.isPlaying && s.startedAt) {
    elapsed = Date.now() - s.startedAt;
  } else if (s.pausedElapsed != null) {
    elapsed = s.pausedElapsed;
  } else {
    return;
  }

  const pct = Math.max(0, Math.min(100, (elapsed / dur) * 100));
  bar.style.width = pct + '%';
  if (timeEl) timeEl.textContent = Math.max(0, Math.ceil((dur - elapsed) / 1000)) + 's';
}, 250);

/* ---------- URL ?join=XXXXX ---------- */

const params = new URLSearchParams(location.search);
const joinParam = params.get('join');
if (joinParam) state.joinCode = joinParam.toUpperCase();

render();