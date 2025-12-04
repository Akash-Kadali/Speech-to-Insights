/**
 * toast.js — Final upgraded
 * Simple, robust, CSS-friendly toast system used across pages.
 * - Auto-creates container if missing
 * - Prevents exact-duplicate messages
 * - Supports queue, stacking, manual clear, and pause-on-hover
 * - Exposes window.showToast and window.toast API
 * - Configurable defaults via window.STI.TOAST_* keys
 *
 * Usage:
 *   showToast('Saved', 2000);
 *   window.toast.show('Hi', { timeout: 4000, type: 'success' });
 *   window.toast.clear();
 */
(function (window, document) {
  'use strict';

  if (!window) return;
  if (window.__stiToastInitialized) return;
  window.__stiToastInitialized = true;

  // ----- Config -----
  const CFG = {
    DEFAULT_TIMEOUT: (window.STI && window.STI.TOAST_DEFAULT_TIMEOUT) || window.STI_TOAST_DEFAULT_TIMEOUT || 3000,
    MAX_VISIBLE: (window.STI && window.STI.TOAST_MAX_VISIBLE) || window.STI_TOAST_MAX_VISIBLE || 3,
    POSITION: (window.STI && window.STI.TOAST_POSITION) || window.STI_TOAST_POSITION || 'bottom-right', // options: top-left/top-right/bottom-left/bottom-right/top-center/bottom-center
    PREVENT_DUPLICATES: (window.STI && typeof window.STI.TOAST_PREVENT_DUPLICATES !== 'undefined') ? window.STI.TOAST_PREVENT_DUPLICATES : true,
    CONTAINER_ID: 'toast'
  };

  // ----- Internal state -----
  const state = {
    queue: [],
    visible: [],
    duplicatesSeen: new Set(),
    container: null,
    closingTimers: new WeakMap()
  };

  // ----- Utilities -----
  function _mkEl(tag, cls) {
    const e = document.createElement(tag || 'div');
    if (cls) e.className = cls;
    return e;
  }

  function _ensureContainer() {
    if (state.container && document.body.contains(state.container)) return state.container;
    let el = document.getElementById(CFG.CONTAINER_ID);
    if (!el) {
      el = _mkEl('div', 'toast-container');
      el.id = CFG.CONTAINER_ID;
      // add positioning class
      el.classList.add(`toast-position-${CFG.POSITION}`);
      // minimal ARIA
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      el.setAttribute('aria-atomic', 'false');
      // attach to body (last to avoid layout jumps)
      try { document.body.appendChild(el); } catch (e) { /* ignore */ }
    } else {
      // ensure positioning class exists
      el.classList.add(`toast-position-${CFG.POSITION}`);
    }
    state.container = el;
    return el;
  }

  // Create a single toast element
  function _createToastElement(message, opts = {}) {
    const wrapper = _mkEl('div', 'toast-item');
    if (opts.type) wrapper.classList.add(`toast-${opts.type}`);
    wrapper.setAttribute('role', 'status');
    wrapper.setAttribute('aria-live', 'polite');
    wrapper.tabIndex = -1;

    const content = _mkEl('div', 'toast-content');
    content.textContent = String(message || '');

    // optional actions area
    const actions = _mkEl('div', 'toast-actions');
    if (opts.action && typeof opts.action === 'object' && opts.action.label && typeof opts.action.onClick === 'function') {
      const btn = _mkEl('button', 'toast-action-btn');
      btn.type = 'button';
      btn.textContent = String(opts.action.label);
      btn.addEventListener('click', (ev) => {
        try { opts.action.onClick(ev); } catch (e) { console.warn('toast action handler error', e); }
      }, { passive: true });
      actions.appendChild(btn);
    }

    // dismiss button
    const closeBtn = _mkEl('button', 'toast-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', (ev) => {
      ev && ev.preventDefault && ev.preventDefault();
      _hideToast(wrapper, true);
    }, { passive: true });

    wrapper.appendChild(content);
    if (actions.children.length) wrapper.appendChild(actions);
    wrapper.appendChild(closeBtn);

    // pause timer on hover / focus
    wrapper.addEventListener('mouseenter', () => _pauseToast(wrapper), { passive: true });
    wrapper.addEventListener('mouseleave', () => _resumeToast(wrapper), { passive: true });
    wrapper.addEventListener('focusin', () => _pauseToast(wrapper), { passive: true });
    wrapper.addEventListener('focusout', () => _resumeToast(wrapper), { passive: true });

    return wrapper;
  }

  // Pause / resume management
  function _pauseToast(el) {
    const t = state.closingTimers.get(el);
    if (!t) return;
    clearTimeout(t.timer);
    state.closingTimers.set(el, Object.assign({}, t, { paused: true, remaining: Math.max(0, (t.end - Date.now())) }));
  }

  function _resumeToast(el) {
    const t = state.closingTimers.get(el);
    if (!t || !t.paused) return;
    const remaining = typeof t.remaining === 'number' ? t.remaining : (t.timeout || CFG.DEFAULT_TIMEOUT);
    const newTimer = setTimeout(() => _hideToast(el, false), remaining);
    state.closingTimers.set(el, { timer: newTimer, timeout: remaining, end: Date.now() + remaining, paused: false });
  }

  // Show next in queue if space available
  function _tryShowNext() {
    const container = _ensureContainer();
    if (!container) return;
    while (state.queue.length && state.visible.length < CFG.MAX_VISIBLE) {
      const item = state.queue.shift();
      _showImmediate(item.message, item.opts);
    }
  }

  // Show a toast immediately (not queued)
  function _showImmediate(message, opts = {}) {
    const container = _ensureContainer();
    if (!container) return null;

    // duplicate prevention check
    const key = opts.key || `${String(message)}|${opts.type || ''}`;
    if (CFG.PREVENT_DUPLICATES) {
      if (state.duplicatesSeen.has(key)) {
        // refresh existing matching visible toast by resetting timeout
        const match = state.visible.find(v => v.key === key);
        if (match) {
          _resetToastTimeout(match.el, opts.timeout || CFG.DEFAULT_TIMEOUT);
          return match.el;
        }
        // otherwise ignore new duplicate
        return null;
      }
      state.duplicatesSeen.add(key);
      // clear dedupe key after reasonable time (avoid unbounded growth)
      setTimeout(() => state.duplicatesSeen.delete(key), Math.max(60000, opts.timeout || CFG.DEFAULT_TIMEOUT));
    }

    const el = _createToastElement(message, opts);
    const obj = { el, key, opts };
    // insert in container (newest last for stacking)
    container.appendChild(el);
    state.visible.push(obj);

    // restart CSS animation by forcing reflow then adding visible class
    el.classList.remove('visible');
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth;
    el.classList.add('visible');

    // set automatic hide
    const timeout = (typeof opts.timeout === 'number' ? opts.timeout : CFG.DEFAULT_TIMEOUT);
    const timer = setTimeout(() => _hideToast(el, false), timeout);
    state.closingTimers.set(el, { timer, timeout, end: Date.now() + timeout, paused: false });

    // Fire event for instrumentation
    try { container.dispatchEvent(new CustomEvent('sti:toast:show', { detail: { message, opts } })); } catch (_) {}

    // trim excess visible to respect MAX_VISIBLE (oldest first)
    if (state.visible.length > CFG.MAX_VISIBLE) {
      const toRemove = state.visible.slice(0, state.visible.length - CFG.MAX_VISIBLE);
      toRemove.forEach(o => _hideToast(o.el, true));
    }

    return el;
  }

  // Reset timeout for an existing toast element
  function _resetToastTimeout(el, timeout) {
    const info = state.closingTimers.get(el);
    try { if (info && info.timer) clearTimeout(info.timer); } catch (_) {}
    const to = typeof timeout === 'number' ? timeout : CFG.DEFAULT_TIMEOUT;
    const t = setTimeout(() => _hideToast(el, false), to);
    state.closingTimers.set(el, { timer: t, timeout: to, end: Date.now() + to, paused: false });
  }

  // Hide & remove a toast element
  function _hideToast(el, immediate) {
    if (!el) return;
    // clear any pending timer
    const info = state.closingTimers.get(el);
    if (info && info.timer) {
      try { clearTimeout(info.timer); } catch (_) {}
      state.closingTimers.delete(el);
    }

    // remove from visible list
    const idx = state.visible.findIndex(v => v.el === el);
    if (idx !== -1) state.visible.splice(idx, 1);

    // animate out then remove
    if (immediate) {
      try { el.remove(); } catch (_) { if (el.parentNode) el.parentNode.removeChild(el); }
      _tryShowNext();
      return;
    }

    el.classList.remove('visible');
    // after animation duration (use 350ms safe window), remove
    const removeDelay = 420;
    setTimeout(() => {
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
      _tryShowNext();
    }, removeDelay);
  }

  // Clear all toasts (queue + visible)
  function _clearAll() {
    // clear queue
    state.queue.length = 0;
    // clear timers + remove visible
    state.visible.slice().forEach(v => {
      const el = v.el;
      const info = state.closingTimers.get(el);
      if (info && info.timer) try { clearTimeout(info.timer); } catch (_) {}
      try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {}
      state.closingTimers.delete(el);
    });
    state.visible.length = 0;
    state.duplicatesSeen.clear();
    const container = _ensureContainer();
    try { container.dispatchEvent(new CustomEvent('sti:toast:clear')); } catch (_) {}
  }

  // Public show function (simple)
  function showToast(message, timeoutOrOpts) {
    const opts = (typeof timeoutOrOpts === 'object') ? timeoutOrOpts : (typeof timeoutOrOpts === 'number' ? { timeout: timeoutOrOpts } : {});
    return window.toast.show(message, opts);
  }

  // Exposed API
  const apiPublic = {
    show(message, opts) {
      // normalize
      const options = Object.assign({}, opts || {});
      // if container has room, show immediate; otherwise queue
      const container = _ensureContainer();
      if (!container) return null;
      // queue if visible >= max
      if (state.visible.length >= CFG.MAX_VISIBLE) {
        state.queue.push({ message, opts: options });
        // return a token / placeholder
        return { queued: true, message, opts: options };
      }
      const el = _showImmediate(message, options);
      return el;
    },
    // shortcut
    toast: showToast,
    clear() {
      _clearAll();
    },
    // configure default options at runtime
    configure(overrides = {}) {
      try {
        if (overrides.DEFAULT_TIMEOUT != null) CFG.DEFAULT_TIMEOUT = Number(overrides.DEFAULT_TIMEOUT);
        if (overrides.MAX_VISIBLE != null) CFG.MAX_VISIBLE = Number(overrides.MAX_VISIBLE);
        if (overrides.PREVENT_DUPLICATES != null) CFG.PREVENT_DUPLICATES = Boolean(overrides.PREVENT_DUPLICATES);
        if (overrides.POSITION) {
          CFG.POSITION = String(overrides.POSITION);
          if (state.container) {
            // adjust classes
            state.container.className = state.container.className.split(/\s+/).filter(Boolean).filter(c => !c.startsWith('toast-position-')).join(' ');
            state.container.classList.add(`toast-position-${CFG.POSITION}`);
          }
        }
        return true;
      } catch (e) { return false; }
    },
    // queue length and visible count
    _state: state
  };

  // attach to window
  try {
    window.toast = window.toast || {};
    window.toast.show = window.toast.show || apiPublic.show;
    window.toast.clear = window.toast.clear || apiPublic.clear;
    window.toast.configure = window.toast.configure || apiPublic.configure;
    // convenience: window.showToast(msg, timeout)
    if (typeof window.showToast !== 'function') window.showToast = showToast;
  } catch (e) {
    // ignore attach failures
  }

  // create container eagerly (not required)
  try { _ensureContainer(); } catch (_) {}

})(window, document);
