// overview.js — Final corrected
// Minimal behaviors for the Overview page. Reuses upload and dashboard logic where available.
// Provides quick upload wiring and a robust session preview that degrades gracefully.
(function () {
  'use strict';

  var sti = window.sti || (window.sti = {});
  sti.overview = sti.overview || {};

  // Configurable endpoints (override via window.STI if needed)
  var SESSIONS_ENDPOINT = (window.STI && window.STI.SESSIONS_ENDPOINT) || window.STI_SESSIONS_ENDPOINT || '/sessions';
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || 2500;

  // Normalize endpoint
  if (Array.isArray(SESSIONS_ENDPOINT)) SESSIONS_ENDPOINT = SESSIONS_ENDPOINT[0];

  function safeToast(msg, t) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, t || 2000); } catch (e) { if (console && console.info) console.info('Toast:', msg); }
    } else if (console && console.info) {
      console.info('Toast:', msg);
    }
  }

  // Helper: try parse JSON or return null
  function _tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Simple fetch with timeout returning parsed JSON or null on failure
  function fetchJsonWithTimeout(url, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, { method: 'GET', credentials: 'same-origin', signal: controller.signal })
      .then(function (res) {
        clearTimeout(id);
        if (!res.ok) {
          if (console && console.info) console.info('fetch failed', url, res.status);
          throw new Error('Network response not ok: ' + res.status);
        }
        return res.text().then(function (txt) {
          // try json, jsonl first-line, else null
          var p = _tryParseJson(txt);
          if (p !== null) return p;
          var first = (txt || '').split(/\r?\n/).find(Boolean) || '';
          p = _tryParseJson(first);
          if (p !== null) return p;
          return null;
        });
      })
      .catch(function (err) {
        clearTimeout(id);
        // non-fatal: log and return null
        if (console && console.debug) console.debug('fetchJsonWithTimeout failed for', url, err && err.message ? err.message : err);
        return null;
      });
  }

  // Populate the "recent sessions" list; accepts optional limit param
  async function populatePreview(limit) {
    limit = typeof limit === 'number' ? limit : 5;
    var listEl = document.getElementById('recent-sessions') || document.getElementById('recent-sessions-list');
    if (!listEl) return;

    // show loading placeholder
    listEl.innerHTML = '';
    var loading = document.createElement('li');
    loading.className = 'muted';
    loading.textContent = 'Loading sessions...';
    listEl.appendChild(loading);

    // try a few endpoint shapes: /sessions?limit=5 or /sessions?size=5
    var urls = [
      SESSIONS_ENDPOINT + '?limit=' + encodeURIComponent(limit),
      SESSIONS_ENDPOINT + '?size=' + encodeURIComponent(limit),
      SESSIONS_ENDPOINT
    ];

    var data = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        data = await fetchJsonWithTimeout(urls[i]);
      } catch (e) {
        data = null;
      }
      if (data) break;
    }

    listEl.innerHTML = '';
    if (!data) {
      // fallback demo entry
      var li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Sessions API not available — showing demo data';
      listEl.appendChild(li);
      return;
    }

    var arr = Array.isArray(data) ? data : (Array.isArray(data.sessions) ? data.sessions : (Array.isArray(data.items) ? data.items : []));
    if (!arr || arr.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'muted';
      empty.textContent = 'No sessions found';
      listEl.appendChild(empty);
      return;
    }

    arr.slice(0, limit).forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'overview-session';

      var title = document.createElement('a');
      var id = s && (s.id || s.session_id || s.upload_id || s.key || s.name) || '';
      title.textContent = (s && (s.title || s.name)) || id || 'Session';
      // link to session detail page if exists
      try { title.href = '/sessions.html#' + encodeURIComponent(id); } catch (e) { title.href = '#'; }
      title.setAttribute('aria-label', title.textContent);
      li.appendChild(title);

      var meta = document.createElement('div');
      meta.className = 'muted small';
      var status = (s && (s.status || s.state)) || 'unknown';
      var duration = '';
      try {
        var dur = (s && s.meta && s.meta.duration) ? s.meta.duration : (s && s.duration ? s.duration : null);
        if (dur != null) duration = ' • ' + Math.round(Number(dur)) + 's';
      } catch (e) { duration = ''; }
      meta.textContent = status + (duration || '');
      li.appendChild(meta);

      // optional snippet or summary
      if (s && (s.summary || s.snippet || s.excerpt || (s.transcript && s.transcript.slice))) {
        var snippet = document.createElement('p');
        snippet.className = 'small';
        var text = s.summary || s.snippet || s.excerpt || (typeof s.transcript === 'string' ? s.transcript.slice(0, 200) : '');
        snippet.textContent = (text || '').replace(/\s+/g, ' ').trim();
        li.appendChild(snippet);
      }

      listEl.appendChild(li);
    });
  }

  // Wire quick upload if upload API exists (delegates to sti.upload if present)
  function wireQuickUpload() {
    // prefer existing upload binding from upload.js
    if (sti.upload && typeof sti.upload.bindUploadForm === 'function') {
      try { sti.upload.bindUploadForm(); } catch (e) { if (console && console.warn) console.warn('bindUploadForm error', e); }
      return;
    }

    // fallback: wire inputs with data-upload attribute via sti.main.uploadFile if available
    var fileInputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"][data-upload]'));
    if (!fileInputs.length) return;
    fileInputs.forEach(function (el) {
      if (el.__overviewBound) return;
      el.addEventListener('change', async function () {
        var files = el.files || [];
        if (!files.length) return;
        try {
          safeToast('Uploading...', 1200);
          if (sti.main && typeof sti.main.uploadFile === 'function') {
            var res = await sti.main.uploadFile(files[0], {
              presignEndpoint: el.dataset.presignEndpoint || undefined,
              uploadEndpoint: el.dataset.uploadEndpoint || undefined,
              startWorkflow: el.dataset.startWorkflow === 'true'
            });
            if (res && res.ok) {
              safeToast('Upload requested', 1400);
              // refresh preview to catch newly uploaded session
              setTimeout(function () { populatePreview(5); }, 1200);
            } else {
              var msg = (res && (res.error || (res.json && JSON.stringify(res.json)) || res.text)) || 'Upload failed';
              safeToast(msg, 4000);
            }
          } else {
            safeToast('Upload support not available in this environment', 2600);
          }
        } catch (e) {
          safeToast('Upload failed', 3000);
          if (console && console.warn) console.warn('overview upload failed', e);
        }
      }, { passive: true });
      el.__overviewBound = true;
    });
  }

  // Public refresh handler
  async function refresh(limit) {
    await populatePreview(typeof limit === 'number' ? limit : 5);
  }

  // Init on DOM ready
  function init() {
    // kick off dashboard refresh if available
    if (sti.dashboard && typeof sti.dashboard.refresh === 'function') {
      try { sti.dashboard.refresh(); } catch (e) { if (console && console.warn) console.warn('dashboard.refresh error', e); }
    }
    wireQuickUpload();
    populatePreview(5).catch(function (e) { if (console && console.warn) console.warn('populatePreview error', e); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Expose API
  sti.overview.populatePreview = populatePreview;
  sti.overview.refresh = refresh;
  sti.overview.init = init;
})();
