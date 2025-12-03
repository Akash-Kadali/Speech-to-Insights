// main.js — sitewide behaviors: theme, upload helper, small utilities
// Place in /frontend/js/main.js and ensure HTML references match.
(function () {
  'use strict';

  // -- Small stable namespace for reuse/debugging
  var sti = window.sti || (window.sti = {});
  var api = sti.main || (sti.main = {});

  // ---- Configuration (override via window.STI if needed) ----
  var DEFAULT_PRESIGN = (window.STI && window.STI.PRESIGN_ENDPOINT) || '/presign';
  var DEFAULT_UPLOAD = (window.STI && window.STI.UPLOAD_ENDPOINT) || '/upload';
  var DEFAULT_FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || 3000;
  var DEFAULT_PRESIGN_EXPIRES = (window.STI && window.STI.PRESIGN_EXPIRES) || 900;

  // ---- Theme helpers ----
  function getThemeLink() {
    return document.getElementById('theme-link');
  }

  function setTheme(href) {
    var tl = getThemeLink();
    if (!tl) return false;
    try {
      tl.setAttribute('href', href);
      try { localStorage.setItem('sti-theme', href); } catch (e) { /* ignore storage errors */ }
      return true;
    } catch (e) {
      console.warn('setTheme failed', e);
      return false;
    }
  }

  function toggleTheme() {
    var tl = getThemeLink();
    if (!tl) return;
    var curr = tl.getAttribute('href') || '/css/theme-light.css';
    var next = curr.indexOf('dark') !== -1 ? '/css/theme-light.css' : '/css/theme-dark.css';
    setTheme(next);
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.setAttribute('aria-pressed', String(next.indexOf('dark') !== -1));
    return next;
  }

  // ---- Lightweight toast fallback (if toast.js missing) ----
  function ensureToast() {
    if (typeof window.showToast === 'function') return;
    window.showToast = function (message, timeout) {
      try {
        if (console && console.log) console.log('TOAST:', message);
        var t = document.getElementById('toast');
        if (t) {
          t.textContent = message;
          t.classList.add('visible');
          timeout = typeof timeout === 'number' ? timeout : 3000;
          setTimeout(function () { t.classList.remove('visible'); }, timeout);
          return;
        }
      } catch (e) { /* ignore */ }
      try { alert(message); } catch (e) {}
    };
  }

  // ---- Fetch helpers ----
  function fetchJson(url, opts) {
    return fetch(url, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          try { return { status: res.status, ok: res.ok, json: JSON.parse(text) }; }
          catch (e) { return { status: res.status, ok: res.ok, text: text }; }
        });
      })
      .catch(function (err) {
        return { status: 0, ok: false, error: String(err) };
      });
  }

  function fetchJsonWithTimeout(url, opts, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    opts = opts || {};
    opts.signal = controller.signal;
    opts.credentials = opts.credentials || 'same-origin';
    return fetch(url, opts)
      .then(function (res) {
        clearTimeout(id);
        return res.text().then(function (text) {
          try { return { status: res.status, ok: res.ok, json: JSON.parse(text) }; }
          catch (e) { return { status: res.status, ok: res.ok, text: text }; }
        });
      })
      .catch(function (err) {
        clearTimeout(id);
        return { status: 0, ok: false, error: String(err) };
      });
  }

  // ---- Upload helper: try presign (PUT) then multipart POST fallback ----
  // Returns a normalized result object: { ok: boolean, transport: 'presign'|'multipart'|'error', ... }
  async function uploadFile(file, options) {
    options = options || {};
    var presignEndpoint = options.presignEndpoint || DEFAULT_PRESIGN;
    var uploadEndpoint = options.uploadEndpoint || DEFAULT_UPLOAD;
    var startWorkflow = !!options.startWorkflow;
    var presignExpires = typeof options.presignExpires === 'number' ? options.presignExpires : DEFAULT_PRESIGN_EXPIRES;

    if (!file) throw new Error('uploadFile: missing file');

    // Attempt presign -> PUT
    try {
      var qs = '?filename=' + encodeURIComponent(file.name)
             + '&content_type=' + encodeURIComponent(file.type || 'application/octet-stream')
             + '&expires_in=' + encodeURIComponent(presignExpires)
             + (startWorkflow ? '&start_workflow=true' : '');
      var presignResp = await fetchJsonWithTimeout(presignEndpoint + qs, { method: 'GET' }, DEFAULT_FETCH_TIMEOUT_MS);
      if (presignResp && presignResp.ok && presignResp.json) {
        var presignResult = presignResp.json.result || presignResp.json;
        // Accept both url or presigned_url
        var putUrl = (presignResult && (presignResult.url || presignResult.presigned_url || presignResult.presign_url || presignResult.upload_url));
        if (putUrl) {
          var headers = {};
          if (file.type) headers['Content-Type'] = file.type;
          // Try PUT directly
          var putRes = await fetch(putUrl, { method: 'PUT', body: file, headers: headers });
          if (putRes && (putRes.ok || putRes.status === 200 || putRes.status === 201)) {
            return {
              ok: true,
              transport: 'presign',
              s3_uri: presignResult.s3_uri || presignResult.s3Uri || presignResult.bucket_path || null,
              upload_id: presignResult.upload_id || presignResult.uploadId || null,
              raw: presignResult
            };
          } else {
            // PUT failed — fall through to multipart fallback
            console.warn('Presign PUT failed (status=' + (putRes && putRes.status) + '), falling back to multipart.');
          }
        } else {
          // No usable URL returned; fall back
          console.info('Presign response missing URL; falling back to multipart.', presignResult);
        }
      } else {
        if (presignResp && !presignResp.ok && presignResp.status) {
          console.info('Presign endpoint returned status', presignResp.status, presignResp.text || presignResp.error);
        }
      }
    } catch (e) {
      // silent fallback to multipart
      console.info('Presign flow failed, falling back to multipart:', e && e.message ? e.message : e);
    }

    // Fallback: multipart POST to uploadEndpoint
    try {
      var fd = new FormData();
      fd.append('file', file, file.name);
      if (startWorkflow) fd.append('start_workflow', 'true');

      var postResp = await fetch(uploadEndpoint, { method: 'POST', body: fd, credentials: 'same-origin' });
      var text = await postResp.text();
      try {
        var json = JSON.parse(text);
        return { ok: postResp.ok, transport: 'multipart', status: postResp.status, json: json };
      } catch (e) {
        return { ok: postResp.ok, transport: 'multipart', status: postResp.status, text: text };
      }
    } catch (err) {
      return { ok: false, transport: 'error', error: String(err) };
    }
  }

  // ---- Wire file inputs with data-upload attribute to the upload helper ----
  function wireAutoUploads() {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"][data-upload]'));
    inputs.forEach(function (el) {
      if (el.__stiBound) return;
      el.addEventListener('change', async function () {
        var files = el.files || [];
        if (!files.length) return;
        var triggerSelector = el.dataset.uploadTrigger;
        var trigger = triggerSelector ? document.querySelector(triggerSelector) : (document.querySelector('[data-upload-trigger="' + el.id + '"]') || el);
        try {
          if (trigger) trigger.disabled = true;
          ensureToast();
          window.showToast('Uploading...', 1200);

          var res = await uploadFile(files[0], {
            presignEndpoint: el.dataset.presignEndpoint || DEFAULT_PRESIGN,
            uploadEndpoint: el.dataset.uploadEndpoint || DEFAULT_UPLOAD,
            startWorkflow: el.dataset.startWorkflow === 'true' || el.dataset.startWorkflow === '1',
            presignExpires: el.dataset.presignExpires ? parseInt(el.dataset.presignExpires, 10) : undefined
          });

          if (res && res.ok) {
            window.showToast('Upload succeeded', 1600);
            // optional callback hook: window.STI.onUploadSuccess
            try {
              if (window.STI && typeof window.STI.onUploadSuccess === 'function') window.STI.onUploadSuccess(res);
            } catch (e) { /* ignore callback errors */ }
          } else {
            var msg = 'unknown';
            if (res) {
              msg = res.error || (res.json && (res.json.error || JSON.stringify(res.json))) || res.text || JSON.stringify(res);
            }
            window.showToast('Upload failed: ' + msg, 6000);
            try {
              if (window.STI && typeof window.STI.onUploadFailure === 'function') window.STI.onUploadFailure(res);
            } catch (e) { /* ignore */ }
          }
        } catch (err) {
          window.showToast('Upload error: ' + String(err), 6000);
        } finally {
          try { if (trigger) trigger.disabled = false; } catch (e) {}
        }
      }, { passive: true });
      el.__stiBound = true;
    });
  }

  // ---- Theme toggle initialization (idempotent) ----
  function initThemeToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn || btn.__stiBound) return;
    btn.addEventListener('click', function () { toggleTheme(); }, { passive: true });
    btn.__stiBound = true;

    // restore saved theme if present
    try {
      var stored = localStorage.getItem('sti-theme');
      if (stored) setTheme(stored);
    } catch (e) { /* ignore */ }
  }

  // ---- Safe initialization on DOM ready ----
  function safeInit() {
    ensureToast();
    initThemeToggle();
    wireAutoUploads();

    // Expose utilities for debugging/scripts
    api.toggleTheme = toggleTheme;
    api.setTheme = setTheme;
    api.uploadFile = uploadFile;
    api.fetchJson = fetchJson;
    api.fetchJsonWithTimeout = fetchJsonWithTimeout;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // export to window.sti
  sti.uploadFile = sti.uploadFile || api.uploadFile;
  sti.fetchJson = sti.fetchJson || api.fetchJson;
  sti.toggleTheme = sti.toggleTheme || api.toggleTheme;
  sti.main = api;
})();
