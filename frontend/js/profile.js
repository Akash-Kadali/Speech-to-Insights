/**
 * profile.js — upgraded profile persistence (localStorage + optional backend)
 * - Defensive, configurable, async/await, exposes stable window.stiProfile API
 * - Optional best-effort server sync; non-blocking and logged
 * - Test hooks: setFetch, setAbortController
 * - Emits CustomEvents for integration: sti:profile:restored, sti:profile:saved, sti:profile:cleared
 */
(function () {
  'use strict';

  // ---------- Namespace & default config ----------
  const api = (window.stiProfile = window.stiProfile || {});
  const DEFAULTS = {
    STORAGE_KEY: (window.STI && window.STI.PROFILE_STORAGE_KEY) || window.STI_PROFILE_STORAGE_KEY || 'sti-profile',
    PROFILE_ENDPOINT: (window.STI && window.STI.PROFILE_ENDPOINT) || window.STI_PROFILE_ENDPOINT || null,
    FETCH_TIMEOUT_MS: (window.STI && window.STI.FETCH_TIMEOUT_MS) || 3000,
    SELECTORS: {
      form: '#profile-form',
      name: '#display-name',
      email: '#email',
      range: '#default-range',
      updates: '#email-updates',
      clearBtn: '#profile-clear',
      toast: '#toast'
    }
  };

  // apply runtime overrides
  api._config = Object.assign({}, DEFAULTS);

  // Test / platform hooks
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  // ---------- Small utilities ----------
  function _now() { return new Date().toISOString(); }
  function _log(...args) { if (typeof console !== 'undefined') console.debug('stiProfile:', ...args); }
  function _safeText(s) { return (s === undefined || s === null) ? '' : String(s); }

  function _toast(msg, timeout) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(String(msg || ''), timeout);
        return;
      }
    } catch (e) { /* ignore */ }

    const sel = api._config.SELECTORS.toast;
    try {
      const t = document.querySelector(sel);
      if (t) {
        t.textContent = String(msg || '');
        t.classList.add('visible');
        const ms = typeof timeout === 'number' ? timeout : 3000;
        setTimeout(() => t.classList.remove('visible'), ms);
        return;
      }
    } catch (e) { /* ignore */ }

    if (typeof console !== 'undefined') console.info('TOAST:', msg);
  }

  function _isValidEmail(email) {
    // reasonable client-side check (not RFC-perfect)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function _tryParseJSON(text) {
    if (text === undefined || text === null) return null;
    if (typeof text === 'object') return text;
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // ---------- network helper (async + timeout) ----------
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = api._config.FETCH_TIMEOUT_MS) {
    if (!url) throw new Error('fetchJsonWithTimeout: url required');

    const fetchFn = api._fetchOverride || window.fetch;
    if (typeof fetchFn !== 'function') throw new Error('fetch is not available');

    const AbortCtor = api._AbortControllerOverride || window.AbortController;
    const controller = AbortCtor ? new AbortCtor() : null;
    const merged = Object.assign({}, opts);
    if (controller) merged.signal = controller.signal;
    merged.credentials = merged.credentials || 'same-origin';

    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, merged);
      const text = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const parsed = _tryParseJSON(text);
        const err = new Error(`Network error: ${res.status}`);
        err.status = res.status;
        err.body = parsed !== null ? parsed : text;
        throw err;
      }
      // prefer JSON if possible, else try first non-empty line (jsonl), else return raw text
      const parsed = _tryParseJSON(text);
      if (parsed !== null) return parsed;
      const first = (text || '').split(/\r?\n/).find(Boolean) || '';
      const firstParsed = _tryParseJSON(first);
      if (firstParsed !== null) return firstParsed;
      return text;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error('Request aborted/timeout');
        e.code = 'ABORT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- local persistence helpers ----------
  function _persistLocal(settings) {
    try {
      localStorage.setItem(api._config.STORAGE_KEY, JSON.stringify(settings));
      return true;
    } catch (e) {
      _log('persistLocal failed', e);
      return false;
    }
  }

  function _readLocal() {
    try {
      const raw = localStorage.getItem(api._config.STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (e) {
      _log('readLocal failed', e);
      return null;
    }
  }

  function _clearLocal() {
    try {
      localStorage.removeItem(api._config.STORAGE_KEY);
      return true;
    } catch (e) {
      _log('clearLocal failed', e);
      return false;
    }
  }

  // ---------- DOM helpers ----------
  function _sel(idOrSel) {
    try { return document.querySelector(idOrSel); } catch (e) { return null; }
  }

  function _getElements() {
    const s = api._config.SELECTORS;
    return {
      form: _sel(s.form),
      name: _sel(s.name),
      email: _sel(s.email),
      range: _sel(s.range),
      updates: _sel(s.updates),
      clearBtn: _sel(s.clearBtn)
    };
  }

  // ---------- Public actions ----------
  /**
   * saveSettings(ev?, opts?)
   * - validates client-side
   * - persists locally
   * - optionally posts to server (non-blocking)
   * returns saved settings object on success, null on validation failure
   */
  async function saveSettings(ev, opts = {}) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();

    const { form, name, email, range, updates } = _getElements();
    const displayName = _safeText(name && name.value).trim();
    const emailAddr = _safeText(email && email.value).trim();
    const defaultRange = _safeText(range && range.value) || (range && range.dataset && range.dataset.default) || '';
    const emailUpdates = !!(updates && (updates.checked === true || String(updates.value).toLowerCase() === 'on'));

    // validation
    if (!displayName) {
      _toast('Please enter a display name.', 2200);
      try { if (name) name.setAttribute('aria-invalid', 'true'); } catch (_) {}
      return null;
    }
    if (!emailAddr) {
      _toast('Please enter an email address.', 2200);
      try { if (email) email.setAttribute('aria-invalid', 'true'); } catch (_) {}
      return null;
    }
    if (!_isValidEmail(emailAddr)) {
      _toast('Please enter a valid email address.', 2200);
      try { if (email) email.setAttribute('aria-invalid', 'true'); } catch (_) {}
      return null;
    }

    const settings = {
      displayName,
      email: emailAddr,
      defaultRange,
      emailUpdates,
      savedAt: _now()
    };

    const localOk = _persistLocal(settings);
    _toast(localOk ? 'Settings saved locally' : 'Settings saved locally (storage warning)', 1400);

    // optional server sync (best-effort, non-blocking)
    const endpoint = (opts && opts.endpoint) || api._config.PROFILE_ENDPOINT;
    if (endpoint) {
      (async () => {
        try {
          const resp = await fetchJsonWithTimeout(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
          }, api._config.FETCH_TIMEOUT_MS);
          _toast('Settings synced to server', 1400);
          document.dispatchEvent(new CustomEvent('sti:profile:saved', { detail: { settings, serverResp: resp } }));
          try { if (window.STI && typeof window.STI.onProfileSync === 'function') window.STI.onProfileSync(resp); } catch (_) {}
        } catch (err) {
          _log('server sync failed (non-fatal)', err);
          // do not surface failure to user beyond console; it's demo-safe
        }
      })();
    } else {
      document.dispatchEvent(new CustomEvent('sti:profile:saved', { detail: { settings } }));
    }

    // reset aria-invalid attributes
    try {
      if (name) name.removeAttribute('aria-invalid');
      if (email) email.removeAttribute('aria-invalid');
    } catch (_) {}

    // return saved settings object
    return settings;
  }

  /**
   * restore(opts?)
   * - try server first if endpoint configured (best-effort)
   * - fallback to reading local storage synchronously
   * - returns the applied profile object (local or server) or null
   */
  function restore(opts = {}) {
    const endpoint = (opts && opts.endpoint) || api._config.PROFILE_ENDPOINT;

    // First apply local sync immediately so UI has values synchronously
    const local = _readLocal();
    _applyToForm(local);

    // If no endpoint, resolve immediately with local
    if (!endpoint) {
      if (local) document.dispatchEvent(new CustomEvent('sti:profile:restored', { detail: { source: 'local', profile: local } }));
      return local;
    }

    // Try server async and if it returns, apply and persist locally
    (async () => {
      try {
        const resp = await fetchJsonWithTimeout(endpoint, { method: 'GET' }, api._config.FETCH_TIMEOUT_MS);
        if (resp && typeof resp === 'object') {
          _applyToForm(resp);
          try { _persistLocal(resp); } catch (_) {}
          document.dispatchEvent(new CustomEvent('sti:profile:restored', { detail: { source: 'server', profile: resp } }));
          try { if (window.STI && typeof window.STI.onProfileRestore === 'function') window.STI.onProfileRestore(resp); } catch (_) {}
          return;
        }
      } catch (err) {
        _log('profile server restore failed (falling back to local)', err);
      }
      // if server failed, we already applied local above
      document.dispatchEvent(new CustomEvent('sti:profile:restored', { detail: { source: 'local', profile: local } }));
    })();

    return local;
  }

  function _applyToForm(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const { name, email, range, updates } = _getElements();
    try {
      if (name && profile.displayName != null) name.value = profile.displayName;
      if (email && profile.email != null) email.value = profile.email;
      if (range && profile.defaultRange != null) range.value = profile.defaultRange;
      if (updates && typeof profile.emailUpdates === 'boolean') updates.checked = profile.emailUpdates;
    } catch (e) {
      _log('applyToForm failed', e);
    }
    return profile;
  }

  /**
   * clearSettings(ev?)
   * - clears local storage and resets form
   */
  function clearSettings(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    const { form } = _getElements();
    const ok = _clearLocal();
    try {
      if (form && typeof form.reset === 'function') form.reset();
    } catch (e) { _log('form reset failed', e); }
    _toast(ok ? 'Profile cleared' : 'Profile cleared (storage warning)', 1200);
    document.dispatchEvent(new CustomEvent('sti:profile:cleared', { detail: { ok } }));
    try { if (window.STI && typeof window.STI.onProfileClear === 'function') window.STI.onProfileClear(); } catch (_) {}
    return ok;
  }

  // ---------- Initialization / binding ----------
  function _bindFormHandlers() {
    const { form, clearBtn, name, email } = _getElements();
    if (form && !form.__stiBound) {
      form.addEventListener('submit', function (ev) {
        const opts = (api && api.submitOptions) || {};
        saveSettings(ev, opts).catch(err => { _log('saveSettings error', err); });
      });
      form.__stiBound = true;
    }

    if (clearBtn && !clearBtn.__stiBound) {
      clearBtn.addEventListener('click', clearSettings, { passive: true });
      clearBtn.__stiBound = true;
    }

    // set required attributes for accessibility
    try {
      if (name && !name.hasAttribute('required')) name.setAttribute('required', 'required');
      if (email && !email.hasAttribute('required')) email.setAttribute('required', 'required');
    } catch (_) {}
  }

  function init() {
    if (init.__done) return;
    init.__done = true;

    // apply any externally provided config
    try {
      const provided = window.STI || {};
      if (provided.PROFILE_ENDPOINT) api._config.PROFILE_ENDPOINT = provided.PROFILE_ENDPOINT;
      if (Number.isFinite(provided.FETCH_TIMEOUT_MS)) api._config.FETCH_TIMEOUT_MS = provided.FETCH_TIMEOUT_MS;
      if (provided.PROFILE_STORAGE_KEY) api._config.STORAGE_KEY = provided.PROFILE_STORAGE_KEY;
    } catch (_) {}

    _bindFormHandlers();
    // restore values (sync local, async server)
    restore();
  }

  // auto-init once DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ---------- API exports & test hooks ----------
  api.saveSettings = saveSettings;
  api.restore = restore;
  api.clearSettings = clearSettings;
  api.readLocal = _readLocal;
  api.persistLocal = _persistLocal;
  api.setFetch = function (fn) { api._fetchOverride = fn; };
  api.setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
  api.configure = function (cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return api._config;
    if (cfg.STORAGE_KEY) api._config.STORAGE_KEY = cfg.STORAGE_KEY;
    if (cfg.PROFILE_ENDPOINT) api._config.PROFILE_ENDPOINT = cfg.PROFILE_ENDPOINT;
    if (Number.isFinite(cfg.FETCH_TIMEOUT_MS)) api._config.FETCH_TIMEOUT_MS = cfg.FETCH_TIMEOUT_MS;
    if (cfg.SELECTORS && typeof cfg.SELECTORS === 'object') api._config.SELECTORS = Object.assign({}, api._config.SELECTORS, cfg.SELECTORS);
    return api._config;
  };

  // ensure stable window export
  window.stiProfile = window.stiProfile || {};
  window.stiProfile.saveSettings = window.stiProfile.saveSettings || api.saveSettings;
  window.stiProfile.restore = window.stiProfile.restore || api.restore;
  window.stiProfile.clearSettings = window.stiProfile.clearSettings || api.clearSettings;
  window.stiProfile.api = window.stiProfile.api || api;

})();
