// search.js — Final corrected
// Lightweight search UI: tries POST /search then GET /search?q=...
// Defensive, accessible, debounced input, and exposes a stable API on window.sti.search.
(function () {
  'use strict';

  var sti = window.sti || (window.sti = {});
  sti.search = sti.search || {};

  // Config: override via window.STI if needed
  var SEARCH_POST_ENDPOINT = (window.STI && window.STI.SEARCH_POST_ENDPOINT) || window.STI_SEARCH_POST_ENDPOINT || '/search';
  var SEARCH_GET_ENDPOINT = (window.STI && window.STI.SEARCH_GET_ENDPOINT) || window.STI_SEARCH_GET_ENDPOINT || '/search';
  var DEBOUNCE_MS = (window.STI && window.STI.SEARCH_DEBOUNCE_MS) || 250;
  var DEFAULT_TOP_K = (window.STI && window.STI.SEARCH_TOP_K) || 10;
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || 4000;

  // Normalize endpoints
  if (Array.isArray(SEARCH_POST_ENDPOINT)) SEARCH_POST_ENDPOINT = SEARCH_POST_ENDPOINT[0];
  if (Array.isArray(SEARCH_GET_ENDPOINT)) SEARCH_GET_ENDPOINT = SEARCH_GET_ENDPOINT[0];

  // Utility: safe toast
  function toast(msg, t) {
    if (typeof window.showToast === 'function') return window.showToast(msg, t || 3000);
    try { if (console && console.log) console.log('TOAST:', msg); } catch (e) {}
  }

  // Render helpers
  function _makeMuted(text) {
    var li = document.createElement('li');
    li.className = 'muted';
    li.textContent = text;
    return li;
  }

  function renderResults(container, items) {
    if (!container) return;
    container.innerHTML = '';
    if (!items || items.length === 0) {
      container.appendChild(_makeMuted('No results'));
      return;
    }

    var frag = document.createDocumentFragment();
    items.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'search-result';
      li.setAttribute('role', 'article');

      var title = document.createElement('div');
      title.className = 'result-title';
      title.textContent = it.title || (it.meta && (it.meta.source || it.meta.name)) || (it.id || 'result');
      li.appendChild(title);

      var snippet = document.createElement('div');
      snippet.className = 'result-snippet';
      var s = it.snippet || it.text || (it.meta && it.meta.text) || '';
      snippet.textContent = (typeof s === 'string' && s.length > 300) ? (s.slice(0, 300) + '…') : s;
      li.appendChild(snippet);

      var meta = document.createElement('div');
      meta.className = 'result-meta muted small';
      var parts = [];
      if (it.meta && it.meta.start_time != null) parts.push('time: ' + String(it.meta.start_time));
      if (typeof it.score === 'number') parts.push('score: ' + Number(it.score).toFixed(3));
      meta.textContent = parts.join(' • ');
      li.appendChild(meta);

      // Click behavior: prefer direct url, else session navigation
      (function (item, node) {
        var targetUrl = item.url || (item.meta && item.meta.url) || null;
        var sessionId = (item.meta && (item.meta.session_id || item.meta.session)) || item.session_id || null;
        var chunkId = (item.meta && (item.meta.chunk_id || item.meta.chunk)) || null;

        if (targetUrl) {
          node.style.cursor = 'pointer';
          node.addEventListener('click', function () { window.location.href = targetUrl; }, { passive: true });
        } else if (sessionId) {
          node.style.cursor = 'pointer';
          node.addEventListener('click', function () {
            try { window.location.href = '/sessions.html#' + encodeURIComponent(sessionId); } catch (e) {}
          }, { passive: true });
        } else if (chunkId && (item.session_id || sessionId)) {
          var sid = item.session_id || sessionId;
          node.style.cursor = 'pointer';
          node.addEventListener('click', function () {
            try { window.location.href = '/sessions.html#' + encodeURIComponent(sid) + '?chunk=' + encodeURIComponent(chunkId); } catch (e) {}
          }, { passive: true });
        }
      } (it, li));

      frag.appendChild(li);
    });
    container.appendChild(frag);
  }

  // Robust fetch with timeout helper
  function fetchWithTimeout(url, opts, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    opts = opts || {};
    opts.signal = controller.signal;
    opts.credentials = opts.credentials || 'same-origin';
    return fetch(url, opts)
      .then(function (res) {
        clearTimeout(id);
        if (!res.ok) throw new Error('Network response not ok: ' + res.status);
        return res.json().catch(function () { return null; });
      })
      .finally(function () { clearTimeout(id); });
  }

  // Low-level search attempt: POST then GET fallback
  async function _postSearch(query, top_k) {
    var payload = { query: query, top_k: top_k || DEFAULT_TOP_K };
    var resp = await fetchWithTimeout(SEARCH_POST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }, FETCH_TIMEOUT_MS);
    return resp;
  }

  async function _getSearch(query, top_k) {
    var url = SEARCH_GET_ENDPOINT + '?q=' + encodeURIComponent(query) + '&top_k=' + encodeURIComponent(top_k || DEFAULT_TOP_K);
    var resp = await fetchWithTimeout(url, { method: 'GET' }, FETCH_TIMEOUT_MS);
    return resp;
  }

  // Public doSearch: returns { ok, items, error }
  async function doSearch(query, top_k) {
    if (!query || !String(query).trim()) return { ok: false, error: 'empty' };
    query = String(query).trim();
    top_k = top_k || DEFAULT_TOP_K;

    // Try POST first
    try {
      var res = await _postSearch(query, top_k);
      var items = Array.isArray(res) ? res : (res && (res.results || res.hits || res.items)) || [];
      return { ok: true, items: items };
    } catch (e) {
      // try GET fallback
      try {
        var res2 = await _getSearch(query, top_k);
        var items2 = Array.isArray(res2) ? res2 : (res2 && (res2.results || res2.hits || res2.items)) || [];
        return { ok: true, items: items2 };
      } catch (e2) {
        return { ok: false, error: 'endpoint_unavailable' };
      }
    }
  }

  // Debounce helper
  function _debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { try { fn.apply(null, args); } catch (e) { if (console) console.warn(e); } }, wait);
    };
  }

  // Bind search UI (form + input) and wire results container
  function bindSearchForm(options) {
    options = options || {};
    var form = document.getElementById(options.formId || 'search-form') || document.getElementById('query-form');
    var input = document.getElementById(options.inputId || 'search-input') || document.getElementById('query-input');
    var resultsList = document.getElementById(options.resultsId || 'search-results') || document.getElementById('results-list');

    if (!input || !resultsList) return null;
    if (form && form.__stiBound) return null;

    // performSearch renders and handles errors
    var performSearch = async function (q) {
      resultsList.innerHTML = '';
      resultsList.appendChild(_makeMuted('Searching...'));
      var r = await doSearch(q, options.top_k || DEFAULT_TOP_K);
      resultsList.innerHTML = '';
      if (!r.ok) {
        resultsList.appendChild(_makeMuted('Search not available. Try uploading sessions first.'));
        toast('Search endpoint not available', 1800);
        return;
      }
      renderResults(resultsList, r.items || []);
    };

    var debounced = _debounce(function () {
      var q = input.value || '';
      if (!q.trim()) {
        resultsList.innerHTML = '';
        resultsList.appendChild(_makeMuted('No query'));
        return;
      }
      performSearch(q);
    }, DEBOUNCE_MS);

    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var q = input.value || '';
        performSearch(q);
      }, { passive: true });
      form.__stiBound = true;
    } else {
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var q = input.value || '';
          performSearch(q);
        }
      }, { passive: true });
    }

    // live search on input with debounce (optional; disable via data-live="false")
    var live = input.getAttribute('data-live');
    if (live === null || live !== 'false') {
      input.addEventListener('input', debounced, { passive: true });
    }

    // Return a small controller for programmatic use
    var controller = {
      performSearch: performSearch,
      input: input,
      resultsList: resultsList,
      lastQuery: null
    };

    return controller;
  }

  // Initialization on DOM ready
  function safeInit() {
    try { bindSearchForm(); } catch (e) { if (console && console.warn) console.warn('search init failed', e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();

  // Expose API
  sti.search.perform = doSearch;
  sti.search.bind = bindSearchForm;
  sti.search._post = _postSearch;
  sti.search._get = _getSearch;
})();
