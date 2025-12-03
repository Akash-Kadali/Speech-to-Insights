// upload.js — Final corrected
// Handles presign PUT upload (preferred) with multipart POST fallback.
// Exposes window.sti.uploadFile and window.sti.upload.bindUploadForm for reuse by UI code.
(function () {
  'use strict';

  var sti = window.sti || (window.sti = {});
  sti.upload = sti.upload || {};

  // Config (override via window.STI)
  var PRESIGN_ENDPOINT = (window.STI && window.STI.PRESIGN_ENDPOINT) || '/presign';
  var UPLOAD_ENDPOINT = (window.STI && window.STI.UPLOAD_ENDPOINT) || '/upload';
  var START_WORKFLOW_ENDPOINT = (window.STI && window.STI.START_WORKFLOW_ENDPOINT) || null;
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || 4000;
  var DEFAULT_PRESIGN_EXPIRES = (window.STI && window.STI.PRESIGN_EXPIRES) || 900;

  // Simple toast helper (uses global showToast fallback)
  function toast(msg, t) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, t || 3000); } catch (e) { if (console) console.info('TOAST:', msg); }
    } else if (console) console.log('TOAST:', msg);
  }

  // Helper to fetch JSON/text with timeout
  function fetchWithTimeout(url, opts, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    opts = opts || {};
    opts.credentials = opts.credentials || 'same-origin';
    opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (res) {
        clearTimeout(id);
        return res.text().then(function (t) {
          var parsed = null;
          try { parsed = JSON.parse(t); } catch (e) { parsed = t; }
          if (!res.ok) {
            var err = new Error('Network response not ok: ' + res.status);
            err.status = res.status;
            err.body = parsed;
            throw err;
          }
          return parsed;
        });
      })
      .finally(function () { clearTimeout(id); });
  }

  // Try presign flow: GET /presign?filename=...&content_type=...&expires_in=...
  async function presignPut(file, presignEndpoint, presignExpires) {
    presignEndpoint = presignEndpoint || PRESIGN_ENDPOINT;
    presignExpires = typeof presignExpires === 'number' ? presignExpires : DEFAULT_PRESIGN_EXPIRES;
    var url = presignEndpoint + '?filename=' + encodeURIComponent(file.name)
      + '&content_type=' + encodeURIComponent(file.type || 'application/octet-stream')
      + '&expires_in=' + encodeURIComponent(presignExpires);
    var resp = await fetchWithTimeout(url, { method: 'GET' }, FETCH_TIMEOUT_MS);
    // Accept either { result: {...} } or {...}
    return (resp && resp.result) ? resp.result : resp;
  }

  // PUT the file to presigned URL
  async function putToPresign(putUrl, file, contentType) {
    var headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    var resp = await fetch(putUrl, { method: 'PUT', body: file, headers: headers });
    if (!resp.ok) {
      var txt = await resp.text().catch(function () { return ''; });
      throw new Error('PUT to presign URL failed: ' + resp.status + ' ' + txt);
    }
    return resp;
  }

  // Multipart fallback: POST /upload
  async function multipartUpload(file, uploadEndpoint, startWorkflow) {
    uploadEndpoint = uploadEndpoint || UPLOAD_ENDPOINT;
    var fd = new FormData();
    fd.append('file', file, file.name);
    if (startWorkflow) fd.append('start_workflow', 'true');
    var resp = await fetchWithTimeout(uploadEndpoint, { method: 'POST', body: fd }, FETCH_TIMEOUT_MS);
    // fetchWithTimeout returns parsed JSON or text; treat that as result
    return resp;
  }

  // Optional: notify start-workflow endpoint (best-effort)
  async function maybeStartWorkflow(s3_uri, upload_id) {
    var endpoint = START_WORKFLOW_ENDPOINT;
    if (!endpoint) return null;
    try {
      var resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3_uri: s3_uri, upload_id: upload_id })
      }, FETCH_TIMEOUT_MS);
      return resp;
    } catch (e) {
      // not fatal; just log
      if (console && console.debug) console.debug('maybeStartWorkflow failed', e);
      return null;
    }
  }

  // Public API to upload a File object. Options:
  // { presignEndpoint, uploadEndpoint, startWorkflow, presignExpires }
  async function uploadFile(file, options) {
    options = options || {};
    var startWorkflow = !!options.startWorkflow;
    var presignEndpoint = options.presignEndpoint || PRESIGN_ENDPOINT;
    var uploadEndpoint = options.uploadEndpoint || UPLOAD_ENDPOINT;
    var presignExpires = typeof options.presignExpires === 'number' ? options.presignExpires : DEFAULT_PRESIGN_EXPIRES;

    if (!file) return { ok: false, error: 'missing_file' };

    // Try presign flow
    try {
      var presignResult = await presignPut(file, presignEndpoint, presignExpires);
      var putUrl = presignResult && (presignResult.url || presignResult.presigned_url || presignResult.presign_url || presignResult.upload_url);
      if (putUrl) {
        try {
          toast('Uploading (presigned) — please wait', 1200);
          await putToPresign(putUrl, file, file.type);
          toast('Upload succeeded (presign).', 1200);
          try {
            await maybeStartWorkflow(presignResult.s3_uri || presignResult.s3Uri || presignResult.s3 || null,
              presignResult.upload_id || presignResult.uploadId || null);
          } catch (e) { /* ignore */ }
          return {
            ok: true,
            transport: 'presign',
            s3_uri: presignResult.s3_uri || presignResult.s3Uri || presignResult.s3 || null,
            upload_id: presignResult.upload_id || presignResult.uploadId || null,
            raw: presignResult
          };
        } catch (e) {
          console.warn('Presign put failed, falling back to multipart:', e && e.message ? e.message : e);
          // fall through to multipart
        }
      } else {
        // no usable presign URL returned; fallback
      }
    } catch (e) {
      // presign endpoint not available or failed — fall back
      if (console && console.debug) console.debug('Presign flow failed, falling back to multipart:', e && e.message ? e.message : e);
    }

    // Multipart fallback
    try {
      toast('Uploading (multipart) — please wait', 1200);
      var result = await multipartUpload(file, uploadEndpoint, startWorkflow);
      toast('Upload finished', 1200);
      return { ok: true, transport: 'multipart', result: result };
    } catch (e) {
      var errMsg = (e && e.message) || String(e);
      toast('Upload failed: ' + errMsg, 4000);
      return { ok: false, error: errMsg };
    }
  }

  // UI wiring for quick-upload components: binds file input + trigger + drag/drop
  function bindUploadForm(opts) {
    opts = opts || {};
    var uploadInput = document.getElementById(opts.inputId || 'upload-file') || document.querySelector('input[type="file"][data-upload]');
    var uploadTrigger = document.getElementById(opts.triggerId || 'upload-trigger') || document.querySelector('[data-upload-trigger]');
    var uploadForm = document.getElementById(opts.formId || 'upload-form');

    if (!uploadInput || !uploadTrigger) return;

    if (uploadTrigger.__bound) return;
    uploadTrigger.__bound = true;

    uploadTrigger.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (!uploadInput.files || !uploadInput.files.length) {
        toast('Choose a file to upload', 1600);
        return;
      }
      var file = uploadInput.files[0];
      uploadTrigger.disabled = true;
      uploadFile(file, {
        startWorkflow: (uploadInput.dataset && uploadInput.dataset.startWorkflow === 'true') || !!opts.startWorkflow,
        presignEndpoint: (uploadInput.dataset && uploadInput.dataset.presignEndpoint) || opts.presignEndpoint,
        uploadEndpoint: (uploadInput.dataset && uploadInput.dataset.uploadEndpoint) || opts.uploadEndpoint,
        presignExpires: (uploadInput.dataset && uploadInput.dataset.presignExpires) ? parseInt(uploadInput.dataset.presignExpires, 10) : opts.presignExpires
      }).then(function (res) {
        uploadTrigger.disabled = false;
        if (res && res.ok) {
          toast('Upload succeeded.', 1800);
          // append to recent sessions list if present
          try {
            var list = document.getElementById('recent-sessions') || document.getElementById('recent-sessions-list');
            if (list) {
              var li = document.createElement('li');
              li.textContent = (file.name + ' — uploaded');
              list.insertBefore(li, list.firstChild);
            }
          } catch (e) {}
        } else {
          toast('Upload failed: ' + (res && res.error ? res.error : 'unknown'), 4000);
        }
      }).catch(function (err) {
        uploadTrigger.disabled = false;
        toast('Upload error: ' + String(err), 4000);
      });
    }, { passive: false });

    // Drag & drop support
    var dropArea = document.getElementById(opts.dropId || 'upload-drop-area');
    if (dropArea && !dropArea.__bound) {
      dropArea.addEventListener('drop', function (ev) {
        ev.preventDefault();
        var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (!f) return;
        try {
          if (uploadInput) {
            try {
              var dt = new DataTransfer();
              dt.items.add(f);
              uploadInput.files = dt.files;
              uploadTrigger.click();
              return;
            } catch (e) {
              // fallback: call uploadFile directly
              uploadFile(f, {
                startWorkflow: (uploadInput.dataset && uploadInput.dataset.startWorkflow === 'true') || !!opts.startWorkflow,
                presignEndpoint: (uploadInput.dataset && uploadInput.dataset.presignEndpoint) || opts.presignEndpoint,
                uploadEndpoint: (uploadInput.dataset && uploadInput.dataset.uploadEndpoint) || opts.uploadEndpoint
              });
              return;
            }
          } else {
            uploadFile(f, { startWorkflow: !!opts.startWorkflow });
          }
        } catch (e) {
          console.warn('drop upload failed', e);
        }
      }, false);
      dropArea.addEventListener('dragover', function (ev) { ev.preventDefault(); }, false);
      dropArea.__bound = true;
    }

    // Inline form submit handling
    if (uploadForm && !uploadForm.__handled) {
      uploadForm.addEventListener('submit', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        uploadTrigger.click();
      });
      uploadForm.__handled = true;
    }
  }

  // Auto-init on DOM ready
  function safeInit() {
    bindUploadForm();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeInit);
  else safeInit();

  // Expose API
  sti.uploadFile = uploadFile;
  sti.upload.bindUploadForm = bindUploadForm;
})();
