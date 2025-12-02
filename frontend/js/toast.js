// toast.js — simple toast API used across pages
(function (window, document) {
  'use strict';

  // Avoid duplicate initialization
  if (window.__stiToastInitialized) return;
  window.__stiToastInitialized = true;

  // Public namespace
  var api = window.toast || (window.toast = {});

  function ensureToastContainer() {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'true');
      el.setAttribute('role', 'status');
      el.className = 'toast-container';
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(message, timeout) {
    try {
      var el = ensureToastContainer();
      el.textContent = message;

      // Reset animation state if still visible
      el.classList.remove('visible');
      void el.offsetWidth; // force reflow to restart CSS animation
      el.classList.add('visible');

      timeout = typeof timeout === 'number' ? timeout : 3000;
      setTimeout(function () {
        el.classList.remove('visible');
      }, timeout);
    } catch (e) {
      // Last-resort fallback
      console.warn('Toast fallback:', e, message);
      try { alert(message); } catch (_) {}
    }
  }

  // Global exposure (idempotent)
  if (typeof window.showToast !== 'function') {
    window.showToast = showToast;
  }

  api.show = showToast;
  api.ensure = ensureToastContainer;

})(window, document);
