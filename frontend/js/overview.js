/**
 * overview.js — Corrected, enhanced, and upgraded Overview page module
 *
 * Responsibilities:
 * - Populate the "recent sessions" preview robustly from /sessions (configurable)
 * - Wire quick upload inputs (reusing sti.main.uploadFile when available)
 * - Provide graceful fallbacks and demo data when backend is unavailable
 * - Expose a stable API on window.sti.overview:
 *     .init(opts) -> void
 *     .refresh(limit) -> Promise<boolean>
 *     .populatePreview(limit) -> Promise<array|null>
 *     .configure(cfg) -> void
 *     .setFetch(fn) / .setAbortController(Ctor) -> test hooks
 * - Emit CustomEvents for integration/tests:
 *     sti:overview:ready, sti:overview:refresh:start, sti:overview:refresh:ok,
 *     sti:overview:refresh:fail
 *
 * Defensive: idempotent init, tolerant parsing, timeouts, abort support, small retries.
 */

(function () {
  'use strict';

  // ---------- Namespace & API ----------
  const sti = window.sti || (window.sti = {});
  sti.overview = sti.overview || {};
  const api = sti.overview;

  // ---------- Default config (can be overridden by configure) ----------
  const DEFAULTS = {
    SESSIONS_ENDPOINT: '/sessions',
    FETCH_TIMEOUT_MS: 2500,
    PREVIEW_LIMIT: 5,
    RETRY_ATTEMPTS: 2,
    RETRY_BASE_DELAY_MS: 250,
    SELECTORS: {
      recentList: '#recent-sessions', // fallback id(s) supported in code
      fileInputs: 'input[type="file"][data-upload]'
    },
    DEMO_DATA: [
      { id: 'demo-1', title: 'Demo: Project kick-off', status: 'completed', summary: 'Intro and goals.' },
      { id: 'demo-2', title: 'Demo: Sprint planning', status: 'queued', summary: 'Roadmap and action items.' }
    ]
  };

  // live config copied to api._config
  api._config = Object.assign({}, DEFAULTS);

  // platform/test hooks
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  // ---------- Small utilities ----------
  function _now() { return Date.now(); }
  function _trim(s) { return String(s == null ? '' : s).trim(); }
  function _log(...args) { if (console && console.debug) console.debug('sti.overview:', ...args); }

  function _tryParseJson(text) {
    if (text === undefined || text === null) return null;
    if (typeof text === 'object') return text;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function _createMutedItem(text) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = String(text || '');
    li.setAttribute('aria-hidden', 'false');
    return li;
  }

  function _getRecentListEl() {
    const sel = api._config.SELECTORS.recentList;
    let el = null;
    try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (!el) {
      // try legacy id
      el = document.getElementById('recent-sessions') || document.getElementById('recent-sessions-list');
    }
    return el;
  }

  function _makeSessionLink(id, title) {
    const a = document.createElement('a');
    a.textContent = title || id || 'Session';
    try {
      // Use session query param to be consistent with sessions page nav
      const href = '/sessions.html?session=' + encodeURIComponent(id || '');
      a.setAttribute('href', href);
    } catch (e) {
      a.setAttribute('href', '#');
    }
    a.setAttribute('aria-label', a.textContent);
    return a;
  }

  // ---------- Fetch with timeout + retries ----------
  async function _fetchWithTimeout(url, opts = {}, timeoutMs = api._config.FETCH_TIMEOUT_MS) {
    if (!url) throw new TypeError('_fetchWithTimeout: url required');

    const fetchFn = api._fetchOverride || window.fetch;
    if (typeof fetchFn !== 'function') throw new Error('Fetch not available');

    const AbortCtor = api._AbortControllerOverride || window.AbortController;
    const controller = AbortCtor ? new AbortCtor() : null;
    const finalOpts = Object.assign({}, opts);
    if (controller) finalOpts.signal = controller.signal;
    finalOpts.credentials = finalOpts.credentials || 'same-origin';

    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, finalOpts);
      const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const parsed = _tryParseJson(txt);
        const err = new Error('Network error: ' + res.status);
        err.status = res.status;
        err.body = parsed !== null ? parsed : txt;
        throw err;
      }
      // prefer JSON if parseable, else try first non-empty line (jsonl)
      const parsed = _tryParseJson(txt);
      if (parsed !== null) return parsed;
      const first = (txt || '').split(/\r?\n/).find(Boolean) || '';
      const firstParsed = _tryParseJson(first);
      if (firstParsed !== null) return firstParsed;
      return txt;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error('Request aborted/timeout');
        e.code = 'ABORT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function _fetchWithRetries(url, opts = {}, attempts = api._config.RETRY_ATTEMPTS, baseDelay = api._config.RETRY_BASE_DELAY_MS) {
    let lastErr = null;
    for (let i = 0; i <= Math.max(0, attempts); i++) {
      try {
        return await _fetchWithTimeout(url, opts, api._config.FETCH_TIMEOUT_MS);
      } catch (err) {
        lastErr = err;
        _log('fetch attempt', i, 'failed', err && err.message ? err.message : err);
        if (i < attempts) {
          // backoff
          const backoff = baseDelay * Math.pow(2, i);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }
    throw lastErr;
  }

  // ---------- Rendering helpers ----------
  function _renderSessionsInto(listEl, sessions, limit) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!Array.isArray(sessions) || sessions.length === 0) {
      listEl.appendChild(_createMutedItem('No sessions found'));
      return;
    }

    const frag = document.createDocumentFragment();
    const slice = sessions.slice(0, typeof limit === 'number' ? limit : api._config.PREVIEW_LIMIT);
    slice.forEach(s => {
      const li = document.createElement('li');
      li.className = 'overview-session';

      const id = (s && (s.id || s.session_id || s.upload_id || s.key || s.name)) || '';
      const titleText = (s && (s.title || s.name || s.summary || id)) || id || 'Session';
      const link = _makeSessionLink(id, titleText);
      li.appendChild(link);

      const meta = document.createElement('div');
      meta.className = 'muted small';
      const status = (s && (s.status || s.state)) || 'unknown';
      let duration = '';
      try {
        const dur = (s && s.meta && s.meta.duration) || s.duration || null;
        if (dur != null && !Number.isNaN(Number(dur))) duration = ' • ' + Math.round(Number(dur)) + 's';
      } catch (_) { duration = ''; }
      meta.textContent = status + (duration || '');
      li.appendChild(meta);

      const snippet = (s && (s.summary || s.snippet || s.excerpt || (typeof s.transcript === 'string' ? s.transcript : ''))) || '';
      if (snippet) {
        const p = document.createElement('p');
        p.className = 'small';
        p.textContent = String(snippet).replace(/\s+/g, ' ').trim().slice(0, 300);
        li.appendChild(p);
      }

      frag.appendChild(li);
    });

    listEl.appendChild(frag);
  }

  // ---------- Data population ----------
  // returns array of sessions or null on failure
  async function populatePreview(limit = api._config.PREVIEW_LIMIT) {
    const listEl = _getRecentListEl();
    if (!listEl) return null;

    // show loading state
    listEl.innerHTML = '';
    listEl.appendChild(_createMutedItem('Loading sessions...'));

    const base = api._config.SESSIONS_ENDPOINT || DEFAULTS.SESSIONS_ENDPOINT;
    const urls = [
      `${base}?limit=${encodeURIComponent(limit)}`,
      `${base}?size=${encodeURIComponent(limit)}`,
      base
    ];

    let data = null;
    try {
      // try multiple candidate urls with retries
      for (let i = 0; i < urls.length; i++) {
        try {
          data = await _fetchWithRetries(urls[i], { method: 'GET' }, Math.max(0, api._config.RETRY_ATTEMPTS));
          if (data) break;
        } catch (err) {
          _log('candidate sessions endpoint failed', urls[i], err && err.message ? err.message : err);
        }
      }
    } catch (err) {
      _log('populatePreview fetch attempts exhausted', err && err.message ? err.message : err);
      data = null;
    }

    // clear loading
    listEl.innerHTML = '';

    if (!data) {
      // fallback to demo data
      listEl.appendChild(_createMutedItem('Sessions API not available — showing demo data'));
      _renderSessionsInto(listEl, api._config.DEMO_DATA, limit);
      document.dispatchEvent(new CustomEvent('sti:overview:refresh:fail', { detail: { reason: 'no_backend' } }));
      return api._config.DEMO_DATA.slice(0, limit);
    }

    // normalize into an array
    let arr = [];
    if (Array.isArray(data)) arr = data;
    else if (Array.isArray(data.sessions)) arr = data.sessions;
    else if (Array.isArray(data.items)) arr = data.items;
    else if (typeof data === 'object' && data !== null) {
      // find first array property
      const ks = Object.keys(data);
      for (let k = 0; k < ks.length; k++) {
        if (Array.isArray(data[ks[k]])) { arr = data[ks[k]]; break; }
      }
      // if still empty and object seems like a single session, wrap it
      if (!arr.length && Object.keys(data).length && (data.id || data.title || data.session_id)) arr = [data];
    }

    if (!arr || arr.length === 0) {
      listEl.appendChild(_createMutedItem('No sessions found'));
      document.dispatchEvent(new CustomEvent('sti:overview:refresh:ok', { detail: { sessions: [] } }));
      return [];
    }

    _renderSessionsInto(listEl, arr, limit);
    document.dispatchEvent(new CustomEvent('sti:overview:refresh:ok', { detail: { sessions: arr.slice(0, limit) } }));
    return arr.slice(0, limit);
  }

  // ---------- Quick upload wiring ----------
  function wireQuickUpload() {
    // if a dedicated upload module exists, prefer it
    if (sti.upload && typeof sti.upload.bindUploadForm === 'function') {
      try { sti.upload.bindUploadForm(); return; } catch (e) { _log('sti.upload.bindUploadForm failed', e); }
    }

    // otherwise wire data-upload inputs and reuse sti.main.uploadFile if available
    const selector = api._config.SELECTORS.fileInputs || DEFAULTS.SELECTORS.fileInputs;
    let inputs = [];
    try { inputs = Array.prototype.slice.call(document.querySelectorAll(selector)); } catch (e) { inputs = []; }
    if (!inputs.length) return;

    inputs.forEach(input => {
      if (input.__overviewBound) return;
      input.addEventListener('change', async () => {
        const files = input.files || [];
        if (!files.length) return;
        try {
          _safeToast('Uploading...', 1200);
          if (sti.main && typeof sti.main.uploadFile === 'function') {
            const res = await sti.main.uploadFile(files[0], {
              presignEndpoint: input.dataset.presignEndpoint || undefined,
              uploadEndpoint: input.dataset.uploadEndpoint || undefined,
              startWorkflow: input.dataset.startWorkflow === 'true'
            });
            if (res && res.ok) {
              _safeToast('Upload requested', 1400);
              // refresh preview with a small delay to let backend settle
              setTimeout(() => populatePreview(api._config.PREVIEW_LIMIT).catch(() => {}), 1200);
            } else {
              const msg = res && (res.message || (res.json && JSON.stringify(res.json)) || res.error) || 'Upload failed';
              _safeToast(msg, 4000);
            }
          } else {
            _safeToast('Upload support not available', 2000);
          }
        } catch (err) {
          _safeToast('Upload failed', 2500);
          _log('overview upload error', err);
        }
      }, { passive: true });
      input.__overviewBound = true;
    });
  }

  // ---------- Public refresh (safe) ----------
  async function refresh(limit = api._config.PREVIEW_LIMIT) {
    document.dispatchEvent(new CustomEvent('sti:overview:refresh:start', { detail: { limit } }));
    try {
      const sessions = await populatePreview(limit);
      return !!sessions;
    } catch (err) {
      _log('refresh error', err);
      return false;
    }
  }

  // ---------- Initialization ----------
  function init(opts = {}) {
    // idempotent init
    if (init.__done) return;
    init.__done = true;

    // apply opts/configure if provided
    if (opts && typeof opts === 'object') api.configure(opts);

    // attempt to reuse dashboard refresh if present (non-blocking)
    try {
      if (sti.dashboard && typeof sti.dashboard.refresh === 'function') {
        try { sti.dashboard.refresh(); } catch (e) { _log('dashboard.refresh error', e); }
      }
    } catch (e) { /* ignore */ }

    // wire quick upload and populate preview
    wireQuickUpload();
    // best-effort populate
    populatePreview(api._config.PREVIEW_LIMIT).catch(err => { _log('initial populatePreview error', err); });

    document.dispatchEvent(new CustomEvent('sti:overview:ready', { detail: { config: api._config } }));
  }

  // ---------- Configuration & test hooks ----------
  api.configure = function configure(cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.SESSIONS_ENDPOINT) api._config.SESSIONS_ENDPOINT = cfg.SESSIONS_ENDPOINT;
    if (Number.isFinite(cfg.FETCH_TIMEOUT_MS)) api._config.FETCH_TIMEOUT_MS = cfg.FETCH_TIMEOUT_MS;
    if (Number.isFinite(cfg.PREVIEW_LIMIT)) api._config.PREVIEW_LIMIT = cfg.PREVIEW_LIMIT;
    if (Number.isFinite(cfg.RETRY_ATTEMPTS)) api._config.RETRY_ATTEMPTS = cfg.RETRY_ATTEMPTS;
    if (Number.isFinite(cfg.RETRY_BASE_DELAY_MS)) api._config.RETRY_BASE_DELAY_MS = cfg.RETRY_BASE_DELAY_MS;
    if (cfg.SELECTORS && typeof cfg.SELECTORS === 'object') api._config.SELECTORS = Object.assign({}, api._config.SELECTORS, cfg.SELECTORS);
    if (Array.isArray(cfg.DEMO_DATA)) api._config.DEMO_DATA = cfg.DEMO_DATA.slice();
    return api._config;
  };

  api.setFetch = function (fn) { api._fetchOverride = fn; };
  api.setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
  api.populatePreview = populatePreview;
  api.refresh = refresh;
  api.init = init;

  // auto-init on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
