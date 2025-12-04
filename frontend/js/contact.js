/**
 * contact.js — Upgraded contact form: defensive, accessible, timeout-safe, exposes API
 *
 * - Client-side validation (practical email check)
 * - Optionally posts to backend with timeout and graceful fallback to demo behavior
 * - Idempotent init, non-destructive to host page
 * - Exposes window.stiContact API: handleSubmit, trySendToBackend, configure, _test hooks
 * - Emits CustomEvents for integration/tests:
 *     sti:contact:send:start, sti:contact:send:ok, sti:contact:send:fail, sti:contact:ready
 *
 * Promise-returning public functions make automated testing straightforward.
 */
(function () {
  'use strict';

  // ---------- Defaults & config ----------
  const DEFAULT_ENDPOINT = '/contact';
  const DEFAULT_TIMEOUT_MS = 3000;
  const DEFAULT_MAX_PAYLOAD_LENGTH = 20000; // safeguard large bodies

  // Host overrides:
  const hostCfg = (window.STI && window.STI.CONTACT) || window.STI_CONTACT || {};
  let endpoint = (hostCfg && hostCfg.ENDPOINT) ||
    (window.STI && window.STI.CONTACT_ENDPOINT) ||
    window.STI_CONTACT_ENDPOINT ||
    DEFAULT_ENDPOINT;
  let FETCH_TIMEOUT_MS = (hostCfg && Number.isFinite(hostCfg.FETCH_TIMEOUT_MS) && hostCfg.FETCH_TIMEOUT_MS) ||
    (Number.isFinite(window.STI_CONTACT_FETCH_TIMEOUT_MS) && window.STI_CONTACT_FETCH_TIMEOUT_MS) ||
    DEFAULT_TIMEOUT_MS;

  // API surface
  const api = window.stiContact || (window.stiContact = {});
  api._config = { endpoint, FETCH_TIMEOUT_MS, DEFAULT_MAX_PAYLOAD_LENGTH };

  // Platform wrappers (testable)
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  const platform = {
    fetch: typeof window.fetch === 'function' ? window.fetch.bind(window) : null,
    AbortController: typeof window.AbortController === 'function' ? window.AbortController : null,
    now: () => Date.now()
  };

  // ---------- Utilities ----------
  function _safeText(s) {
    return String(s == null ? '' : s).trim();
  }

  function _isValidEmail(email) {
    // Practical client-side email check (not RFC full)
    const e = _safeText(email);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  function _toast(msg, ms) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg, ms);
    } catch (e) { /* ignore */ }

    const t = document.getElementById('toast');
    if (t) {
      t.hidden = false;
      t.textContent = String(msg || '');
      t.classList.add('visible');
      clearTimeout(t.__timer);
      t.__timer = setTimeout(() => { t.classList.remove('visible'); t.hidden = true; }, typeof ms === 'number' ? ms : 3000);
      return;
    }
    if (console && console.info) console.info('TOAST:', msg);
  }

  function _tryParseText(text) {
    if (text === undefined || text === null) return text;
    try { return JSON.parse(String(text)); } catch (e) { return String(text); }
  }

  // Get DOM elements safely
  function _getForm() { return document.getElementById('contact-form'); }
  function _getName() { return document.getElementById('contact-name'); }
  function _getEmail() { return document.getElementById('contact-email'); }
  function _getMessage() { return document.getElementById('contact-message'); }
  function _getSubmitButton(form) {
    if (!form) return null;
    return form.querySelector('button[type="submit"], input[type="submit"]');
  }

  // ---------- Network: fetch with timeout & safe parsing ----------
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
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
      if (timer) clearTimeout(timer);
      const txt = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const body = _tryParseText(txt);
        const err = new Error(`Request failed: ${res.status}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return _tryParseText(txt);
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

  // ---------- trySendToBackend (non-fatal) ----------
  // Returns backend response object on success, null on failure.
  async function trySendToBackend(payload, customEndpoint) {
    const url = (typeof customEndpoint === 'string' && customEndpoint) ? customEndpoint : endpoint;
    if (!url) return null;

    // small payload guard
    try {
      const bodyStr = JSON.stringify(payload || {});
      if (bodyStr.length > DEFAULT_MAX_PAYLOAD_LENGTH) {
        if (console && console.warn) console.warn('Contact payload too large, truncating');
      }
    } catch (e) { /* ignore */ }

    try {
      const resp = await fetchJsonWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, FETCH_TIMEOUT_MS);
      return resp;
    } catch (err) {
      if (console && console.info) console.info('Contact backend POST failed', err && (err.message || err));
      return null;
    }
  }

  // ---------- Main handler: handleSubmit ----------
  // Accepts optional event or null; opts may include { endpoint, timeoutMs }
  // Returns Promise<boolean> (true = handled/sent or demo; false = validation failed)
  async function handleSubmit(e, opts = {}) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    const form = _getForm();
    const nameEl = _getName();
    const emailEl = _getEmail();
    const messageEl = _getMessage();

    // defensive: gather values
    const name = _safeText(nameEl && nameEl.value);
    const email = _safeText(emailEl && emailEl.value);
    const message = _safeText(messageEl && messageEl.value);

    // Basic validation
    const invalidFields = [];
    if (!name) invalidFields.push(nameEl);
    if (!email) invalidFields.push(emailEl);
    if (!message) invalidFields.push(messageEl);

    if (invalidFields.length) {
      _toast('Please fill in all required fields.', 2200);
      invalidFields.forEach(el => { try { if (el) el.setAttribute('aria-invalid', 'true'); } catch (_) {} });
      // emit validation failure event
      document.dispatchEvent(new CustomEvent('sti:contact:validation', { detail: { ok: false, missing: invalidFields.length } }));
      return false;
    }

    if (!_isValidEmail(email)) {
      _toast('Please enter a valid email address.', 2200);
      try { if (emailEl) emailEl.setAttribute('aria-invalid', 'true'); } catch (_) {}
      document.dispatchEvent(new CustomEvent('sti:contact:validation', { detail: { ok: false, reason: 'email' } }));
      return false;
    }

    // Compose payload
    const payload = {
      name: name,
      email: email,
      message: message,
      meta: {
        userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown',
        page: location && location.href ? location.href : '',
      },
      timestamp: new Date().toISOString()
    };

    // UI: disable submit/button and mark busy
    const submitBtn = _getSubmitButton(form);
    try {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('aria-busy', 'true'); }
      if (form) form.setAttribute('aria-busy', 'true');
    } catch (err) { /* ignore */ }

    _toast('Sending message...', 1200);
    document.dispatchEvent(new CustomEvent('sti:contact:send:start', { detail: { payload } }));

    const customEndpoint = (opts && opts.endpoint) || endpoint;
    const customTimeout = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : FETCH_TIMEOUT_MS;

    let backendResp = null;
    try {
      backendResp = await trySendToBackend(payload, customEndpoint, customTimeout);
    } catch (err) {
      backendResp = null;
    }

    if (backendResp) {
      _toast(`Message sent. Thank you, ${payload.name ? payload.name : 'there'}!`, 2400);
      document.dispatchEvent(new CustomEvent('sti:contact:send:ok', { detail: { response: backendResp } }));
      // optional host callback
      try { if (window.STI && typeof window.STI.onContactSuccess === 'function') window.STI.onContactSuccess(backendResp); } catch (err) {}
    } else {
      // Demo fallback: don't claim persistence
      _toast(`Thank you, ${payload.name || 'there'}. Message received (demo).`, 2600);
      document.dispatchEvent(new CustomEvent('sti:contact:send:fail', { detail: { payload } }));
      try { if (window.STI && typeof window.STI.onContactDemo === 'function') window.STI.onContactDemo(payload); } catch (err) {}
    }

    // Reset form and clear busy states
    try {
      if (form && typeof form.reset === 'function') form.reset();
    } catch (err) {
      if (console && console.warn) console.warn('Form reset failed', err);
    } finally {
      try {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.removeAttribute('aria-busy'); }
        if (form) form.removeAttribute('aria-busy');
        if (nameEl) nameEl.removeAttribute('aria-invalid');
        if (emailEl) emailEl.removeAttribute('aria-invalid');
        if (messageEl) messageEl.removeAttribute('aria-invalid');
      } catch (err) { /* ignore */ }
    }

    return true;
  }

  // ---------- DOM binding & initialization ----------
  function _bindForm(form) {
    if (!form || form.__stiBound) return;
    form.addEventListener('submit', function (ev) {
      const opts = (window.stiContact && window.stiContact.submitOptions) || {};
      handleSubmit(ev, opts).catch(err => {
        // ensure UI not left in busy state
        try { if (form) form.removeAttribute('aria-busy'); } catch (_) {}
        if (console && console.warn) console.warn('handleSubmit failed', err);
      });
    });

    // Ctrl/Cmd+Enter in message textarea -> submit
    const msg = _getMessage();
    if (msg && !msg.__enterBound) {
      msg.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
          ev.preventDefault();
          try { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); } catch (e) {}
        }
      }, { passive: true });
      msg.__enterBound = true;
    }

    form.__stiBound = true;
  }

  function safeInit() {
    try {
      const form = _getForm();
      if (!form) {
        // nothing to bind, still export API
        document.dispatchEvent(new CustomEvent('sti:contact:ready', { detail: { present: false } }));
        return;
      }

      // Mark required attributes for accessibility if missing
      try {
        const nameEl = _getName(), emailEl = _getEmail(), messageEl = _getMessage();
        if (nameEl && !nameEl.hasAttribute('required')) nameEl.setAttribute('required', 'required');
        if (emailEl && !emailEl.hasAttribute('required')) emailEl.setAttribute('required', 'required');
        if (messageEl && !messageEl.hasAttribute('required')) messageEl.setAttribute('required', 'required');
      } catch (err) { /* ignore */ }

      _bindForm(form);

      // Export official API methods
      api.handleSubmit = api.handleSubmit || handleSubmit;
      api.trySendToBackend = api.trySendToBackend || trySendToBackend;
      api.configure = function (cfg) {
        if (!cfg) return;
        if (typeof cfg.endpoint === 'string') endpoint = cfg.endpoint;
        if (Number.isFinite(cfg.timeoutMs)) FETCH_TIMEOUT_MS = cfg.timeoutMs;
        if (Number.isFinite(cfg.maxPayloadLength)) api._config.DEFAULT_MAX_PAYLOAD_LENGTH = cfg.maxPayloadLength;
        api._config.endpoint = endpoint;
        api._config.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
      };

      // Testing hooks
      api._setFetch = function (fn) { api._fetchOverride = fn; };
      api._setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
      api._resetOverrides = function () { delete api._fetchOverride; delete api._AbortControllerOverride; };

      // Ready event
      document.dispatchEvent(new CustomEvent('sti:contact:ready', { detail: { present: true, endpoint, FETCH_TIMEOUT_MS } }));
    } catch (e) {
      if (console && console.warn) console.warn('stiContact safeInit failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // ---------- Stable exports ----------
  window.stiContact = window.stiContact || {};
  window.stiContact.handleSubmit = window.stiContact.handleSubmit || handleSubmit;
  window.stiContact.trySendToBackend = window.stiContact.trySendToBackend || trySendToBackend;
  window.stiContact.configure = window.stiContact.configure || api.configure;
  window.stiContact.api = window.stiContact.api || api;
})();
