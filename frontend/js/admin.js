/**
 * admin.js — Upgraded admin page behaviors (seed/clear/demo queue)
 *
 * - Defensive, configurable, accessible, test-friendly.
 * - Exposes stable API on window.stiAdmin.
 * - Emits CustomEvents for integration and testing.
 *
 * Usage:
 *   window.stiAdmin.refreshQueue();
 *   window.stiAdmin.seedDemoData([...]);
 *
 * Design goals:
 *  - Non-destructive: do not overwrite server-rendered queue if present
 *  - Robust fetch with timeout and JSON/JSONL parsing
 *  - Clear, debounced refresh semantics
 *  - Pluggable item renderer and optional fetch override (for tests)
 */
(function () {
  'use strict';

  // ---------- Config ----------
  const DEFAULT_QUEUE_ENDPOINT = '/admin/queue';
  const DEFAULT_FETCH_TIMEOUT_MS = 2500;
  const DEFAULT_REFRESH_MIN_MS = 700;
  const DEFAULT_DEMO = [
    'upload_2025-11-30_12:02.wav — processing',
    'meeting_2025-11-29_09:10.mp3 — queued',
    'lecture_2025-11-28_16:45.mp3 — completed'
  ];

  // allow host page overrides (window.STI or global constants)
  const cfgFromWindow = (window.STI && window.STI.ADMIN) || window.STI_ADMIN || {};
  const QUEUE_ENDPOINT_RAW = (cfgFromWindow && cfgFromWindow.QUEUE_ENDPOINT) ||
    (window.STI && window.STI.ADMIN_QUEUE_ENDPOINT) ||
    window.STI_ADMIN_QUEUE_ENDPOINT ||
    DEFAULT_QUEUE_ENDPOINT;
  const FETCH_TIMEOUT_MS = (cfgFromWindow && cfgFromWindow.FETCH_TIMEOUT_MS) ||
    window.STI_ADMIN_FETCH_TIMEOUT_MS ||
    DEFAULT_FETCH_TIMEOUT_MS;

  const queueEndpoint = Array.isArray(QUEUE_ENDPOINT_RAW) ? QUEUE_ENDPOINT_RAW[0] : QUEUE_ENDPOINT_RAW;

  // allow replacing fetch for tests / custom networking
  const platform = {
    fetch: (typeof window.fetch === 'function') ? window.fetch.bind(window) : null,
    AbortController: typeof window.AbortController === 'function' ? window.AbortController : null,
    now: () => Date.now()
  };

  // ---------- Namespace / API ----------
  const api = window.stiAdmin || (window.stiAdmin = {});
  api._config = { queueEndpoint, FETCH_TIMEOUT_MS, DEFAULT_REFRESH_MIN_MS };

  // ---------- Helpers ----------
  function _getQueueElement() {
    return document.getElementById('queue-list');
  }

  function _makeMutedItem(text) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = String(text || '');
    // ensure accessible by screen readers
    li.setAttribute('aria-hidden', 'false');
    return li;
  }

  // Default renderer; consumer may override api.itemRenderer
  function _defaultItemRenderer(item) {
    if (item == null) return '';
    if (typeof item === 'string') return item;
    if (typeof item === 'object') {
      if (item.display) return String(item.display);
      if (item.title) return String(item.title);
      if (item.name) return String(item.name);
      if (item.id && item.status) return `${String(item.id)} — ${String(item.status)}`;
    }
    try { return JSON.stringify(item); } catch (e) { return String(item); }
  }

  api.itemRenderer = api.itemRenderer || _defaultItemRenderer;

  // Small toast abstraction (non-fatal)
  function _toast(message, ms = 3000) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(message, ms);
    } catch (e) { /* ignore */ }

    const el = document.getElementById('toast');
    if (!el) {
      if (console && console.info) console.info('TOAST:', message);
      return;
    }
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => el.classList.remove('visible'), ms);
  }

  // robust JSON / JSONL parser
  function _tryParseJson(text) {
    if (text === undefined || text === null) return null;
    if (typeof text === 'object') return text;
    try {
      return JSON.parse(String(text));
    } catch (e) {
      // attempt JSONL: first non-empty line
      const first = String(text).split(/\r?\n/).find(Boolean);
      try { return first ? JSON.parse(first) : null; } catch (e2) { return null; }
    }
  }

  // fetch wrapper with timeout + graceful errors
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    if (!url) throw new TypeError('fetchJsonWithTimeout: missing url');

    const fetchFn = api._fetchOverride || platform.fetch;
    if (!fetchFn) throw new Error('Fetch not available in this environment');

    const Abort = api._AbortControllerOverride || platform.AbortController;
    let controller = null;
    let signal = null;
    if (Abort) {
      controller = new Abort();
      signal = controller.signal;
    }

    const actualOpts = Object.assign({}, opts);
    if (signal) actualOpts.signal = signal;
    actualOpts.credentials = actualOpts.credentials || 'same-origin';

    let timer = null;
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(url, actualOpts);
      if (timer) clearTimeout(timer);

      const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const parsed = _tryParseJson(txt) || txt || `status ${res.status}`;
        const err = new Error(`Request failed ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
        err.status = res.status;
        err.body = parsed;
        throw err;
      }

      const parsed = _tryParseJson(txt);
      if (parsed !== null) return parsed;
      return txt;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const abortErr = new Error('Request aborted (timeout)');
        abortErr.code = 'ABORT';
        throw abortErr;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- Rendering ----------
  function renderQueue(list) {
    const ul = _getQueueElement();
    if (!ul) {
      if (console && console.warn) console.warn('renderQueue: missing #queue-list element');
      return;
    }

    const frag = document.createDocumentFragment();

    if (!Array.isArray(list) || list.length === 0) {
      frag.appendChild(_makeMutedItem('Queue is empty'));
      ul.innerHTML = '';
      ul.appendChild(frag);
      ul.setAttribute('data-last-render', 'empty');
      ul.setAttribute('aria-live', 'polite');
      // emit event for integrators/tests
      ul.dispatchEvent(new CustomEvent('sti:queue:render', { detail: { status: 'empty' } }));
      return;
    }

    list.forEach(item => {
      const li = document.createElement('li');
      try {
        const txt = api.itemRenderer(item);
        li.textContent = (typeof txt === 'string') ? txt : String(txt);
      } catch (e) {
        li.textContent = String(item);
        if (console && console.warn) console.warn('itemRenderer threw', e);
      }
      frag.appendChild(li);
    });

    ul.innerHTML = '';
    ul.appendChild(frag);
    ul.setAttribute('data-last-render', 'populated');
    ul.setAttribute('aria-live', 'polite');
    ul.dispatchEvent(new CustomEvent('sti:queue:render', { detail: { status: 'populated', count: list.length } }));
  }

  // ---------- Demo utilities ----------
  function seedDemoData(sample) {
    try {
      const list = (Array.isArray(sample) && sample.length) ? sample.slice() : DEFAULT_DEMO.slice();
      renderQueue(list);
      _toast('Demo data seeded', 1600);
      // emit event
      document.dispatchEvent(new CustomEvent('sti:admin:seed', { detail: { count: list.length } }));
      return true;
    } catch (err) {
      if (console && console.warn) console.warn('seedDemoData error', err);
      return false;
    }
  }

  function clearDemoData() {
    try {
      renderQueue([]);
      _toast('Demo data cleared', 1200);
      document.dispatchEvent(new CustomEvent('sti:admin:clear'));
      return true;
    } catch (err) {
      if (console && console.warn) console.warn('clearDemoData error', err);
      return false;
    }
  }

  // expose global small fallbacks (non-destructive)
  if (typeof window.seedDemoData !== 'function') window.seedDemoData = seedDemoData;
  if (typeof window.clearDemoData !== 'function') window.clearDemoData = clearDemoData;

  api.seedDemoData = seedDemoData;
  api.clearDemoData = clearDemoData;
  api.renderQueue = renderQueue;

  // ---------- Backend population ----------
  async function tryPopulateQueueFromBackend(customEndpoint) {
    const ep = (typeof customEndpoint === 'string' && customEndpoint) ? customEndpoint : queueEndpoint;
    if (!ep) return false;

    try {
      const data = await fetchJsonWithTimeout(ep, { method: 'GET' }, FETCH_TIMEOUT_MS);
      if (!data) return false;

      // Accept multiple shapes:
      // - array
      // - { queue: [...] } or { items: [...] }
      // - object with first array property
      if (Array.isArray(data)) {
        renderQueue(data);
        return true;
      }
      if (data && typeof data === 'object') {
        if (Array.isArray(data.queue)) { renderQueue(data.queue); return true; }
        if (Array.isArray(data.items)) { renderQueue(data.items); return true; }
        // find first array property
        for (const k of Object.keys(data)) {
          if (Array.isArray(data[k])) { renderQueue(data[k]); return true; }
        }
        // if object looks like a single item, wrap it
        renderQueue([data]);
        return true;
      }
      // fallback to string
      renderQueue([String(data)]);
      return true;
    } catch (err) {
      if (console && console.debug) console.debug('tryPopulateQueueFromBackend failed', err);
      return false;
    }
  }

  api.tryPopulateQueueFromBackend = tryPopulateQueueFromBackend;

  // ---------- Refresh control (throttled) ----------
  let _refreshPending = false;
  let _lastRefreshAt = 0;
  const REFRESH_MIN_MS = DEFAULT_REFRESH_MIN_MS;

  async function refreshQueue(opts = {}) {
    const ul = _getQueueElement();
    if (!ul) {
      if (console && console.warn) console.warn('refreshQueue: missing queue element');
      return false;
    }

    const now = platform.now();
    if (_refreshPending || (now - _lastRefreshAt) < REFRESH_MIN_MS) {
      // throttle
      if (console && console.debug) console.debug('refreshQueue: throttled');
      return false;
    }

    _refreshPending = true;
    _lastRefreshAt = now;

    // show loading placeholder in an atomic way
    const prevInner = ul.innerHTML;
    ul.innerHTML = '';
    ul.appendChild(_makeMutedItem('Loading queue...'));
    ul.setAttribute('data-last-render', 'loading');

    try {
      const ok = await tryPopulateQueueFromBackend(opts.endpoint || queueEndpoint);
      if (!ok) {
        renderQueue([]);
        _toast('No backend queue available (demo)', 1400);
        document.dispatchEvent(new CustomEvent('sti:admin:refresh', { detail: { ok: false } }));
        return false;
      } else {
        _toast('Queue refreshed', 1000);
        document.dispatchEvent(new CustomEvent('sti:admin:refresh', { detail: { ok: true } }));
        return true;
      }
    } catch (err) {
      // swallow errors, revert to previous content
      if (console && console.warn) console.warn('refreshQueue error', err);
      try { ul.innerHTML = prevInner; } catch (_) {}
      _toast('Queue refresh failed', 1400);
      document.dispatchEvent(new CustomEvent('sti:admin:refresh', { detail: { ok: false, error: err } }));
      return false;
    } finally {
      _refreshPending = false;
    }
  }

  api.refreshQueue = refreshQueue;

  // ---------- Safe initialization ----------
  function _bindButton(el, handler) {
    if (!el || el.__handled) return;
    el.addEventListener('click', ev => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      try { handler(ev); } catch (e) { if (console && console.warn) console.warn('button handler error', e); }
    }, { passive: true });

    // allow keyboard activation
    el.addEventListener('keydown', ev => {
      if (!ev) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        try { handler(ev); } catch (e) { if (console && console.warn) console.warn('button handler error', e); }
      }
    }, { passive: true });

    el.setAttribute('role', el.getAttribute('role') || 'button');
    el.tabIndex = el.tabIndex >= 0 ? el.tabIndex : 0;
    el.__handled = true;
  }

  function safeInit() {
    try {
      const seedBtn = document.getElementById('seed-demo-data');
      const clearBtn = document.getElementById('clear-demo-data');
      const refreshBtn = document.getElementById('admin-refresh-queue');

      _bindButton(seedBtn, () => seedDemoData());
      _bindButton(clearBtn, () => clearDemoData());
      _bindButton(refreshBtn, () => { refreshQueue().catch(() => {}); });

      // if server rendered queue already, keep it
      const ul = _getQueueElement();
      const hasContent = ul && ul.children && ul.children.length > 0 &&
        !(ul.children.length === 1 && ul.children[0].classList.contains('muted'));

      if (!hasContent) {
        // try to populate from backend (best-effort)
        tryPopulateQueueFromBackend().then(ok => {
          if (!ok) renderQueue([]); // ensure there's a visible placeholder
        }).catch(() => { renderQueue([]); });
      }

      // surface api for testing
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sti:admin:ready', { detail: { queueEndpoint } }));
      }
    } catch (e) {
      if (console && console.warn) console.warn('admin safeInit failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // ---------- Stable API exports (idempotent) ----------
  window.stiAdmin = window.stiAdmin || {};
  window.stiAdmin.seedDemoData = window.stiAdmin.seedDemoData || seedDemoData;
  window.stiAdmin.clearDemoData = window.stiAdmin.clearDemoData || clearDemoData;
  window.stiAdmin.renderQueue = window.stiAdmin.renderQueue || renderQueue;
  window.stiAdmin.refreshQueue = window.stiAdmin.refreshQueue || refreshQueue;
  window.stiAdmin.tryPopulateQueueFromBackend = window.stiAdmin.tryPopulateQueueFromBackend || tryPopulateQueueFromBackend;

  // attach local quick references
  api.seedDemoData = seedDemoData;
  api.clearDemoData = clearDemoData;
  api.renderQueue = renderQueue;
  api.refreshQueue = refreshQueue;
  api.tryPopulateQueueFromBackend = tryPopulateQueueFromBackend;

  // Testing hooks: allow injection of fetch/AbortController implementations
  api._setFetch = function (fn) { api._fetchOverride = fn; };
  api._setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
  api._resetOverrides = function () { delete api._fetchOverride; delete api._AbortControllerOverride; };

})();
