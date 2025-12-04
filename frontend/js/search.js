/**
 * search.js — Final corrected, defensive, accessible search UI
 * - Tries POST then GET endpoints
 * - Debounced input, keyboard-friendly results, robust timeouts/aborts
 * - Exposes stable API on window.sti.search
 * - Allows test injection: setFetch, setAbortController
 * - Emits CustomEvents: sti:search:started, sti:search:completed, sti:search:error
 */
(function () {
  'use strict';

  // ---------- Namespace & defaults ----------
  const sti = window.sti || (window.sti = {});
  sti.search = sti.search || {};
  const api = sti.search;

  const DEFAULTS = {
    POST_ENDPOINT: (window.STI && window.STI.SEARCH_POST_ENDPOINT) || window.STI_SEARCH_POST_ENDPOINT || '/search',
    GET_ENDPOINT: (window.STI && window.STI.SEARCH_GET_ENDPOINT) || window.STI_SEARCH_GET_ENDPOINT || '/search',
    DEBOUNCE_MS: (window.STI && window.STI.SEARCH_DEBOUNCE_MS) || 250,
    DEFAULT_TOP_K: (window.STI && window.STI.SEARCH_TOP_K) || 10,
    FETCH_TIMEOUT_MS: (window.STI && window.STI.FETCH_TIMEOUT_MS) || 4000,
    SELECTORS: {
      form: '#search-form',
      input: '#search-input',
      results: '#search-results'
    }
  };

  api._config = Object.assign({}, DEFAULTS);

  // Test hooks / overrides
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  // Optional item renderer override
  api.itemRenderer = api.itemRenderer || null; // function(item) -> DOM node or string

  // ---------- Utilities ----------
  function _log(...args) { if (typeof console !== 'undefined') console.debug('sti.search:', ...args); }
  function _toast(msg, t) {
    try { if (typeof window.showToast === 'function') return window.showToast(msg, t || 3000); } catch (e) {}
    if (typeof console !== 'undefined') console.info('TOAST:', msg);
  }

  function _safeParse(text) {
    if (text === undefined || text === null) return null;
    if (typeof text === 'object') return text;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // fetch with timeout + abort; returns parsed JSON or raw text; throws on non-OK
  async function _fetchWithTimeout(url, opts = {}, timeoutMs = api._config.FETCH_TIMEOUT_MS) {
    if (!url) throw new Error('fetch url required');

    const fetchFn = api._fetchOverride || window.fetch;
    if (typeof fetchFn !== 'function') throw new Error('fetch is not available');

    const AbortCtor = api._AbortControllerOverride || window.AbortController;
    const controller = AbortCtor ? new AbortCtor() : null;
    const merged = Object.assign({}, opts);
    if (controller) merged.signal = controller.signal;
    merged.credentials = merged.credentials || 'same-origin';

    let timer = null;
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(url, merged);
      const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const parsed = _safeParse(txt);
        const err = new Error(`Network error: ${res.status}`);
        err.status = res.status;
        err.body = parsed !== null ? parsed : txt;
        throw err;
      }
      const parsed = _safeParse(txt);
      if (parsed !== null) return parsed;
      // try first non-empty line (jsonl)
      const first = (txt || '').split(/\r?\n/).find(Boolean) || '';
      const fp = _safeParse(first);
      if (fp !== null) return fp;
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

  // ---------- Results rendering ----------
  function _makeMutedItem(text) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = String(text || '');
    li.setAttribute('aria-live', 'polite');
    return li;
  }

  function _createResultItem(item) {
    try {
      if (typeof api.itemRenderer === 'function') {
        const out = api.itemRenderer(item);
        if (out instanceof Node) return out;
        if (typeof out === 'string') {
          const wrapper = document.createElement('li');
          wrapper.innerHTML = out;
          wrapper.className = 'search-result';
          return wrapper;
        }
      }
    } catch (e) {
      _log('itemRenderer threw', e);
    }

    // default renderer
    const li = document.createElement('li');
    li.className = 'search-result';
    li.setAttribute('role', 'article');
    li.tabIndex = 0;

    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = item.title || item.name || (item.meta && (item.meta.name || item.meta.source)) || (item.id || 'Result');
    title.setAttribute('aria-label', title.textContent);
    li.appendChild(title);

    const snippet = document.createElement('div');
    snippet.className = 'result-snippet';
    const s = item.snippet || item.text || (item.meta && item.meta.text) || '';
    snippet.textContent = (typeof s === 'string' && s.length > 300) ? (s.slice(0, 300) + '…') : s;
    li.appendChild(snippet);

    const meta = document.createElement('div');
    meta.className = 'result-meta muted small';
    const parts = [];
    if (item.meta && item.meta.start_time != null) parts.push(`time: ${String(item.meta.start_time)}`);
    if (typeof item.score === 'number') parts.push(`score: ${Number(item.score).toFixed(3)}`);
    meta.textContent = parts.join(' • ');
    li.appendChild(meta);

    // navigation behavior
    const targetUrl = item.url || (item.meta && item.meta.url) || null;
    const sessionId = (item.meta && (item.meta.session_id || item.meta.session)) || item.session_id || null;
    const chunkId = (item.meta && (item.meta.chunk_id || item.meta.chunk)) || item.chunk_id || null;

    function _navigate() {
      if (targetUrl) {
        window.location.href = targetUrl;
        return;
      }
      if (sessionId) {
        const q = chunkId ? `?chunk=${encodeURIComponent(chunkId)}` : '';
        window.location.href = '/sessions.html#' + encodeURIComponent(sessionId) + q;
      }
    }

    li.addEventListener('click', _navigate, { passive: true });
    li.addEventListener('keypress', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        _navigate();
      }
    }, { passive: true });

    return li;
  }

  function renderResults(container, items) {
    if (!container) return;
    container.innerHTML = '';
    container.setAttribute('aria-live', 'polite');

    if (!Array.isArray(items) || items.length === 0) {
      container.appendChild(_makeMutedItem('No results'));
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach(it => {
      try {
        const node = _createResultItem(it);
        frag.appendChild(node);
      } catch (e) {
        _log('render item failed', e);
      }
    });
    container.appendChild(frag);
  }

  // ---------- Search endpoints & normalization ----------
  async function _postSearch(query, top_k) {
    const payload = { query: String(query), top_k: Number(top_k || api._config.DEFAULT_TOP_K) };
    return await _fetchWithTimeout(api._config.POST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, api._config.FETCH_TIMEOUT_MS);
  }

  async function _getSearch(query, top_k) {
    const url = `${api._config.GET_ENDPOINT}?q=${encodeURIComponent(String(query))}&top_k=${encodeURIComponent(Number(top_k || api._config.DEFAULT_TOP_K))}`;
    return await _fetchWithTimeout(url, { method: 'GET' }, api._config.FETCH_TIMEOUT_MS);
  }

  function _normalize(resp) {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    if (Array.isArray(resp.results)) return resp.results;
    if (Array.isArray(resp.hits)) return resp.hits;
    if (Array.isArray(resp.items)) return resp.items;
    // try common container keys
    if (resp.data && Array.isArray(resp.data)) return resp.data;
    return [];
  }

  // ---------- Public search API ----------
  async function performSearch(query, top_k) {
    if (!query || !String(query).trim()) return { ok: false, error: 'empty_query', items: [] };
    const q = String(query).trim();
    const k = Number(top_k || api._config.DEFAULT_TOP_K);

    document.dispatchEvent(new CustomEvent('sti:search:started', { detail: { query: q, top_k: k } }));
    _toast('Searching...', 1200);

    // Try POST then GET fallback
    try {
      const postResp = await _postSearch(q, k);
      const items = _normalize(postResp);
      document.dispatchEvent(new CustomEvent('sti:search:completed', { detail: { source: 'post', query: q, items } }));
      return { ok: true, items };
    } catch (postErr) {
      _log('post search failed, trying get', postErr);
      try {
        const getResp = await _getSearch(q, k);
        const items2 = _normalize(getResp);
        document.dispatchEvent(new CustomEvent('sti:search:completed', { detail: { source: 'get', query: q, items: items2 } }));
        return { ok: true, items: items2 };
      } catch (getErr) {
        _log('both search endpoints failed', postErr, getErr);
        document.dispatchEvent(new CustomEvent('sti:search:error', { detail: { query: q, error: getErr } }));
        return { ok: false, error: 'endpoints_unavailable', items: [] };
      }
    }
  }

  // ---------- Debounce helper ----------
  function _debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { fn.apply(this, args); } catch (e) { _log('debounced fn error', e); }
      }, wait);
    };
  }

  // ---------- UI binding ----------
  function bindSearchForm(opts = {}) {
    const cfg = api._config;
    const formId = opts.formId || cfg.SELECTORS.form;
    const inputId = opts.inputId || cfg.SELECTORS.input;
    const resultsId = opts.resultsId || cfg.SELECTORS.results;

    const form = document.querySelector(formId);
    const input = document.querySelector(inputId);
    const results = document.querySelector(resultsId);

    if (!input || !results) {
      _log('bindSearchForm: missing input or results container', inputId, resultsId);
      return null;
    }

    if (form && form.__stiSearchBound) return { form, input, results };

    async function doRun(q) {
      results.innerHTML = '';
      results.appendChild(_makeMutedItem('Searching...'));
      const out = await performSearch(q, opts.top_k || undefined);
      results.innerHTML = '';
      if (!out || out.ok === false) {
        results.appendChild(_makeMutedItem('Search unavailable. Upload sessions or check backend.'));
        _toast('Search endpoint not available', 1600);
        return;
      }
      renderResults(results, out.items || []);
    }

    const debounced = _debounce(() => {
      const q = input.value || '';
      if (!q.trim()) {
        results.innerHTML = '';
        results.appendChild(_makeMutedItem('No query'));
        return;
      }
      doRun(q);
    }, opts.debounceMs || api._config.DEBOUNCE_MS);

    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        const q = input.value || '';
        if (!q.trim()) {
          results.innerHTML = '';
          results.appendChild(_makeMutedItem('No query'));
          return;
        }
        doRun(q);
      }, { passive: true });
      form.__stiSearchBound = true;
    } else {
      // if no form, allow Enter on input to search
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          const q = input.value || '';
          if (!q.trim()) {
            results.innerHTML = '';
            results.appendChild(_makeMutedItem('No query'));
            return;
          }
          doRun(q);
        }
      }, { passive: true });
    }

    // live search by default; disable with data-live="false"
    const live = input.getAttribute('data-live');
    if (live === null || live !== 'false') {
      input.addEventListener('input', debounced, { passive: true });
    }

    return { form, input, results, perform: doRun };
  }

  // ---------- Safe init ----------
  function safeInit() {
    try { bindSearchForm(); } catch (e) { _log('safeInit failed', e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // ---------- Expose API ----------
  api.perform = performSearch;
  api.bind = bindSearchForm;
  api._post = _postSearch;
  api._get = _getSearch;
  api._normalize = _normalize;
  api._render = renderResults;
  api._config = api._config || DEFAULTS;

  // Test hooks & overrides
  api.setFetch = function (fn) { api._fetchOverride = fn; };
  api.setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
  api.setItemRenderer = function (fn) { api.itemRenderer = typeof fn === 'function' ? fn : null; };

  // Keep stable window export
  window.sti = window.sti || {};
  window.sti.search = window.sti.search || api;
})();
