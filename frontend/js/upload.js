/**
 * upload.js — Final upgraded
 * - Handles presign PUT upload (preferred) with multipart POST fallback.
 * - Defensive, configurable, timeout-safe, and test-friendly.
 * - Exposes window.sti.uploadFile and window.sti.upload.bindUploadForm
 * - Returns rich result objects for programmatic use.
 *
 * Notes:
 *  - For PUT progress reporting, pass options.useXhrForPut = true and options.onProgress callback.
 *  - Configure endpoints and timeouts via window.STI.* keys before script loads.
 */
(function () {
  'use strict';

  // ---------- Namespace & config ----------
  const sti = window.sti || (window.sti = {});
  sti.upload = sti.upload || {};
  const api = sti.upload;

  const PRESIGN_ENDPOINT = (window.STI && (window.STI.PRESIGN_ENDPOINT || window.STI.PRESIGN)) || window.STI_PRESIGN_ENDPOINT || '/presign';
  const UPLOAD_ENDPOINT = (window.STI && (window.STI.UPLOAD_ENDPOINT || window.STI.UPLOAD)) || window.STI_UPLOAD_ENDPOINT || '/upload';
  const START_WORKFLOW_ENDPOINT = (window.STI && window.STI.START_WORKFLOW_ENDPOINT) || window.STI_START_WORKFLOW_ENDPOINT || null;
  const FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || window.STI_FETCH_TIMEOUT_MS || 4000;
  const DEFAULT_PRESIGN_EXPIRES = (window.STI && window.STI.PRESIGN_EXPIRES) || window.STI_PRESIGN_EXPIRES || 900;

  // ---------- Small utilities ----------
  function _now() { return Date.now(); }

  function _toast(msg, t) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg, t || 3000);
    } catch (_) {}
    if (typeof console !== 'undefined') console.info('TOAST:', msg);
  }

  function _safeParseJson(text) {
    try { return (typeof text === 'string' && text.length) ? JSON.parse(text) : text; } catch (_) { return text; }
  }

  function _buildQuery(obj) {
    return Object.keys(obj || {}).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(obj[k]))}`).join('&');
  }

  // fetch with timeout and safe parse; returns parsed JSON if possible else raw text
  async function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    if (!url) throw new Error('fetchWithTimeout: missing url');
    const controller = new AbortController();
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const merged = Object.assign({}, opts, { credentials: opts.credentials || 'same-origin', signal });
    try {
      const res = await fetch(url, merged);
      clearTimeout(timer);
      const txt = await res.text().catch(() => '');
      const parsed = _safeParseJson(txt);
      if (!res.ok) {
        const err = new Error('Network response not ok: ' + res.status);
        err.status = res.status;
        err.body = parsed !== undefined ? parsed : txt;
        throw err;
      }
      return parsed !== undefined ? parsed : txt;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Presign flow ----------
  // Returns normalized presign object or throws
  async function presignPut(file, presignEndpoint = PRESIGN_ENDPOINT, presignExpires = DEFAULT_PRESIGN_EXPIRES, opts = {}) {
    if (!file) throw new Error('presignPut: missing file');
    const query = _buildQuery({
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      expires_in: presignExpires,
      ...(opts.startWorkflow ? { start_workflow: 'true' } : {})
    });
    const url = presignEndpoint + (presignEndpoint.indexOf('?') === -1 ? ('?' + query) : ('&' + query));
    const resp = await fetchWithTimeout(url, { method: 'GET' }, opts.fetchTimeout || FETCH_TIMEOUT_MS);
    // Support shapes: { result: {...} } or direct object
    return (resp && resp.result) ? resp.result : resp;
  }

  // PUT using fetch (no progress). Returns response object or throws.
  async function putToPresignFetch(putUrl, file, contentType) {
    if (!putUrl) throw new Error('putToPresignFetch: missing putUrl');
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(putUrl, { method: 'PUT', body: file, headers });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error('PUT to presign URL failed: ' + res.status);
      err.status = res.status;
      err.body = txt;
      throw err;
    }
    return res;
  }

  // PUT using XHR when progress callback is provided or explicitly requested
  function putToPresignXhr(putUrl, file, contentType, onProgress, timeoutMs) {
    return new Promise((resolve, reject) => {
      try {
        const xhr = new XMLHttpRequest();
        let timer = null;
        xhr.open('PUT', putUrl, true);
        if (contentType) xhr.setRequestHeader('Content-Type', contentType);
        xhr.withCredentials = true;

        xhr.upload && onProgress && xhr.upload.addEventListener('progress', (ev) => {
          if (ev.lengthComputable) {
            try { onProgress({ loaded: ev.loaded, total: ev.total, percent: Math.round((ev.loaded / ev.total) * 100) }); } catch (_) {}
          }
        }, { passive: true });

        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          if (timer) clearTimeout(timer);
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ status: xhr.status, statusText: xhr.statusText, responseText: xhr.responseText });
          } else {
            const err = new Error('PUT to presign failed: ' + xhr.status);
            err.status = xhr.status;
            err.body = xhr.responseText;
            reject(err);
          }
        };
        xhr.onerror = function (e) {
          if (timer) clearTimeout(timer);
          const err = new Error('Network error during PUT');
          reject(err);
        };
        // timeout fallback (XHR timeout isn't always reliable across environments)
        if (timeoutMs && typeof timeoutMs === 'number') {
          timer = setTimeout(() => {
            try { xhr.abort(); } catch (_) {}
            const err = new Error('PUT to presign timed out');
            err.name = 'TimeoutError';
            reject(err);
          }, timeoutMs);
        }
        xhr.send(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  // ---------- Multipart fallback ----------
  async function multipartUpload(file, uploadEndpoint = UPLOAD_ENDPOINT, startWorkflow = false, timeoutMs = FETCH_TIMEOUT_MS) {
    if (!file) throw new Error('multipartUpload: missing file');
    const fd = new FormData();
    fd.append('file', file, file.name);
    if (startWorkflow) fd.append('start_workflow', 'true');
    const resp = await fetchWithTimeout(uploadEndpoint, { method: 'POST', body: fd }, timeoutMs);
    return resp;
  }

  // Optional: start workflow single-shot; best-effort
  async function maybeStartWorkflow(s3_uri, upload_id) {
    const endpoint = START_WORKFLOW_ENDPOINT;
    if (!endpoint) return null;
    try {
      const resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3_uri: s3_uri, upload_id: upload_id })
      }, FETCH_TIMEOUT_MS);
      return resp;
    } catch (e) {
      if (typeof console !== 'undefined') console.debug('maybeStartWorkflow failed', e && e.message ? e.message : e);
      return null;
    }
  }

  // ---------- Public upload API ----------
  /**
   * uploadFile(file, options)
   * options:
   *   presignEndpoint, uploadEndpoint, startWorkflow (boolean),
   *   presignExpires (seconds), fetchTimeout, useXhrForPut (boolean),
   *   onProgress (function(progressObj)), onPresignResult (fn)
   * returns: { ok: boolean, transport: 'presign'|'multipart'|'error', details: {...} }
   */
  async function uploadFile(file, options = {}) {
    if (!file) return { ok: false, error: 'missing_file' };

    const startWorkflow = !!options.startWorkflow;
    const presignEndpoint = options.presignEndpoint || PRESIGN_ENDPOINT;
    const uploadEndpoint = options.uploadEndpoint || UPLOAD_ENDPOINT;
    const presignExpires = typeof options.presignExpires === 'number' ? options.presignExpires : DEFAULT_PRESIGN_EXPIRES;
    const fetchTimeout = typeof options.fetchTimeout === 'number' ? options.fetchTimeout : FETCH_TIMEOUT_MS;
    const useXhrForPut = !!options.useXhrForPut;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    // Attempt presign flow
    let presignResult = null;
    try {
      presignResult = await presignPut(file, presignEndpoint, presignExpires, { startWorkflow, fetchTimeout });
      if (!presignResult) throw new Error('presign returned empty');
    } catch (e) {
      // presign failing is not fatal; will try multipart
      if (typeof console !== 'undefined') console.debug('presignPut failed, will fallback to multipart', e && e.message ? e.message : e);
      presignResult = null;
    }

    // If presign provided a put URL, attempt PUT
    if (presignResult) {
      const putUrl = presignResult.url || presignResult.presigned_url || presignResult.upload_url || presignResult.put_url || presignResult.presign_url;
      if (putUrl) {
        try {
          _toast('Uploading (presign) — please wait', 1200);
          if (useXhrForPut && onProgress) {
            await putToPresignXhr(putUrl, file, file.type, onProgress, fetchTimeout);
          } else {
            await putToPresignFetch(putUrl, file, file.type);
            // best-effort: notify progress as 100%
            try { onProgress && onProgress({ loaded: file.size || 0, total: file.size || 0, percent: 100 }); } catch (_) {}
          }

          // optionally start workflow
          try {
            await maybeStartWorkflow(presignResult.s3_uri || presignResult.s3Uri || presignResult.s3 || null,
              presignResult.upload_id || presignResult.uploadId || null);
          } catch (_) {}

          return {
            ok: true,
            transport: 'presign',
            presign: presignResult,
            timestamp: new Date().toISOString()
          };
        } catch (putErr) {
          // log and fall through to multipart
          if (typeof console !== 'undefined') console.warn('Presign PUT failed — falling back to multipart', putErr && putErr.message ? putErr.message : putErr);
        }
      } else {
        if (typeof console !== 'undefined') console.debug('Presign result has no URL; falling back to multipart', presignResult);
      }
    }

    // Multipart fallback
    try {
      _toast('Uploading (multipart) — please wait', 1200);
      const result = await multipartUpload(file, uploadEndpoint, startWorkflow, fetchTimeout);
      // If result looks like success
      return {
        ok: true,
        transport: 'multipart',
        result: result,
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      const msg = (err && (err.message || JSON.stringify(err))) || 'unknown';
      _toast('Upload failed: ' + msg, 5000);
      return { ok: false, transport: 'error', error: msg, timestamp: new Date().toISOString() };
    }
  }

  // ---------- UI binding helpers ----------
  /**
   * bindUploadForm(opts)
   * opts: { inputId, triggerId, formId, dropId, auto=true/false, presignEndpoint, uploadEndpoint, startWorkflow }
   * returns { input, trigger, dropArea, startUpload }
   */
  function bindUploadForm(opts = {}) {
    const input = document.getElementById(opts.inputId || 'upload-file') || document.querySelector('input[type="file"][data-upload]');
    if (!input) return null;

    const trigger = document.getElementById(opts.triggerId || (input.dataset && input.dataset.uploadTrigger) || 'upload-trigger') ||
                    document.querySelector('[data-upload-trigger]') || null;
    const form = document.getElementById(opts.formId || 'upload-form') || null;
    const dropArea = document.getElementById(opts.dropId || (input.dataset && input.dataset.dropId)) || null;

    // safe single-binding flags
    if (!input.__stiBound) input.__stiBound = true;

    async function _startUpload(file, sourceEl) {
      if (!file) { _toast('No file selected', 1600); return null; }
      if (sourceEl && typeof sourceEl.disabled !== 'undefined') sourceEl.disabled = true;
      try {
        const result = await uploadFile(file, {
          presignEndpoint: (input.dataset && input.dataset.presignEndpoint) || opts.presignEndpoint,
          uploadEndpoint: (input.dataset && input.dataset.uploadEndpoint) || opts.uploadEndpoint,
          startWorkflow: (input.dataset && (input.dataset.startWorkflow === 'true' || input.dataset.startWorkflow === '1')) || !!opts.startWorkflow,
          presignExpires: input.dataset && input.dataset.presignExpires ? parseInt(input.dataset.presignExpires, 10) : opts.presignExpires,
          fetchTimeout: opts.fetchTimeout || undefined,
          useXhrForPut: (opts.useXhrForPut === true) || (input.dataset && (input.dataset.useXhrForPut === 'true')),
          onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : (typeof window.STI === 'object' && typeof window.STI.onUploadProgress === 'function' ? window.STI.onUploadProgress : null)
        });

        if (result && result.ok) {
          _toast('Upload succeeded', 1400);
          try { if (window.STI && typeof window.STI.onUploadSuccess === 'function') window.STI.onUploadSuccess(result); } catch (_) {}
        } else {
          const em = result && (result.error || (result.result && JSON.stringify(result.result))) || 'Upload failed';
          _toast('Upload failed', 4000);
          try { if (window.STI && typeof window.STI.onUploadFailure === 'function') window.STI.onUploadFailure(result); } catch (_) {}
        }
        return result;
      } finally {
        if (sourceEl && typeof sourceEl.disabled !== 'undefined') sourceEl.disabled = false;
      }
    }

    // trigger click
    if (trigger && !trigger.__stiBound) {
      trigger.addEventListener('click', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        const files = input.files || [];
        if (!files.length) {
          _toast('Choose a file to upload', 1600);
          return;
        }
        _startUpload(files[0], trigger);
      }, { passive: false });
      trigger.__stiBound = true;
    }

    // auto-change behavior
    if (!input.__changeBound) {
      input.addEventListener('change', function () {
        const files = input.files || [];
        if (!files.length) return;
        const auto = (input.dataset && input.dataset.auto) || opts.auto;
        if (String(auto) === 'true' || auto === true || auto === '1') {
          // start upload automatically
          _startUpload(files[0], trigger || input);
        } else {
          _toast('File ready to upload', 1000);
        }
      }, { passive: true });
      input.__changeBound = true;
    }

    // drag & drop
    if (dropArea && !dropArea.__stiBound) {
      dropArea.addEventListener('dragover', (ev) => { ev.preventDefault(); }, { passive: false });
      dropArea.addEventListener('drop', function (ev) {
        ev.preventDefault();
        const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (!file) return;
        // try to assign to input.files (may not be permitted), then start
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
        } catch (_) { /* ignore assignment errors */ }
        _startUpload(file, trigger || input);
      }, { passive: false });
      dropArea.__stiBound = true;
    }

    // form submit -> trigger upload
    if (form && !form.__submitBound) {
      form.addEventListener('submit', function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        const files = input.files || [];
        if (!files.length) {
          _toast('Choose a file to upload', 1600);
          return;
        }
        _startUpload(files[0], trigger || input);
      }, { passive: false });
      form.__submitBound = true;
    }

    return { input, trigger, dropArea, startUpload: _startUpload };
  }

  // ---------- Safe init ----------
  function safeInit() {
    try {
      // auto-wire simple data-upload inputs if present
      try { bindUploadForm(); } catch (e) { if (typeof console !== 'undefined') console.warn('upload.bindUploadForm failed', e); }
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('upload.safeInit failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // ---------- Expose API ----------
  api.uploadFile = api.uploadFile || uploadFile;
  api.bindUploadForm = api.bindUploadForm || bindUploadForm;
  api._config = {
    PRESIGN_ENDPOINT, UPLOAD_ENDPOINT, START_WORKFLOW_ENDPOINT, FETCH_TIMEOUT_MS, DEFAULT_PRESIGN_EXPIRES
  };

})();
