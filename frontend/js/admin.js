// admin.js — admin page behaviors (seed/clear/demo queue)
// Final corrected, defensive, configurable endpoint, exposes stable API on window
(function () {
  'use strict';

  // Stable namespace for reuse/debugging
  var api = window.stiAdmin || (window.stiAdmin = {});

  // Configurable backend endpoint (override from HTML or other script if needed)
  var QUEUE_ENDPOINT = (window.STI && window.STI.ADMIN_QUEUE_ENDPOINT) || window.STI_ADMIN_QUEUE_ENDPOINT || '/admin/queue';
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.ADMIN_FETCH_TIMEOUT_MS) || 2500;

  // Normalize endpoint (allow array or single string)
  if (Array.isArray(QUEUE_ENDPOINT)) QUEUE_ENDPOINT = QUEUE_ENDPOINT[0];

  function getQueueElement() {
    return document.getElementById('queue-list');
  }

  function _makeMutedItem(text) {
    var li = document.createElement('li');
    li.className = 'muted';
    li.textContent = text;
    return li;
  }

  function renderQueue(list) {
    var ul = getQueueElement();
    if (!ul) return;
    ul.innerHTML = '';

    if (!Array.isArray(list) || list.length === 0) {
      ul.appendChild(_makeMutedItem('Queue is empty'));
      // update aria-live for screenreaders by toggling a lightweight attribute
      ul.setAttribute('data-last-render', 'empty');
      return;
    }

    list.forEach(function (it) {
      var li = document.createElement('li');
      // protect against non-string items
      try {
        li.textContent = (typeof it === 'string') ? it : (it.display || it.name || JSON.stringify(it));
      } catch (e) {
        li.textContent = String(it);
      }
      ul.appendChild(li);
    });
    ul.setAttribute('data-last-render', 'populated');
  }

  // Public demo utilities
  function seedDemoData() {
    var sample = [
      'upload_2025-11-30_12:02.wav — processing',
      'meeting_2025-11-29_09:10.mp3 — queued',
      'lecture_2025-11-28_16:45.mp3 — completed'
    ];
    renderQueue(sample);
    if (typeof window.showToast === 'function') window.showToast('Demo data seeded', 1800);
    else console.info('Demo data seeded');
  }

  function clearDemoData() {
    renderQueue([]);
    if (typeof window.showToast === 'function') window.showToast('Demo data cleared', 1200);
    else console.info('Demo data cleared');
  }

  // Expose fallback-safe global functions if not already defined
  if (typeof window.seedDemoData !== 'function') window.seedDemoData = seedDemoData;
  if (typeof window.clearDemoData !== 'function') window.clearDemoData = clearDemoData;

  // Add to api namespace
  api.seedDemoData = seedDemoData;
  api.clearDemoData = clearDemoData;
  api.renderQueue = renderQueue;

  // Helper: parse various JSON/text responses robustly
  function _tryParseJson(text) {
    try { return JSON.parse(text); }
    catch (e) { return null; }
  }

  // Helper: fetch JSON with a timeout; returns parsed JSON or throws
  async function fetchJsonWithTimeout(url, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      var res = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
      clearTimeout(id);
      if (!res.ok) throw new Error('Network response not ok: ' + res.status);
      var text = await res.text();
      // try multiple parse strategies
      var parsed = _tryParseJson(text);
      if (parsed !== null) return parsed;
      // plain text that might represent a JSON line — try first line
      var first = (text || '').split(/\r?\n/).find(Boolean);
      parsed = _tryParseJson(first || '');
      if (parsed !== null) return parsed;
      // fallback: return raw text
      return text;
    } finally {
      clearTimeout(id);
    }
  }

  // Try to fetch real queue from backend; if it fails, leave demo/fallback in place
  async function tryPopulateQueueFromBackend() {
    try {
      var data = await fetchJsonWithTimeout(QUEUE_ENDPOINT, FETCH_TIMEOUT_MS);
      // Accept either array or object shapes: { queue: [...] } or { items: [...] } or plain array
      if (!data) return false;
      if (Array.isArray(data)) {
        renderQueue(data);
        return true;
      }
      if (Array.isArray(data.queue)) {
        renderQueue(data.queue);
        return true;
      }
      if (Array.isArray(data.items)) {
        renderQueue(data.items);
        return true;
      }
      // If data is an object with top-level keys mapping to items, attempt to coerce
      var keys = Object.keys(data || {});
      for (var i = 0; i < keys.length; i++) {
        var v = data[keys[i]];
        if (Array.isArray(v)) {
          renderQueue(v);
          return true;
        }
      }
    } catch (e) {
      // silent — backend optional for demo; but surface minimal log
      if (typeof console !== 'undefined' && console.debug) console.debug('admin queue fetch failed', e);
    }
    return false;
  }

  // Public refresh function (exposed so UI buttons or tests can call it)
  async function refreshQueue() {
    var ul = getQueueElement();
    if (!ul) {
      if (typeof console !== 'undefined') console.warn('No queue element found');
      return false;
    }
    // show a short loading placeholder
    ul.innerHTML = '';
    ul.appendChild(_makeMutedItem('Loading queue...'));
    var ok = await tryPopulateQueueFromBackend();
    if (!ok) {
      // fallback to empty placeholder if backend not present
      renderQueue([]);
      if (typeof window.showToast === 'function') window.showToast('No backend queue available (demo)', 1400);
    } else {
      if (typeof window.showToast === 'function') window.showToast('Queue refreshed', 1200);
    }
    return ok;
  }

  api.refreshQueue = refreshQueue;

  function safeInit() {
    var seedBtn = document.getElementById('seed-demo-data');
    var clearBtn = document.getElementById('clear-demo-data');
    var refreshBtn = document.getElementById('admin-refresh-queue');

    if (seedBtn && !seedBtn.__handled) {
      seedBtn.addEventListener('click', function (ev) { ev.preventDefault(); seedDemoData(); }, { passive: true });
      seedBtn.__handled = true;
    }
    if (clearBtn && !clearBtn.__handled) {
      clearBtn.addEventListener('click', function (ev) { ev.preventDefault(); clearDemoData(); }, { passive: true });
      clearBtn.__handled = true;
    }
    if (refreshBtn && !refreshBtn.__handled) {
      refreshBtn.addEventListener('click', function (ev) { ev.preventDefault(); refreshQueue(); }, { passive: true });
      refreshBtn.__handled = true;
    }

    // If page already has queue items (rendered server-side or earlier), do nothing.
    var ul = getQueueElement();
    var hasContent = ul && ul.children && ul.children.length > 0 && !(ul.children.length === 1 && ul.children[0].classList.contains('muted'));
    if (!hasContent) {
      // first try backend, otherwise render empty placeholder
      tryPopulateQueueFromBackend().then(function (ok) {
        if (!ok) renderQueue([]);
      });
    }
  }

  // Initialize when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // Export API on window.stiAdmin (stable)
  window.stiAdmin = window.stiAdmin || {};
  window.stiAdmin.seedDemoData = window.stiAdmin.seedDemoData || seedDemoData;
  window.stiAdmin.clearDemoData = window.stiAdmin.clearDemoData || clearDemoData;
  window.stiAdmin.renderQueue = window.stiAdmin.renderQueue || renderQueue;
  window.stiAdmin.refreshQueue = window.stiAdmin.refreshQueue || refreshQueue;
  // also keep local reference
  api.seedDemoData = seedDemoData;
  api.clearDemoData = clearDemoData;
  api.renderQueue = renderQueue;
  api.refreshQueue = refreshQueue;
})();
