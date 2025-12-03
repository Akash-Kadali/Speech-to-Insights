// toast.js — Final corrected
// Simple, robust, CSS-friendly toast API used across all pages.
// Automatically creates a toast container if missing, prevents duplicates,
// and exposes window.showToast + window.toast.show.

(function (window, document) {
  'use strict';

  // Prevent double initialization
  if (window.__stiToastInitialized) return;
  window.__stiToastInitialized = true;

  // Namespace
  var api = window.toast || (window.toast = {});

  // Create container if needed
  function ensureToastContainer() {
    var el = document.getElementById('toast');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.className = 'toast-container';
    document.body.appendChild(el);
    return el;
  }

  // Core toast behavior
  function showToast(message, timeout) {
    message = (message == null ? '' : String(message));
    timeout = typeof timeout === 'number' ? timeout : 3000;

    try {
      var el = ensureToastContainer();

      // Reset text content
      el.textContent = message;

      // Restart CSS animation by forcing reflow
      el.classList.remove('visible');
      void el.offsetWidth;
      el.classList.add('visible');

      // Hide after timeout
      setTimeout(function () {
        try { el.classList.remove('visible'); } catch (_) {}
      }, timeout);
    } catch (err) {
      // Final fallback
      if (console && console.warn) console.warn('[toast.js fallback]', err);
      try { alert(message); } catch (_) {}
    }
  }

  // Register global showToast if not already defined
  if (typeof window.showToast !== 'function') {
    window.showToast = showToast;
  }

  // Expose API
  api.show = showToast;
  api.ensure = ensureToastContainer;

})(window, document);
