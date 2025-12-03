// profile.js — demo profile persistence (localStorage)
// Final corrected: defensive, configurable, exposes API, optional backend sync.
(function () {
  'use strict';

  // Namespace
  var api = window.stiProfile || (window.stiProfile = {});
  var STORAGE_KEY = (window.STI && window.STI.PROFILE_STORAGE_KEY) || window.STI_PROFILE_STORAGE_KEY || 'sti-profile';
  var PROFILE_ENDPOINT = (window.STI && window.STI.PROFILE_ENDPOINT) || window.STI_PROFILE_ENDPOINT || null;
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || 3000;

  // Normalize endpoint if array provided
  if (Array.isArray(PROFILE_ENDPOINT)) PROFILE_ENDPOINT = PROFILE_ENDPOINT[0];

  // Simple email validator
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  // Toast helper (uses global showToast if available; falls back safely)
  function safeToast(msg, timeout) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(msg, timeout); return; } catch (e) { /* fallthrough */ }
    }
    try {
      var t = document.getElementById('toast');
      if (t) {
        t.textContent = msg;
        t.classList.add('visible');
        timeout = typeof timeout === 'number' ? timeout : 3000;
        setTimeout(function () { t.classList.remove('visible'); }, timeout);
        return;
      }
    } catch (e) { /* ignore */ }
    // last-resort
    try { if (console && console.info) console.info('Toast:', msg); } catch (e) {}
  }

  // Helper: try parse JSON safely
  function _tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // Helper: fetch JSON with timeout (returns parsed JSON or throws)
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
        if (!res.ok) {
          var err = new Error('Network response not ok: ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.text().then(function (txt) {
          var p = _tryParseJson(txt);
          return p !== null ? p : null;
        });
      })
      .finally(function () { clearTimeout(id); });
  }

  // Save settings handler (can be bound to form submit)
  async function saveSettings(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();

    var nameEl = document.getElementById('display-name') || {};
    var emailEl = document.getElementById('email') || {};
    var rangeEl = document.getElementById('default-range') || {};
    var updatesEl = document.getElementById('email-updates') || {};

    var name = String(nameEl.value || '').trim();
    var email = String(emailEl.value || '').trim();
    var range = rangeEl.value || (rangeEl.dataset && rangeEl.dataset.default) || '30d';
    var updates = !!(updatesEl.checked || updatesEl.value === 'on');

    if (!name) {
      safeToast('Please enter a display name.', 2200);
      return false;
    }
    if (!email) {
      safeToast('Please enter an email address.', 2200);
      return false;
    }
    if (!isValidEmail(email)) {
      safeToast('Please enter a valid email address.', 2200);
      return false;
    }

    var settings = {
      displayName: name,
      email: email,
      defaultRange: range,
      emailUpdates: updates,
      savedAt: new Date().toISOString()
    };

    // Persist locally
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      safeToast('Settings saved locally', 1400);
    } catch (e) {
      if (console && console.warn) console.warn('profile: local persist failed', e);
      safeToast('Failed to save settings locally', 1800);
    }

    // Optional: try to sync to backend if endpoint configured (best-effort, non-blocking)
    if (PROFILE_ENDPOINT) {
      try {
        fetchJsonWithTimeout(PROFILE_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        }, FETCH_TIMEOUT_MS).then(function (resp) {
          if (resp && (resp.success || resp.ok || !resp.error)) {
            safeToast('Settings synced to server', 1400);
            try { if (window.STI && typeof window.STI.onProfileSync === 'function') window.STI.onProfileSync(resp); } catch (e) {}
          }
        }).catch(function (err) {
          if (console && console.info) console.info('profile: server sync failed', err && err.message ? err.message : err);
        });
      } catch (err) {
        if (console && console.info) console.info('profile: server sync threw', err);
      }
    }

    // Return settings for callers/tests
    return settings;
  }

  // Restore settings into form fields; if server endpoint provided try to fetch server-side profile first
  function restoreFromLocal() {
    try {
      var s = localStorage.getItem(STORAGE_KEY);
      if (!s) return null;
      var parsed = JSON.parse(s);
      if (!parsed || typeof parsed !== 'object') return null;

      var nameEl = document.getElementById('display-name');
      var emailEl = document.getElementById('email');
      var rangeEl = document.getElementById('default-range');
      var updatesEl = document.getElementById('email-updates');

      if (nameEl && parsed.displayName != null) nameEl.value = parsed.displayName;
      if (emailEl && parsed.email != null) emailEl.value = parsed.email;
      if (rangeEl && parsed.defaultRange != null) rangeEl.value = parsed.defaultRange;
      if (updatesEl && typeof parsed.emailUpdates === 'boolean') updatesEl.checked = parsed.emailUpdates;

      return parsed;
    } catch (e) {
      if (console && console.warn) console.warn('profile: restore failed', e);
      return null;
    }
  }

  // Try restore from server if endpoint exists; otherwise fall back to local
  function restore() {
    if (!PROFILE_ENDPOINT) {
      return restoreFromLocal();
    }
    // best-effort server fetch; if it fails, restore local
    fetchJsonWithTimeout(PROFILE_ENDPOINT, { method: 'GET' }, FETCH_TIMEOUT_MS)
      .then(function (resp) {
        if (resp && typeof resp === 'object') {
          try {
            var nameEl = document.getElementById('display-name');
            var emailEl = document.getElementById('email');
            var rangeEl = document.getElementById('default-range');
            var updatesEl = document.getElementById('email-updates');
            if (nameEl && resp.displayName != null) nameEl.value = resp.displayName;
            if (emailEl && resp.email != null) emailEl.value = resp.email;
            if (rangeEl && resp.defaultRange != null) rangeEl.value = resp.defaultRange;
            if (updatesEl && typeof resp.emailUpdates === 'boolean') updatesEl.checked = resp.emailUpdates;
            try {
              // also persist server-backed profile locally for offline use
              localStorage.setItem(STORAGE_KEY, JSON.stringify(resp));
            } catch (e) {}
          } catch (e) {
            if (console && console.warn) console.warn('profile: apply server response failed', e);
          }
        } else {
          // fallback to local
          restoreFromLocal();
        }
      })
      .catch(function () {
        restoreFromLocal();
      });
  }

  // Clear settings (both UI + localStorage)
  function clearSettings(ev) {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    try {
      localStorage.removeItem(STORAGE_KEY);
      // clear UI
      var form = document.getElementById('profile-form');
      if (form && typeof form.reset === 'function') form.reset();
      safeToast('Profile cleared', 1200);
      try { if (window.STI && typeof window.STI.onProfileClear === 'function') window.STI.onProfileClear(); } catch (e) {}
      return true;
    } catch (e) {
      if (console && console.warn) console.warn('profile: clear failed', e);
      safeToast('Failed to clear profile', 1600);
      return false;
    }
  }

  // Initialize: bind form and buttons; restore values
  function safeInit() {
    var form = document.getElementById('profile-form');
    if (form && !form.__handled) {
      form.addEventListener('submit', saveSettings);
      form.__handled = true;
    }

    var clearBtn = document.getElementById('profile-clear');
    if (clearBtn && !clearBtn.__handled) {
      clearBtn.addEventListener('click', clearSettings, { passive: true });
      clearBtn.__handled = true;
    }

    // Ensure basic required attributes for accessibility
    try {
      var nameEl = document.getElementById('display-name');
      var emailEl = document.getElementById('email');
      if (nameEl) nameEl.setAttribute('required', 'required');
      if (emailEl) emailEl.setAttribute('required', 'required');
    } catch (e) { /* ignore */ }

    // Expose API functions
    api.saveSettings = saveSettings;
    api.restore = restore;
    api.clearSettings = clearSettings;
    api.restoreFromLocal = restoreFromLocal;

    // Run initial restore
    try { restore(); } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // Export stable API
  window.stiProfile = window.stiProfile || {};
  window.stiProfile.saveSettings = window.stiProfile.saveSettings || saveSettings;
  window.stiProfile.restore = window.stiProfile.restore || restore;
  window.stiProfile.clearSettings = window.stiProfile.clearSettings || clearSettings;
  window.stiProfile.api = window.stiProfile.api || api;
})();
