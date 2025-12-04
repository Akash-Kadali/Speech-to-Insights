/**
 * sessions.js — Final upgraded
 * - Robust session list + detail UI
 * - Defensive fetches with timeout, graceful fallbacks
 * - Clickable transcript lines that deep-link by time
 * - Emits CustomEvents and exposes stable API on window.sti.sessions
 * - Test hooks: setFetch, setAbortController
 */
(function () {
  'use strict';

  // ---------- Namespace & config ----------
  const sti = window.sti || (window.sti = {});
  sti.sessions = sti.sessions || {};
  const api = sti.sessions;

  const DEFAULT_CFG = {
    SESSIONS_ENDPOINT:
      (window.STI && window.STI.SESSIONS_ENDPOINT) ||
      window.STI_SESSIONS_ENDPOINT ||
      '/sessions',
    FETCH_TIMEOUT_MS: (window.STI && window.STI.FETCH_TIMEOUT_MS) || 3000,
    DEFAULT_PREVIEW_LIMIT: (window.STI && window.STI.SESSIONS_PREVIEW_LIMIT) || 10,
    SELECTORS: {
      list: '#sessions-list, #recent-sessions, #sessions-table-body',
      detail: '#session-detail, #session-transcript, #session-view'
    }
  };

  // normalize endpoint (support array or string)
  const SESSIONS_ENDPOINT = Array.isArray(DEFAULT_CFG.SESSIONS_ENDPOINT)
    ? DEFAULT_CFG.SESSIONS_ENDPOINT[0]
    : DEFAULT_CFG.SESSIONS_ENDPOINT;

  api._config = Object.assign({}, DEFAULT_CFG, { SESSIONS_ENDPOINT });

  // Test / override hooks (useful for unit tests)
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  // ---------- Utilities ----------
  const _log = (...args) => { if (typeof console !== 'undefined') console.debug('sti.sessions:', ...args); };
  const _toast = (msg, t) => {
    try { if (typeof window.showToast === 'function') return window.showToast(msg, t); } catch (e) {}
    if (typeof console !== 'undefined') console.info('TOAST:', msg);
  };

  function _safeParseJson(text) {
    if (text === undefined || text === null) return null;
    if (typeof text === 'object') return text;
    try { return JSON.parse(String(text)); } catch (_) { return null; }
  }

  // fetch wrapper with timeout and safe parsing
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = api._config.FETCH_TIMEOUT_MS) {
    if (!url) throw new Error('fetchJsonWithTimeout: missing url');
    const fetchFn = api._fetchOverride || window.fetch;
    if (typeof fetchFn !== 'function') throw new Error('fetch not available');

    const AbortCtor = api._AbortControllerOverride || window.AbortController;
    const controller = AbortCtor ? new AbortCtor() : null;
    const merged = Object.assign({}, opts, { credentials: opts.credentials || 'same-origin' });
    if (controller) merged.signal = controller.signal;

    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const res = await fetchFn(url, merged);
      const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const parsedErr = _safeParseJson(txt);
        const err = new Error(`Network response not ok: ${res.status}`);
        err.status = res.status;
        err.body = parsedErr !== null ? parsedErr : txt;
        throw err;
      }
      const parsed = _safeParseJson(txt);
      if (parsed !== null) return parsed;
      // try JSONL first non-empty line
      const first = (txt || '').split(/\r?\n/).find(Boolean) || '';
      const firstParsed = _safeParseJson(first);
      if (firstParsed !== null) return firstParsed;
      return txt;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error('Request timed out/aborted');
        e.code = 'ABORT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- Normalization helpers ----------
  function _normalizeSessionsList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.sessions)) return payload.sessions;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    // take first array property if present
    const keys = Object.keys(payload || {});
    for (let i = 0; i < keys.length; i++) {
      const v = payload[keys[i]];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  // ---------- Fetching ----------
  async function fetchSessions() {
    try {
      const res = await fetchJsonWithTimeout(api._config.SESSIONS_ENDPOINT, { method: 'GET' }, api._config.FETCH_TIMEOUT_MS);
      const arr = _normalizeSessionsList(res);
      return arr;
    } catch (err) {
      _log('fetchSessions failed', err && err.message ? err.message : err);
      return null;
    }
  }

  async function fetchSession(id) {
    if (!id) return null;
    try {
      const safeId = encodeURIComponent(String(id));
      // support endpoints like /sessions and /sessions/{id}
      const base = api._config.SESSIONS_ENDPOINT.replace(/\/+$/, '');
      const url = `${base}/${safeId}`;
      const res = await fetchJsonWithTimeout(url, { method: 'GET' }, api._config.FETCH_TIMEOUT_MS);
      return res || null;
    } catch (err) {
      _log('fetchSession failed', err && err.message ? err.message : err);
      return null;
    }
  }

  // ---------- DOM helpers ----------
  function _queryListElement() {
    const sel = api._config.SELECTORS.list;
    if (!sel) return null;
    return document.querySelector(sel);
  }
  function _queryDetailElement() {
    const sel = api._config.SELECTORS.detail;
    if (!sel) return null;
    return document.querySelector(sel);
  }

  function _makeMuted(text) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = String(text || '');
    li.setAttribute('aria-live', 'polite');
    return li;
  }

  function _makeAnchorForSession(id, text) {
    const a = document.createElement('a');
    a.textContent = String(text || id || 'Session');
    try { a.href = '/sessions.html#' + encodeURIComponent(id || ''); } catch (_) { a.href = '#'; }
    a.setAttribute('aria-label', a.textContent);
    return a;
  }

  // ---------- Rendering: list ----------
  function renderList(container, sessions, opts = {}) {
    if (!container) return;
    container.innerHTML = '';
    const arr = Array.isArray(sessions) ? sessions : [];
    if (!arr.length) {
      container.appendChild(_makeMuted('No sessions found'));
      return;
    }

    const frag = document.createDocumentFragment();
    arr.forEach(s => {
      try {
        const li = document.createElement('li');
        li.className = 'session-item';
        li.setAttribute('role', 'listitem');

        const sid = s && (s.id || s.session_id || s.upload_id || s.key || s.name) || '';
        const titleText = (s && (s.title || s.name)) || sid || 'Session';
        const a = _makeAnchorForSession(sid, titleText);
        a.className = 'session-link';
        li.appendChild(a);

        const meta = document.createElement('div');
        meta.className = 'session-meta muted small';
        const parts = [];
        if (s && (s.status || s.state)) parts.push(String(s.status || s.state));
        const dur = (s && s.meta && s.meta.duration) || (s && (s.duration || s.length));
        if (dur != null && !Number.isNaN(Number(dur))) parts.push(Math.round(Number(dur)) + 's');
        meta.textContent = parts.join(' • ');
        li.appendChild(meta);

        // keyboard accessibility: allow Enter to follow link
        li.tabIndex = 0;
        li.addEventListener('keypress', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            a.click();
          }
        }, { passive: true });

        frag.appendChild(li);
      } catch (err) {
        _log('renderList item error', err);
      }
    });

    container.appendChild(frag);
    container.setAttribute('aria-busy', 'false');
    container.dispatchEvent(new CustomEvent('sti:sessions:list:rendered', { detail: { count: arr.length } }));
  }

  // ---------- Rendering: session detail / transcript ----------
  function _createTimeAnchor(seconds, sessionId) {
    const sec = Number(seconds) || 0;
    const a = document.createElement('a');
    a.className = 'time-anchor';
    a.href = `#t=${Math.round(sec)}`;
    a.setAttribute('aria-label', `Jump to ${Math.round(sec)} seconds`);
    a.textContent = `[${Math.round(sec)}s]`;
    a.addEventListener('click', (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      try {
        const base = '/sessions.html';
        if (sessionId) window.location.href = `${base}#${encodeURIComponent(sessionId)}?t=${encodeURIComponent(Math.round(sec))}`;
        else window.location.hash = `t=${encodeURIComponent(Math.round(sec))}`;
      } catch (e) {
        try { window.location.hash = `t=${Math.round(sec)}`; } catch (_) {}
      }
    }, { passive: true });
    return a;
  }

  function renderSessionDetail(container, session) {
    if (!container) return;
    container.innerHTML = '';

    if (!session) {
      container.appendChild(_makeMuted('Session not found'));
      return;
    }

    // Title & meta
    const title = document.createElement('h2');
    title.className = 'session-title';
    title.textContent = session.title || session.id || session.session_id || 'Session';
    container.appendChild(title);

    const info = document.createElement('div');
    info.className = 'muted small session-info';
    const state = session.status || session.state || 'unknown';
    const dur = (session.meta && session.meta.duration) || session.duration;
    info.textContent = `Status: ${state}` + (dur != null && !Number.isNaN(Number(dur)) ? ` • duration: ${Math.round(Number(dur))}s` : '');
    container.appendChild(info);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'session-actions';
    if (session.s3_uri || session.s3 || session.storage_uri) {
      const dl = document.createElement('a');
      dl.className = 'btn muted small';
      dl.textContent = 'Download raw';
      dl.href = session.s3_uri || session.s3 || session.storage_uri;
      dl.target = '_blank';
      actions.appendChild(dl);
    }
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn small';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', async () => {
      try {
        const reloaded = await fetchSession(session.id || session.session_id || session.upload_id);
        if (reloaded) renderSessionDetail(container, reloaded);
        else _toast('Refresh failed');
      } catch (err) {
        _toast('Refresh failed');
      }
    }, { passive: true });
    actions.appendChild(refreshBtn);
    container.appendChild(actions);

    // Transcript / structured lines
    const transcriptWrap = document.createElement('div');
    transcriptWrap.className = 'transcript-wrap';
    transcriptWrap.setAttribute('role', 'region');
    transcriptWrap.setAttribute('aria-label', 'Transcript');

    const makeLine = (line) => {
      const p = document.createElement('p');
      p.className = 'transcript-line';
      p.setAttribute('tabindex', '-1');

      const metaSpan = document.createElement('span');
      metaSpan.className = 'transcript-meta small muted';

      const speaker = line && (line.speaker || line.spk) || '';
      let start = null;
      if (line && line.start_time != null) start = Number(line.start_time);
      else if (line && line.start != null) start = Number(line.start);

      if (speaker) {
        const sspan = document.createElement('strong');
        sspan.className = 'speaker';
        sspan.textContent = speaker + ' ';
        metaSpan.appendChild(sspan);
      }
      if (start != null && !Number.isNaN(start)) {
        metaSpan.appendChild(_createTimeAnchor(start, session.id || session.session_id));
        metaSpan.appendChild(document.createTextNode(' '));
      }
      p.appendChild(metaSpan);

      const txt = document.createElement('span');
      txt.className = 'transcript-text';
      txt.textContent = line && (line.text || line.content) || '';
      p.appendChild(txt);

      // allow clicking the whole line to navigate
      p.addEventListener('click', () => {
        if (start != null && !Number.isNaN(start)) {
          try {
            const base = '/sessions.html';
            const sid = session.id || session.session_id || '';
            if (sid) window.location.href = `${base}#${encodeURIComponent(sid)}?t=${encodeURIComponent(Math.round(start))}`;
            else window.location.hash = `t=${Math.round(start)}`;
          } catch (_) {}
        }
      }, { passive: true });

      // keyboard accessibility
      p.addEventListener('keypress', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          p.click();
        }
      }, { passive: true });

      return p;
    };

    if (Array.isArray(session.transcript) && session.transcript.length) {
      session.transcript.forEach(line => {
        try { transcriptWrap.appendChild(makeLine(line)); } catch (e) { _log('make transcript line err', e); }
      });
    } else if (typeof session.transcript === 'string' && session.transcript.trim()) {
      const pre = document.createElement('pre');
      pre.className = 'transcript-pre';
      pre.textContent = session.transcript;
      transcriptWrap.appendChild(pre);
    } else {
      transcriptWrap.appendChild(_makeMuted('Transcript unavailable'));
    }

    container.appendChild(transcriptWrap);
    container.dispatchEvent(new CustomEvent('sti:sessions:detail:rendered', { detail: { id: session.id || session.session_id } }));
  }

  // ---------- Init helpers: list and detail modes ----------
  async function initListMode(limit = api._config.DEFAULT_PREVIEW_LIMIT) {
    const listEl = _queryListElement();
    if (!listEl) return;
    try {
      listEl.innerHTML = '';
      listEl.appendChild(_makeMuted('Loading sessions...'));
      const sessions = await fetchSessions();
      if (!sessions) {
        listEl.innerHTML = '';
        // fallback demo data
        const demo = [
          { id: 'demo-1', title: 'Demo: Project kick-off', status: 'completed', summary: 'Intro and goals.' },
          { id: 'demo-2', title: 'Demo: Sprint planning', status: 'queued', summary: 'Roadmap and action items.' }
        ];
        renderList(listEl, demo.slice(0, limit), {});
        _toast('Sessions API not available — demo data shown', 1600);
        return;
      }
      renderList(listEl, sessions.slice(0, limit), {});
      listEl.dispatchEvent(new CustomEvent('sti:sessions:list:init', { detail: { count: (sessions && sessions.length) || 0 } }));
    } catch (err) {
      _log('initListMode error', err);
      listEl.innerHTML = '';
      listEl.appendChild(_makeMuted('Failed to load sessions'));
    }
  }

  async function initDetailMode() {
    try {
      // use hash format: #<sessionId>?t=NN or #<sessionId>&t=NN etc
      const rawHash = window.location.hash || '';
      if (!rawHash || rawHash.length <= 1) return;
      let hash = rawHash.replace(/^#/, '');
      let idPart = hash;
      let queryPart = '';
      const qIndex = hash.indexOf('?');
      if (qIndex !== -1) {
        idPart = hash.slice(0, qIndex);
        queryPart = hash.slice(qIndex + 1);
      }
      let id = idPart || '';
      try { id = decodeURIComponent(id); } catch (e) { /* ignore decode errors */ }

      if (!id) return;
      const container = _queryDetailElement();
      if (!container) return;
      container.innerHTML = '';
      container.appendChild(_makeMuted('Loading session...'));
      const session = await fetchSession(id);
      if (!session) {
        container.innerHTML = '';
        container.appendChild(_makeMuted('Could not load session details.'));
        return;
      }
      renderSessionDetail(container, session);

      // parse time param (either in queryPart or in hash like ?t=)
      const params = {};
      if (queryPart) {
        queryPart.split('&').forEach(kv => {
          const p = kv.split('=');
          if (p.length === 2) {
            try { params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]); } catch (_) { params[p[0]] = p[1]; }
          }
        });
      } else {
        const m = window.location.hash.match(/[?&]t=(\d+)/);
        if (m) params.t = m[1];
      }

      if (params.t) {
        try {
          const targetSec = Number(params.t);
          const lines = container.querySelectorAll('.transcript-line');
          if (lines && lines.length) {
            let found = null;
            for (let i = 0; i < lines.length; i++) {
              const a = lines[i].querySelector('.time-anchor');
              if (!a) continue;
              const href = a.getAttribute('href') || '';
              const tt = href.match(/t=(\d+)/);
              let val = null;
              if (tt) val = Number(tt[1]);
              else {
                const txt = a.textContent || '';
                const mm = txt.match(/\[(\d+)s\]/);
                if (mm) val = Number(mm[1]);
              }
              if (val != null && Math.abs(val - targetSec) <= 3) { found = lines[i]; break; }
              if (val != null && val >= targetSec) { found = lines[i]; break; }
            }
            if (!found && lines.length) found = lines[0];
            if (found) {
              try { found.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { found.scrollIntoView(); }
              found.classList.add('highlight');
              setTimeout(() => found.classList.remove('highlight'), 2200);
            }
          }
        } catch (_) { /* ignore highlight errors */ }
      }
    } catch (err) {
      _log('initDetailMode error', err);
    }
  }

  // ---------- Top-level init ----------
  function safeInit() {
    try {
      // Non-blocking: init list mode
      initListMode().catch(e => _log('initListMode failed', e));
      // Detail mode if hash present or detail element exists
      initDetailMode().catch(e => _log('initDetailMode failed', e));
    } catch (err) {
      _log('safeInit failed', err);
    }
  }

  // auto-run on DOM ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();

  // ---------- Expose API & test hooks ----------
  api.fetchSessions = fetchSessions;
  api.fetchSession = fetchSession;
  api.renderList = renderList;
  api.renderSessionDetail = renderSessionDetail;
  api.initListMode = initListMode;
  api.initDetailMode = initDetailMode;
  api.init = safeInit;
  api._config = Object.assign({}, api._config);

  // test hooks / overrides
  api.setFetch = (fn) => { api._fetchOverride = typeof fn === 'function' ? fn : null; };
  api.setAbortController = (Ctor) => { api._AbortControllerOverride = Ctor || null; };

  // stable window export
  window.sti = window.sti || {};
  window.sti.sessions = window.sti.sessions || api;
})();
