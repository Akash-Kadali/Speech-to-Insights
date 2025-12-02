// admin.js — admin page behaviors (seed/clear/demo queue)
(function () {
  'use strict';

  // Expose a stable API on window so defensive inline scripts can detect
  // whether the page behaviors are available (the HTML fallbacks check these).
  // Avoid clobbering existing implementations.
  var api = window.stiAdmin || (window.stiAdmin = {});

  function getQueueElement() {
    return document.getElementById('queue-list');
  }

  function renderQueue(list) {
    var ul = getQueueElement();
    if (!ul) return;
    ul.innerHTML = '';

    if (!Array.isArray(list) || list.length === 0) {
      var li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Queue is empty';
      ul.appendChild(li);
      // update aria-live for screenreaders by toggling an attribute
      ul.setAttribute('data-last-render', 'empty');
      return;
    }

    list.forEach(function (it) {
      var li = document.createElement('li');
      li.textContent = it;
      ul.appendChild(li);
    });
    ul.setAttribute('data-last-render', 'populated');
  }

  // Public functions (attached for fallback checks)
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

  // Attach to both window and stiAdmin so other scripts can reuse
  if (typeof window.seedDemoData !== 'function') window.seedDemoData = seedDemoData;
  if (typeof window.clearDemoData !== 'function') window.clearDemoData = clearDemoData;
  api.seedDemoData = seedDemoData;
  api.clearDemoData = clearDemoData;
  api.renderQueue = renderQueue;

  // Helper to fetch JSON with timeout
  async function fetchJsonWithTimeout(url, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 3000;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      var res = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
      clearTimeout(id);
      if (!res.ok) throw new Error('Network response not ok: ' + res.status);
      var text = await res.text();
      // attempt to parse JSON safely
      try { return JSON.parse(text); } catch (e) { throw new Error('Invalid JSON'); }
    } finally {
      clearTimeout(id);
    }
  }

  // Try to fetch real queue from backend; if it fails, leave demo/fallback in place
  async function tryPopulateQueueFromBackend() {
    try {
      var data = await fetchJsonWithTimeout('/admin/queue', 2500);
      if (data && Array.isArray(data.queue)) {
        renderQueue(data.queue);
        return true;
      }
    } catch (e) {
      // intentionally silent — backend optional for demo
      // console.debug('admin queue fetch failed', e);
    }
    return false;
  }

  function safeInit() {
    var seedBtn = document.getElementById('seed-demo-data');
    var clearBtn = document.getElementById('clear-demo-data');

    if (seedBtn && !seedBtn.__handled) {
      seedBtn.addEventListener('click', seedDemoData);
      seedBtn.__handled = true;
    }
    if (clearBtn && !clearBtn.__handled) {
      clearBtn.addEventListener('click', clearDemoData);
      clearBtn.__handled = true;
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
})();
