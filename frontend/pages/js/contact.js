// contact.js — demo contact form: validate and reset (no external email)
(function () {
  'use strict';

  // Expose small API for detection / debugging
  var api = window.stiContact || (window.stiContact = {});

  function isValidEmail(email) {
    // Simple but effective validation (demo-safe)
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function safeToast(msg, timeout) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, timeout);
    } else {
      console.info('Toast:', msg);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();

    var name = (document.getElementById('contact-name') || {}).value || '';
    var email = (document.getElementById('contact-email') || {}).value || '';
    var message = (document.getElementById('contact-message') || {}).value || '';

    if (!name.trim() || !email.trim() || !message.trim()) {
      safeToast('Please fill in all required fields.', 2200);
      return;
    }

    if (!isValidEmail(email.trim())) {
      safeToast('Please enter a valid email address.', 2200);
      return;
    }

    // Demo-only success
    safeToast('Thank you, ' + name.trim() + '. Message received!', 2600);

    try {
      var form = document.getElementById('contact-form');
      form.reset();
    } catch (err) {
      console.warn('reset failed:', err);
    }
  }

  function safeInit() {
    var form = document.getElementById('contact-form');
    if (!form || form.__handled) return;

    form.addEventListener('submit', handleSubmit);
    form.__handled = true;

    // Expose function to the global API
    api.handleSubmit = handleSubmit;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
})();
