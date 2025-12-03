// contact.js — demo contact form: validate and reset (no external email)
// Final corrected version: defensive, optional backend submit, timeout-safe fetch, exposes API.
(function () {
  'use strict';

  // Expose small API for detection / debugging
  var api = window.stiContact || (window.stiContact = {});

  // Configurable endpoint and timeout (override via window.STI_CONTACT_ENDPOINT or window.STI)
  var CONTACT_ENDPOINT = (window.STI && window.STI.CONTACT_ENDPOINT) || window.STI_CONTACT_ENDPOINT || '/contact';
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.CONTACT_FETCH_TIMEOUT_MS) || 3000;

  // Normalize endpoint if array provided
  if (Array.isArray(CONTACT_ENDPOINT)) CONTACT_ENDPOINT = CONTACT_ENDPOINT[0];

  function isValidEmail(email) {
    // Simple, practical validation for demo use
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function safeToast(msg, timeout) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, timeout); } catch (e) { if (console && console.info) console.info('Toast:', msg); }
    } else if (console && console.info) {
      console.info('Toast:', msg);
    }
  }

  // Helper: try parse JSON or return raw text
  function _tryParseTextAsJson(text) {
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  // Fetch wrapper with timeout; returns parsed JSON/text or throws
  function fetchJsonWithTimeout(url, opts, timeoutMs) {
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
          if (!res.ok) {
            var parsedErr = _tryParseTextAsJson(t);
            var e = new Error('Network response not ok: ' + res.status);
            e.status = res.status;
            e.body = parsedErr;
            throw e;
          }
          return _tryParseTextAsJson(t);
        });
      })
      .finally(function () { clearTimeout(id); });
  }

  // Try to POST message to backend; if endpoint not available, resolve with null
  async function trySendToBackend(payload) {
    try {
      var resp = await fetchJsonWithTimeout(CONTACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, FETCH_TIMEOUT_MS);
      return resp;
    } catch (e) {
      // Non-fatal for demo: backend may not be implemented
      if (console && console.info) console.info('contact backend not available or failed:', e && e.message ? e.message : e);
      return null;
    }
  }

  // Main submit handler
  async function handleSubmit(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    var nameEl = document.getElementById('contact-name');
    var emailEl = document.getElementById('contact-email');
    var messageEl = document.getElementById('contact-message');

    var name = (nameEl && nameEl.value) || '';
    var email = (emailEl && emailEl.value) || '';
    var message = (messageEl && messageEl.value) || '';

    // Basic validation
    if (!name.trim() || !email.trim() || !message.trim()) {
      safeToast('Please fill in all required fields.', 2200);
      return false;
    }
    if (!isValidEmail(email)) {
      safeToast('Please enter a valid email address.', 2200);
      return false;
    }

    // Construct payload
    var payload = {
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
      timestamp: new Date().toISOString()
    };

    // UI: disable submit button if present
    var form = document.getElementById('contact-form');
    var submitBtn = form ? form.querySelector('button[type="submit"], input[type="submit"]') : null;
    try { if (submitBtn) submitBtn.disabled = true; } catch (e) {}

    // Try to send to backend; if unavailable, behave as demo-only success
    safeToast('Sending message...', 1200);
    var backendResp = null;
    try {
      backendResp = await trySendToBackend(payload);
    } catch (err) {
      backendResp = null;
    }

    // Success behavior: if backend responded OK (truthy), respect it; otherwise show demo success
    if (backendResp) {
      safeToast('Message sent. Thank you, ' + (payload.name || 'there') + '!', 2400);
      try {
        if (window.STI && typeof window.STI.onContactSuccess === 'function') window.STI.onContactSuccess(backendResp);
      } catch (e) { /* ignore callback errors */ }
    } else {
      // Demo-mode: show success but do not claim persistence
      safeToast('Thank you, ' + (payload.name || 'there') + '. Message received (demo).', 2600);
      try {
        if (window.STI && typeof window.STI.onContactDemo === 'function') window.STI.onContactDemo(payload);
      } catch (e) { /* ignore */ }
    }

    // Reset form if possible
    try {
      if (form) form.reset();
    } catch (err) {
      if (console && console.warn) console.warn('contact form reset failed', err);
    } finally {
      try { if (submitBtn) submitBtn.disabled = false; } catch (e) {}
    }

    return true;
  }

  // Initialize: bind handler if form exists
  function safeInit() {
    var form = document.getElementById('contact-form');
    if (!form) return;

    if (!form.__handled) {
      form.addEventListener('submit', handleSubmit);
      form.__handled = true;
    }

    // Expose handleSubmit on API for testing or external invocation
    api.handleSubmit = handleSubmit;
    api.trySendToBackend = trySendToBackend;

    // Accessibility: ensure required attributes set
    try {
      var nameEl = document.getElementById('contact-name');
      var emailEl = document.getElementById('contact-email');
      var messageEl = document.getElementById('contact-message');
      if (nameEl) nameEl.setAttribute('required', 'required');
      if (emailEl) emailEl.setAttribute('required', 'required');
      if (messageEl) messageEl.setAttribute('required', 'required');
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // Export stable API
  window.stiContact = window.stiContact || {};
  window.stiContact.handleSubmit = window.stiContact.handleSubmit || handleSubmit;
  window.stiContact.trySendToBackend = window.stiContact.trySendToBackend || trySendToBackend;
  window.stiContact.api = window.stiContact.api || api;
})();
