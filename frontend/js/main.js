// main.js — sitewide behaviors: theme, upload helper, small utilities
(function () {
  'use strict';

  // -- Small stable namespace for reuse/debugging
  var sti = window.sti || (window.sti = {});
  var api = sti.main || (sti.main = {});

  // -- Theme helpers
  function getThemeLink() {
    return document.getElementById('theme-link');
  }

  function setTheme(href) {
    var tl = getThemeLink();
    if (!tl) return false;
    tl.setAttribute('href', href);
    try { localStorage.setItem('sti-theme', href); } catch (e) { /* ignore storage errors */ }
    return true;
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

  // -- Lightweight toast fallback (if toast.js missing)
  function ensureToast() {
    if (typeof window.showToast === 'function') return;
    window.showToast = function (message, timeout) {
      // non-intrusive fallback: console + short alert when focused
      try {
        if (console && console.log) console.log('TOAST:', message);
        // best-effort render into #toast element if present
        var t = document.getElementById('toast');
        if (t) {
          t.textContent = message;
          t.classList.add('visible');
          timeout = typeof timeout === 'number' ? timeout : 3000;
          setTimeout(function () { t.classList.remove('visible'); }, timeout);
          return;
        }
      } catch (e) { /* ignore */ }
      try { /* last resort */ alert(message); } catch (e) {}
    };
  }

  // -- Fetch helpers
  async function fetchJson(url, opts) {
    try {
      var res = await fetch(url, opts);
      var text = await res.text();
      try { return { status: res.status, ok: res.ok, json: JSON.parse(text) }; }
      catch (e) { return { status: res.status, ok: res.ok, text: text }; }
    } catch (err) {
      return { status: 0, ok: false, error: String(err) };
    }
  }

  // -- Upload helper: try presign (PUT) then multipart POST fallback
  async function uploadFile(file, options) {
    options = options || {};
    var presignEndpoint = options.presignEndpoint || '/presign';
    var uploadEndpoint = options.uploadEndpoint || '/upload';
    var startWorkflow = !!options.startWorkflow;

    if (!file) throw new Error('uploadFile: missing file');

    // try presign
    try {
      var qs = '?filename=' + encodeURIComponent(file.name) + '&content_type=' + encodeURIComponent(file.type || 'application/octet-stream');
      var presign = await fetchJson(presignEndpoint + qs, { method: 'GET', credentials: 'same-origin' });
      if (presign && presign.ok && presign.json && presign.json.result && presign.json.result.url) {
        var putRes = await fetch(presign.json.result.url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
        if (!putRes.ok) throw new Error('Presigned PUT failed: ' + putRes.status);
        return { ok: true, transport: 'presign', s3_uri: presign.json.result.s3_uri, upload_id: presign.json.result.upload_id };
      }
    } catch (e) {
      // silent fallback to multipart below
    }

    // fallback: multipart POST
    try {
      var fd = new FormData();
      fd.append('file', file, file.name);
      if (startWorkflow) fd.append('start_workflow', 'true');
      var post = await fetch(uploadEndpoint, { method: 'POST', body: fd, credentials: 'same-origin' });
      var txt = await post.text();
      try { return { ok: post.ok, transport: 'multipart', status: post.status, json: JSON.parse(txt) }; }
      catch (e) { return { ok: post.ok, transport: 'multipart', status: post.status, text: txt }; }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // -- Wire file inputs with data-upload attribute to the upload helper
  function wireAutoUploads() {
    // use a NodeList snapshot to avoid live-list mutation problems
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input[type="file"][data-upload]'));
    inputs.forEach(function (el) {
      if (el.__stiBound) return;
      el.addEventListener('change', async function () {
        var files = el.files || [];
        if (!files.length) return;
        var trigger = document.querySelector('[data-upload-trigger="' + el.id + '"]') || el;
        try {
          trigger.disabled = true;
          ensureToast();
          window.showToast('Uploading...', 1200);

          var res = await uploadFile(files[0], {
            presignEndpoint: el.dataset.presignEndpoint || '/presign',
            uploadEndpoint: el.dataset.uploadEndpoint || '/upload',
            startWorkflow: el.dataset.startWorkflow === 'true'
          });

          if (res && res.ok) {
            window.showToast('Upload succeeded', 1600);
          } else {
            var msg = (res && (res.error || (res.json && JSON.stringify(res.json)) || res.text)) || 'unknown';
            window.showToast('Upload failed: ' + msg, 3000);
          }
        } catch (err) {
          window.showToast('Upload error: ' + String(err), 3000);
        } finally {
          try { trigger.disabled = false; } catch (e) {}
        }
      }, { passive: true });
      el.__stiBound = true;
    });
  }

  // -- Theme toggle initialization (idempotent)
  function initThemeToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn || btn.__stiBound) return;
    btn.addEventListener('click', function () {
      toggleTheme();
    }, { passive: true });
    btn.__stiBound = true;

    // restore saved theme if present
    try {
      var stored = localStorage.getItem('sti-theme');
      if (stored) setTheme(stored);
    } catch (e) { /* ignore */ }
  }

  // -- Safe initialization on DOM ready
  function safeInit() {
    ensureToast();
    initThemeToggle();
    wireAutoUploads();

    // Expose utilities for debugging/scripts
    api.toggleTheme = toggleTheme;
    api.setTheme = setTheme;
    api.uploadFile = uploadFile;
    api.fetchJson = fetchJson;
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
