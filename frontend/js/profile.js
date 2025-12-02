// profile.js — demo profile persistence (localStorage)
(function () {
  'use strict';

  // Expose small API for detection/debugging
  var api = window.stiProfile || (window.stiProfile = {});

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function safeToast(msg, timeout) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, timeout);
    } else {
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
      console.info('Toast:', msg);
    }
  }

  function saveSettings(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();

    var nameEl = document.getElementById('display-name') || {};
    var emailEl = document.getElementById('email') || {};
    var rangeEl = document.getElementById('default-range') || {};
    var updatesEl = document.getElementById('email-updates') || {};

    var name = (nameEl.value || '').trim();
    var email = (emailEl.value || '').trim();
    var range = rangeEl.value || '30d';
    var updates = !!updatesEl.checked;

    if (!name) {
      safeToast('Please enter a display name.', 2200);
      return;
    }
    if (!email) {
      safeToast('Please enter an email address.', 2200);
      return;
    }
    if (!isValidEmail(email)) {
      safeToast('Please enter a valid email address.', 2200);
      return;
    }

    var settings = { displayName: name, email: email, defaultRange: range, emailUpdates: updates };
    try {
      localStorage.setItem('sti-profile', JSON.stringify(settings));
      safeToast('Settings saved (demo)', 1600);
    } catch (e) {
      console.warn('persist failed', e);
      safeToast('Failed to save settings locally', 1800);
    }
  }

  function restore() {
    try {
      var s = localStorage.getItem('sti-profile');
      if (!s) return;
      var parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') {
        if (parsed.displayName) {
          var nameEl = document.getElementById('display-name');
          if (nameEl) nameEl.value = parsed.displayName;
        }
        if (parsed.email) {
          var emailEl = document.getElementById('email');
          if (emailEl) emailEl.value = parsed.email;
        }
        if (parsed.defaultRange) {
          var rangeEl = document.getElementById('default-range');
          if (rangeEl) rangeEl.value = parsed.defaultRange;
        }
        if (typeof parsed.emailUpdates === 'boolean') {
          var updatesEl = document.getElementById('email-updates');
          if (updatesEl) updatesEl.checked = parsed.emailUpdates;
        }
      }
    } catch (e) {
      console.warn('restore failed', e);
    }
  }

  function safeInit() {
    var form = document.getElementById('profile-form');
    if (form && !form.__handled) {
      form.addEventListener('submit', saveSettings);
      form.__handled = true;
    }

    // Expose save/restore for manual use
    api.saveSettings = saveSettings;
    api.restore = restore;

    restore();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
})();
