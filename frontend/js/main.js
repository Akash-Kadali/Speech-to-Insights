/**
 * main.js — Upgraded sitewide behaviors: theme, upload helper, small utilities
 *
 * - Defensive, test-friendly, configurable via window.STI
 * - Exposes stable API on window.sti.main (and window.sti helpers)
 * - Features: theme forced to dark, presign/multipart upload helper, fetch helpers,
 *   auto-wire file inputs, toast fallback, auto-open latest session (opt-in)
 *
 * Place in /frontend/js/main.js and ensure HTML includes:
 *   <link id="theme-link" rel="stylesheet" href="/css/theme-dark.css" />
 *   <script defer src="/js/main.js"></script>
 */
(function () {
  'use strict';

  // ---------- Stable namespace ----------
  const sti = window.sti || (window.sti = {});
  const api = (sti.main = sti.main || {});

  // ---------- Config (override via window.STI) ----------
  const HOST = window.STI || {};
  const DEFAULT_PRESIGN = HOST.PRESIGN_ENDPOINT || '/presign';
  const DEFAULT_UPLOAD = HOST.UPLOAD_ENDPOINT || '/upload';
  const DEFAULT_FETCH_TIMEOUT_MS = Number.isFinite(HOST.FETCH_TIMEOUT_MS) ? HOST.FETCH_TIMEOUT_MS : 3000;
  const DEFAULT_PRESIGN_EXPIRES = Number.isFinite(HOST.PRESIGN_EXPIRES) ? HOST.PRESIGN_EXPIRES : 900;
  const AUTOOPEN_TIMEOUT_MS = Number.isFinite(HOST.AUTOOPEN_TIMEOUT_MS) ? HOST.AUTOOPEN_TIMEOUT_MS : 1500;

  // ---------- Test hooks / platform wrappers ----------
  api._fetchOverride = null;
  api._AbortControllerOverride = null;
  const platform = {
    fetch: typeof window.fetch === 'function' ? window.fetch.bind(window) : null,
    AbortController: typeof window.AbortController === 'function' ? window.AbortController : null,
    now: () => Date.now()
  };

  // ---------- Utilities ----------
  function _trim(s) { return String(s == null ? '' : s).trim(); }

  function _tryParseJSON(text) {
    if (text === undefined || text === null) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function _safeToast(msg, timeout) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(msg, timeout); return; }
    } catch (e) { /* ignore host showToast errors */ }

    const el = document.getElementById('toast');
    if (el) {
      el.hidden = false;
      el.textContent = String(msg || '');
      el.classList.add('visible');
      clearTimeout(el.__timer);
      el.__timer = setTimeout(() => { el.classList.remove('visible'); el.hidden = true; }, (typeof timeout === 'number') ? timeout : 3000);
      return;
    }
    if (console && console.info) console.info('TOAST:', msg);
  }

  // Ensure a usable window.showToast exists (idempotent)
  function ensureToast() {
    if (typeof window.showToast === 'function') return;
    window.showToast = _safeToast;
  }

  // ---------- Theme helpers (dark-only) ----------
  function _getThemeLink() { return document.getElementById('theme-link'); }

  // Set theme href or token but do not persist user preference.
  // This is intentionally minimal because site is dark-only.
  function setTheme(hrefOrToken) {
    try {
      const tl = _getThemeLink();
      const token = String(hrefOrToken || '').toLowerCase();

      // If token is provided, map to dark/light file; otherwise accept href
      const href = (token === 'dark') ? '/css/theme-dark.css' :
                   (token === 'light') ? '/css/theme-light.css' :
                   hrefOrToken || (tl && tl.getAttribute('href')) || '';

      if (!href) return false;

      if (tl) tl.setAttribute('href', href);
      const isDark = String(href).indexOf('dark') !== -1;
      document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

      // Do not write to localStorage. We remove any existing preference to avoid surprises.
      try { if (window.localStorage && typeof window.localStorage.removeItem === 'function') localStorage.removeItem('sti-theme'); } catch (_) {}

      return true;
    } catch (err) {
      if (console && console.warn) console.warn('setTheme failed', err);
      return false;
    }
  }

  // Force dark theme at startup. This avoids reading any saved values and disables toggling.
  function forceDarkTheme() {
    try {
      const tl = _getThemeLink();
      if (tl) tl.setAttribute('href', '/css/theme-dark.css');
      document.documentElement.setAttribute('data-theme', 'dark');
      try { if (window.localStorage && typeof window.localStorage.removeItem === 'function') localStorage.removeItem('sti-theme'); } catch (_) {}
      return true;
    } catch (e) {
      if (console && console.warn) console.warn('forceDarkTheme failed', e);
      return false;
    }
  }

  // Note: toggleTheme and initThemeToggle intentionally removed because site is dark-only.

  // ---------- Fetch helpers (timeout + parse) ----------
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    if (!url) throw new TypeError('fetchJsonWithTimeout: missing url');

    const fetchFn = api._fetchOverride || platform.fetch;
    if (!fetchFn) throw new Error('Fetch unavailable in this environment');

    const AbortCtor = api._AbortControllerOverride || platform.AbortController;
    let controller = null;
    if (AbortCtor) controller = new AbortCtor();

    const finalOpts = Object.assign({}, opts);
    if (controller) finalOpts.signal = controller.signal;
    finalOpts.credentials = finalOpts.credentials || 'same-origin';

    let timer = null;
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(url, finalOpts);
      const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      const parsed = _tryParseJSON(txt);
      if (res.ok) return parsed !== null ? parsed : txt;
      const err = new Error('Network response not ok: ' + res.status);
      err.status = res.status;
      err.body = parsed !== null ? parsed : txt;
      throw err;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error('Request aborted (timeout)');
        e.code = 'ABORT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchJson(url, opts = {}) {
    try {
      const res = await fetchJsonWithTimeout(url, opts, DEFAULT_FETCH_TIMEOUT_MS);
      return { ok: true, data: res };
    } catch (err) {
      return { ok: false, error: err, message: (err && err.message) || String(err) };
    }
  }

  // ---------- Upload helper (presign + multipart fallback) ----------
  // Returns normalized { ok, transport, s3_uri?, upload_id?, status?, json?, error? }
  async function uploadFile(file, options = {}) {
    if (!file) throw new TypeError('uploadFile: missing file');
    const presignEndpoint = options.presignEndpoint || DEFAULT_PRESIGN;
    const uploadEndpoint = options.uploadEndpoint || DEFAULT_UPLOAD;
    const startWorkflow = !!options.startWorkflow;
    const presignExpires = (typeof options.presignExpires === 'number') ? options.presignExpires : DEFAULT_PRESIGN_EXPIRES;
    const fetchTimeout = (typeof options.fetchTimeoutMs === 'number') ? options.fetchTimeoutMs : DEFAULT_FETCH_TIMEOUT_MS;

    // Prefer presign flow
    try {
      const qs = `?filename=${encodeURIComponent(file.name)}&content_type=${encodeURIComponent(file.type || 'application/octet-stream')}&expires_in=${encodeURIComponent(presignExpires)}${startWorkflow ? '&start_workflow=true' : ''}`;
      const presignRaw = await fetchJsonWithTimeout(presignEndpoint + qs, { method: 'GET', credentials: 'same-origin' }, fetchTimeout);
      const presign = presignRaw && (presignRaw.result || presignRaw) || {};
      const putUrl = presign.url || presign.presigned_url || presign.upload_url || presign.put_url || presign.presign_url;
      if (putUrl) {
        const headers = {};
        if (file.type) headers['Content-Type'] = file.type;
        const putRes = await (api._fetchOverride || platform.fetch)(putUrl, { method: 'PUT', body: file, headers });
        if (putRes && (putRes.ok || putRes.status === 200 || putRes.status === 201)) {
          return {
            ok: true,
            transport: 'presign',
            s3_uri: presign.s3_uri || presign.s3Uri || presign.bucket_path || null,
            upload_id: presign.upload_id || presign.uploadId || null,
            raw: presign
          };
        } else {
          const putText = await (putRes && putRes.text ? putRes.text().catch(() => '') : Promise.resolve(''));
          if (console && console.warn) console.warn('Presign PUT failed', putRes && putRes.status, putText);
          // fall through to multipart fallback
        }
      } else {
        if (console && console.info) console.info('Presign response lacked a URL; falling back to multipart.', presign);
      }
    } catch (e) {
      if (console && console.info) console.info('Presign flow failed; falling back to multipart.', e && e.message ? e.message : e);
    }

    // Multipart fallback
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      if (startWorkflow) fd.append('start_workflow', 'true');
      const post = await (api._fetchOverride || platform.fetch)(uploadEndpoint, { method: 'POST', body: fd, credentials: 'same-origin' });
      const txt = await (post && post.text ? post.text().catch(() => '') : Promise.resolve(''));
      const json = _tryParseJSON(txt);
      return {
        ok: !!(post && post.ok),
        transport: 'multipart',
        status: post && post.status,
        json: json !== null ? json : txt
      };
    } catch (err) {
      return { ok: false, transport: 'error', error: err, message: (err && err.message) || String(err) };
    }
  }

  // ---------- Auto-wire file inputs marked with data-upload ----------
  function wireAutoUploads() {
    const inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"][data-upload]'));
    inputs.forEach(el => {
      if (el.__stiBound) return;
      el.addEventListener('change', async function () {
        const files = el.files || [];
        if (!files.length) return;
        const triggerSelector = el.dataset.uploadTrigger;
        const trigger = triggerSelector ? document.querySelector(triggerSelector) : (document.querySelector(`[data-upload-trigger="${el.id}"]`) || el);
        try {
          if (trigger) trigger.disabled = true;
          ensureToast();
          window.showToast('Uploading...', 1200);
          const res = await uploadFile(files[0], {
            presignEndpoint: el.dataset.presignEndpoint || DEFAULT_PRESIGN,
            uploadEndpoint: el.dataset.uploadEndpoint || DEFAULT_UPLOAD,
            startWorkflow: el.dataset.startWorkflow === 'true' || el.dataset.startWorkflow === '1',
            presignExpires: el.dataset.presignExpires ? parseInt(el.dataset.presignExpires, 10) : undefined,
            fetchTimeoutMs: el.dataset.fetchTimeoutMs ? parseInt(el.dataset.fetchTimeoutMs, 10) : undefined
          });

          if (res && res.ok) {
            window.showToast('Upload succeeded', 1600);
            try { if (window.STI && typeof window.STI.onUploadSuccess === 'function') window.STI.onUploadSuccess(res); } catch (_) {}
          } else {
            const msg = res && (res.message || (res.json && JSON.stringify(res.json)) || res.error) ? (res.message || res.error || JSON.stringify(res.json)) : 'unknown';
            window.showToast('Upload failed: ' + msg, 6000);
            try { if (window.STI && typeof window.STI.onUploadFailure === 'function') window.STI.onUploadFailure(res); } catch (_) {}
          }
        } catch (err) {
          window.showToast('Upload error: ' + String(err), 6000);
        } finally {
          try { if (trigger) trigger.disabled = false; } catch (_) {}
        }
      }, { passive: true });
      el.__stiBound = true;
    });
  }

  // ---------- Auto-open latest session on root (opt-in) ----------
  // IMPORTANT: This behavior is opt-in. Set `window.STI.AUTOOPEN_LATEST = true`
  // before main.js runs to enable automatic navigation from "/" to the latest session.
  async function autoOpenLatestSessionIfRoot() {
    try {
      if (!(window.STI && window.STI.AUTOOPEN_LATEST === true)) {
        return;
      }

      const path = (window.location && window.location.pathname) || '/';
      if (!(path === '/' || path === '/index.html' || path === '')) return;

      const AbortCtor = api._AbortControllerOverride || platform.AbortController;
      const controller = AbortCtor ? new AbortCtor() : null;
      let timer = null;
      if (controller) timer = setTimeout(() => controller.abort(), AUTOOPEN_TIMEOUT_MS);

      try {
        const res = await (api._fetchOverride || platform.fetch)('/sessions', controller ? { signal: controller.signal, credentials: 'same-origin' } : { credentials: 'same-origin' });
        if (!res || !res.ok) return;
        const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
        const parsed = _tryParseJSON(txt) || (txt ? { sessions: [] } : { sessions: [] });
        const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : (Array.isArray(parsed) ? parsed : []);
        if (!sessions.length) return;

        sessions.sort((a, b) => {
          const ta = a.last_modified ? new Date(a.last_modified).getTime() : 0;
          const tb = b.last_modified ? new Date(b.last_modified).getTime() : 0;
          return tb - ta;
        });
        const latest = sessions[0];
        const idv = encodeURIComponent(latest.id || latest.key || '');
        if (idv) window.location.replace('/sessions.html?session=' + idv);
      } catch (err) {
        if (console && console.debug) console.debug('autoOpenLatestSessionIfRoot failed/aborted', err && err.message ? err.message : err);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch (e) {
      if (console && console.warn) console.warn('autoOpenLatestSessionIfRoot error', e);
    }
  }

  // ---------- Safe init ----------
  function safeInit() {
    try {
      ensureToast();

      // Force dark theme and clear any saved preference
      forceDarkTheme();

      wireAutoUploads();

      // export utilities
      api.setTheme = setTheme; // kept in case code calls setTheme programmatically
      api.uploadFile = uploadFile;
      api.fetchJson = fetchJson;
      api.fetchJsonWithTimeout = fetchJsonWithTimeout;
      api.wireAutoUploads = wireAutoUploads;
      api._config = {
        DEFAULT_PRESIGN, DEFAULT_UPLOAD, DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_PRESIGN_EXPIRES
      };

      // Kick off auto-open without blocking (only runs if opt-in)
      try { autoOpenLatestSessionIfRoot(); } catch (_) {}

      // ready event
      document.dispatchEvent(new CustomEvent('sti:main:ready', { detail: { config: api._config } }));
    } catch (e) {
      if (console && console.warn) console.warn('sti.main safeInit failed', e);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();

  // ---------- Exports ----------
  sti.uploadFile = sti.uploadFile || api.uploadFile;
  sti.fetchJson = sti.fetchJson || api.fetchJson;
  // intentionally do not expose a toggle function since site is dark-only
  sti.main = api;

})();
