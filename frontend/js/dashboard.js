/**
 * contact.js — Corrected, enhanced, and upgraded contact form module
 *
 * - Defensive client-side validation (practical email check)
 * - Timeout-safe POST to backend, graceful demo fallback
 * - Accessible: aria-busy, aria-invalid, keyboard shortcut (Ctrl/Cmd+Enter)
 * - Exposes stable API on window.stiContact:
 *     .handleSubmit(event, opts) -> Promise<boolean>
 *     .trySendToBackend(payload, customEndpoint) -> Promise<response|null>
 *     .configure(cfg)
 *     ._setFetch(fn) / ._setAbortController(Ctor) -> test hooks
 * - Emits CustomEvents for integration/tests:
 *     sti:contact:ready, sti:contact:validation, sti:contact:send:start,
 *     sti:contact:send:ok, sti:contact:send:fail
 *
 * Non-destructive: idempotent initialization and safe to include multiple times.
 */
(function () {
  'use strict';

  // ---------- Defaults & host-config ----------
  const DEFAULT_ENDPOINT = '/contact';
  const DEFAULT_TIMEOUT_MS = 3000;
  const DEFAULT_MIN_SUBMIT_MS = 2000; // rate limit repeated submits
  const DEFAULT_MAX_PAYLOAD_CHARS = 40_000; // safety guard

  const hostCfg = (window.STI && window.STI.CONTACT) || window.STI_CONTACT || {};
  let endpoint = (hostCfg && hostCfg.ENDPOINT) ||
                 (window.STI && window.STI.CONTACT_ENDPOINT) ||
                 window.STI_CONTACT_ENDPOINT ||
                 DEFAULT_ENDPOINT;

  let FETCH_TIMEOUT_MS = (hostCfg && Number.isFinite(hostCfg.FETCH_TIMEOUT_MS) && hostCfg.FETCH_TIMEOUT_MS) ||
                         (Number.isFinite(window.STI_CONTACT_FETCH_TIMEOUT_MS) && window.STI_CONTACT_FETCH_TIMEOUT_MS) ||
                         DEFAULT_TIMEOUT_MS;

  // ---------- Module API surface ----------
  const api = window.stiContact || (window.stiContact = {});
  api._config = { endpoint, FETCH_TIMEOUT_MS, DEFAULT_MIN_SUBMIT_MS, DEFAULT_MAX_PAYLOAD_CHARS };

  // Test overrides (injected in tests)
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  // Internal platform wrappers (safe)
  const platform = {
    fetch: typeof window.fetch === 'function' ? window.fetch.bind(window) : null,
    AbortController: typeof window.AbortController === 'function' ? window.AbortController : null,
    now: () => Date.now()
  };

  // ---------- Utilities ----------
  function _trim(s) { return String(s == null ? '' : s).trim(); }

  function _isValidEmail(email) {
    // Practical client-side check (not RFC-perfect). Good enough for UX.
    const e = _trim(email);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  function _safeToast(message, ms) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(message, ms); return; }
    } catch (e) { /* swallow */ }

    const toast = document.getElementById('toast');
    if (toast) {
      toast.hidden = false;
      toast.textContent = String(message || '');
      toast.classList.add('visible');
      clearTimeout(toast.__timer);
      toast.__timer = setTimeout(() => { toast.classList.remove('visible'); toast.hidden = true; }, typeof ms === 'number' ? ms : 3000);
      return;
    }
    if (console && console.info) console.info('stiContact:', message);
  }

  function _tryParseText(text) {
    if (text === undefined || text === null) return text;
    try { return JSON.parse(text); } catch (e) { return String(text); }
  }

  function _getFormEls() {
    return {
      form: document.getElementById('contact-form'),
      nameEl: document.getElementById('contact-name'),
      emailEl: document.getElementById('contact-email'),
      messageEl: document.getElementById('contact-message'),
      submitBtn: (function (form) { return form && (form.querySelector('button[type="submit"], input[type="submit"]') || null); })(document.getElementById('contact-form'))
    };
  }

  // ---------- Network: fetch with timeout & safe parsing ----------
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    if (!url) throw new TypeError('fetchJsonWithTimeout: missing url');

    const fetchFn = api._fetchOverride || platform.fetch;
    if (!fetchFn) throw new Error('Fetch not available in this environment');

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
      const text = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const body = _tryParseText(text);
        const err = new Error(`Request failed (${res.status})`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return _tryParseText(text);
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
  // returns parsed response on success, null on failure
  async function trySendToBackend(payload, customEndpoint) {
    const url = (typeof customEndpoint === 'string' && customEndpoint) ? customEndpoint : endpoint;
    if (!url) return null;

    // payload sanity guard (best-effort)
    try {
      const s = JSON.stringify(payload || {});
      if (s.length > (api._config.DEFAULT_MAX_PAYLOAD_CHARS || DEFAULT_MAX_PAYLOAD_CHARS)) {
        if (console && console.warn) console.warn('stiContact: payload large (%d chars)', s.length);
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
      if (console && console.info) console.info('stiContact backend POST failed', err && (err.message || err));
      return null;
    }
  }

  // ---------- Rate limiting helpers ----------
  let _lastSubmitAt = 0;
  function _isSubmitTooSoon() {
    const now = platform.now();
    if (now - _lastSubmitAt < (api._config.DEFAULT_MIN_SUBMIT_MS || DEFAULT_MIN_SUBMIT_MS)) return true;
    _lastSubmitAt = now;
    return false;
  }

  // ---------- Main handler ----------
  // handleSubmit(event, opts) -> Promise<boolean>
  // opts may contain { endpoint, timeoutMs }
  async function handleSubmit(e, opts = {}) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    const { form, nameEl, emailEl, messageEl, submitBtn } = _getFormEls();

    if (!form) {
      _safeToast('Contact form not present', 1800);
      return false;
    }

    // defensive reads
    const name = _trim(nameEl && nameEl.value);
    const email = _trim(emailEl && emailEl.value);
    const message = _trim(messageEl && messageEl.value);

    // validation
    const invalid = [];
    if (!name) invalid.push({ el: nameEl, reason: 'missing' });
    if (!email) invalid.push({ el: emailEl, reason: 'missing' });
    if (!message) invalid.push({ el: messageEl, reason: 'missing' });

    if (invalid.length) {
      _safeToast('Please fill in all required fields.', 2200);
      invalid.forEach(x => { try { if (x.el) x.el.setAttribute('aria-invalid', 'true'); } catch (_) {} });
      document.dispatchEvent(new CustomEvent('sti:contact:validation', { detail: { ok: false, missing: invalid.length } }));
      return false;
    }

    if (!_isValidEmail(email)) {
      _safeToast('Please enter a valid email address.', 2200);
      try { if (emailEl) emailEl.setAttribute('aria-invalid', 'true'); } catch (_) {}
      document.dispatchEvent(new CustomEvent('sti:contact:validation', { detail: { ok: false, reason: 'email' } }));
      return false;
    }

    if (_isSubmitTooSoon()) {
      _safeToast('Please wait a moment before sending again.', 1400);
      return false;
    }

    const payload = {
      name, email, message,
      meta: { ua: (typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown', page: (location && location.href) || '' },
      timestamp: new Date().toISOString()
    };

    // disable UI
    try {
      if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('aria-busy', 'true'); }
      form.setAttribute('aria-busy', 'true');
    } catch (_) {}

    _safeToast('Sending message...', 1200);
    document.dispatchEvent(new CustomEvent('sti:contact:send:start', { detail: { payload } }));

    // attempt backend
    let backendResp = null;
    try {
      const customEndpoint = opts.endpoint || endpoint;
      const customTimeout = (opts.timeoutMs && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : FETCH_TIMEOUT_MS;
      // use trySendToBackend but supply custom timeout if needed by temporarily overriding FETCH_TIMEOUT_MS
      if (customTimeout !== FETCH_TIMEOUT_MS) {
        const old = FETCH_TIMEOUT_MS;
        FETCH_TIMEOUT_MS = customTimeout;
        try { backendResp = await trySendToBackend(payload, customEndpoint); } finally { FETCH_TIMEOUT_MS = old; }
      } else {
        backendResp = await trySendToBackend(payload, customEndpoint);
      }
    } catch (err) {
      backendResp = null;
    }

    if (backendResp) {
      _safeToast(`Message sent. Thank you, ${payload.name || 'there'}!`, 2400);
      document.dispatchEvent(new CustomEvent('sti:contact:send:ok', { detail: { response: backendResp } }));
      try { if (window.STI && typeof window.STI.onContactSuccess === 'function') window.STI.onContactSuccess(backendResp); } catch (_) {}
    } else {
      // demo fallback
      _safeToast(`Thank you, ${payload.name || 'there'}. Message received (demo).`, 2600);
      document.dispatchEvent(new CustomEvent('sti:contact:send:fail', { detail: { payload } }));
      try { if (window.STI && typeof window.STI.onContactDemo === 'function') window.STI.onContactDemo(payload); } catch (_) {}
    }

    // reset & re-enable UI
    try { if (typeof form.reset === 'function') form.reset(); } catch (err) { if (console) console.warn('stiContact reset failed', err); }
    try {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.removeAttribute('aria-busy'); }
      form.removeAttribute('aria-busy');
      if (nameEl) nameEl.removeAttribute('aria-invalid');
      if (emailEl) emailEl.removeAttribute('aria-invalid');
      if (messageEl) messageEl.removeAttribute('aria-invalid');
    } catch (_) {}

    return true;
  }

  // ---------- Binding & initialization ----------
  function _bindForm(form) {
    if (!form || form.__stiBound) return;
    form.addEventListener('submit', function (ev) {
      const opts = (window.stiContact && window.stiContact.submitOptions) || {};
      handleSubmit(ev, opts).catch(err => {
        try { if (form) form.removeAttribute('aria-busy'); } catch (_) {}
        if (console && console.warn) console.warn('stiContact.handleSubmit error', err);
      });
    });

    // Ctrl/Cmd+Enter in textarea -> submit
    const messageEl = document.getElementById('contact-message');
    if (messageEl && !messageEl.__enterBound) {
      messageEl.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
          ev.preventDefault();
          try { form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); } catch (e) {}
        }
      }, { passive: true });
      messageEl.__enterBound = true;
    }

    form.__stiBound = true;
  }

  function safeInit() {
    try {
      const { form, nameEl, emailEl, messageEl } = _getFormEls();
      if (!form) {
        document.dispatchEvent(new CustomEvent('sti:contact:ready', { detail: { present: false } }));
        return;
      }

      // ensure required attributes for accessibility
      try {
        if (nameEl && !nameEl.hasAttribute('required')) nameEl.setAttribute('required', 'required');
        if (emailEl && !emailEl.hasAttribute('required')) emailEl.setAttribute('required', 'required');
        if (messageEl && !messageEl.hasAttribute('required')) messageEl.setAttribute('required', 'required');
      } catch (_) {}

      _bindForm(form);

      // export API
      api.handleSubmit = api.handleSubmit || handleSubmit;
      api.trySendToBackend = api.trySendToBackend || trySendToBackend;
      api.configure = api.configure || function (cfg) {
        if (!cfg) return;
        if (typeof cfg.endpoint === 'string') endpoint = cfg.endpoint;
        if (Number.isFinite(cfg.timeoutMs)) FETCH_TIMEOUT_MS = cfg.timeoutMs;
        if (Number.isFinite(cfg.minSubmitMs)) api._config.DEFAULT_MIN_SUBMIT_MS = cfg.minSubmitMs;
        api._config.endpoint = endpoint;
        api._config.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
      };

      // testing hooks
      api._setFetch = function (fn) { api._fetchOverride = fn; };
      api._setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
      api._resetOverrides = function () { delete api._fetchOverride; delete api._AbortControllerOverride; };

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
