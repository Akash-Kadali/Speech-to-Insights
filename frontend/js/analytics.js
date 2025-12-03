// analytics.js — lightweight placeholder charting (no external libs)
// Final corrected, defensive, and slightly smarter: will try to fetch analytics data
// from the backend but gracefully falls back to placeholder drawings when needed.
(function () {
  'use strict';

  // Expose small API so inline fallback can detect analytics is active
  var api = window.stiAnalytics || (window.stiAnalytics = {});

  // Config (override via window.STI if needed)
  var METRICS_ENDPOINTS = (window.STI && window.STI.ANALYTICS_ENDPOINTS) || window.STI_ANALYTICS_ENDPOINTS ||
    ['/admin/metrics', '/metrics', '/analytics', '/admin/stats'];
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.ANALYTICS_FETCH_TIMEOUT_MS) || 2500;

  // Normalize endpoints to array
  if (!Array.isArray(METRICS_ENDPOINTS)) {
    if (typeof METRICS_ENDPOINTS === 'string') {
      METRICS_ENDPOINTS = [METRICS_ENDPOINTS];
    } else {
      METRICS_ENDPOINTS = ['/admin/metrics', '/metrics', '/analytics', '/admin/stats'];
    }
  }

  // ---- helpers ----
  function safeToast(msg, t) {
    if (typeof window.showToast === 'function') window.showToast(msg, t || 2000);
    else if (typeof console !== 'undefined') console.info('TOAST:', msg);
  }

  function _tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function fetchJsonWithTimeout(url, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      .then(function (res) {
        clearTimeout(id);
        if (!res.ok) throw new Error('Network response not ok: ' + res.status);
        return res.text().then(function (text) {
          // try straight JSON
          var parsed = _tryParseJson(text);
          if (parsed !== null) return parsed;
          // try first non-empty line (jsonl)
          var first = (text || '').split(/\r?\n/).find(Boolean) || '';
          parsed = _tryParseJson(first);
          if (parsed !== null) return parsed;
          // fallback: return raw text
          return text;
        });
      })
      .finally(function () { clearTimeout(id); });
  }

  async function tryFetchMetrics() {
    for (var i = 0; i < METRICS_ENDPOINTS.length; i++) {
      try {
        var ep = METRICS_ENDPOINTS[i];
        if (!ep) continue;
        var data = await fetchJsonWithTimeout(ep, FETCH_TIMEOUT_MS);
        if (data) return data;
      } catch (e) {
        // try next endpoint
        if (typeof console !== 'undefined') console.debug('metrics fetch failed for', METRICS_ENDPOINTS[i], e && e.message ? e.message : e);
      }
    }
    return null;
  }

  // ---- drawing primitives ----
  function clearCanvas(canvas) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawPlaceholder(canvas, text) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    wrapText(ctx, text, w / 2, h / 2, Math.max(200, w * 0.8), 18);
    ctx.restore();
    canvas.__renderedByAnalytics = true;
  }

  // small helper to wrap text on canvas
  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    var words = String(text || '').split(' ');
    var line = '';
    var lines = [];
    for (var n = 0; n < words.length; n++) {
      var testLine = line + words[n] + ' ';
      var metrics = ctx.measureText(testLine);
      var testWidth = metrics.width;
      if (testWidth > maxWidth && n > 0) {
        lines.push(line.trim());
        line = words[n] + ' ';
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line.trim());
    // center vertically
    var startY = y - ((lines.length - 1) * lineHeight) / 2;
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, startY + i * lineHeight);
    }
  }

  function drawBarChart(canvas, labels, values, opts) {
    if (!canvas || !canvas.getContext) return;
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!values || values.length === 0) {
      drawPlaceholder(canvas, opts.emptyText || 'No data');
      return;
    }

    var padding = 10;
    var chartW = w - padding * 2;
    var chartH = h - padding * 2 - 20; // reserve top area
    var numericVals = values.map(function (v) { return typeof v === 'number' ? v : (parseFloat(v) || 0); });
    var maxVal = Math.max.apply(null, numericVals);
    maxVal = maxVal || 1; // avoid division by zero
    var barGap = Math.max(4, Math.floor(chartW / numericVals.length * 0.08));
    var barW = Math.max(6, Math.floor((chartW - barGap * (numericVals.length - 1)) / numericVals.length));

    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#222';
    ctx.textAlign = 'center';

    numericVals.forEach(function (v, i) {
      var x = padding + i * (barW + barGap);
      var barH = Math.round((Math.max(0, v) / maxVal) * chartH);
      var y = padding + (chartH - barH);
      // bar (use default canvas fillStyle intentionally)
      ctx.fillRect(x, y, barW, barH);
      // label (truncate if long)
      var lbl = labels[i] || '';
      if (lbl.length > 20) lbl = lbl.slice(0, 17) + '...';
      ctx.fillStyle = '#222';
      ctx.fillText(lbl, x + barW / 2, padding + chartH + 12);
    });

    // title
    if (opts.title) {
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#111';
      ctx.fillText(opts.title, w / 2, 14);
    }

    ctx.restore();
    canvas.__renderedByAnalytics = true;
  }

  function drawListOnCanvas(canvas, items, opts) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#333';
    var y = 20;
    var max = Math.min(items.length, 10);
    for (var i = 0; i < max; i++) {
      var it = items[i];
      var t = (it && (it.name || it.topic)) || String(it);
      var count = (it && (it.count || it.value || it.duration)) ? ' — ' + (it.count || it.value || it.duration) : '';
      ctx.fillText(t + count, 10, y);
      y += 18;
    }
    ctx.restore();
    canvas.__renderedByAnalytics = true;
  }

  // ---- high-level refresh ----
  api._lastMetrics = null;
  async function refreshPlaceholders(topicCanvas, speakerCanvas) {
    // Try fetch metrics; if fail, draw placeholders
    var data = null;
    try {
      data = await tryFetchMetrics();
    } catch (e) {
      data = null;
      if (typeof console !== 'undefined') console.debug('tryFetchMetrics error', e && e.message ? e.message : e);
    }

    api._lastMetrics = data;

    if (!data) {
      if (topicCanvas) drawPlaceholder(topicCanvas, 'Topic chart placeholder — no data');
      if (speakerCanvas) drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — no data');
      safeToast('Analytics refreshed (placeholder)', 1400);
      return null;
    }

    // Expect data shape to have e.g. data.topics: [{ name, count }], data.speakers: [{ name, duration }]
    try {
      if (topicCanvas) {
        var topics = data.topics || data.top_topics || data.topics_by_count || data.topK || [];
        if (Array.isArray(topics) && topics.length > 0) {
          var labels = topics.map(function (t) { return (t && (t.name || t.topic)) || String(t); });
          var vals = topics.map(function (t) { return (t && (t.count || t.value || t.score || 0)) || 0; });
          drawBarChart(topicCanvas, labels, vals, { title: 'Top Topics', emptyText: 'No topics' });
        } else {
          // fallback: if data has topicCounts object map
          if (data.topicCounts && typeof data.topicCounts === 'object') {
            var kv = Object.keys(data.topicCounts).map(function (k) { return { name: k, count: data.topicCounts[k] }; });
            kv.sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
            var top = kv.slice(0, 10);
            drawBarChart(topicCanvas, top.map(function (x) { return x.name; }), top.map(function (x) { return x.count; }), { title: 'Top Topics' });
          } else {
            drawPlaceholder(topicCanvas, 'No topic metrics');
          }
        }
      }

      if (speakerCanvas) {
        var speakers = data.speakers || data.speaker_participation || data.speakers_by_time || [];
        if (Array.isArray(speakers) && speakers.length > 0) {
          var sLabels = speakers.map(function (s) { return (s && (s.name || s.speaker)) || String(s); });
          var sVals = speakers.map(function (s) { return (s && (s.duration || s.talk_time || s.value)) || 0; });
          drawBarChart(speakerCanvas, sLabels, sVals, { title: 'Speaker participation', emptyText: 'No speakers' });
        } else if (data.speakerCounts && typeof data.speakerCounts === 'object') {
          var sk = Object.keys(data.speakerCounts).map(function (k) { return { name: k, count: data.speakerCounts[k] }; });
          sk.sort(function (a, b) { return (b.count || 0) - (a.count || 0); });
          var topS = sk.slice(0, 10);
          drawBarChart(speakerCanvas, topS.map(function (x) { return x.name; }), topS.map(function (x) { return x.count; }), { title: 'Speaker participation' });
        } else {
          drawPlaceholder(speakerCanvas, 'No speaker metrics');
        }
      }

      safeToast('Analytics refreshed', 1200);
      return data;
    } catch (e) {
      // Fallback to placeholders if rendering fails
      if (topicCanvas) drawPlaceholder(topicCanvas, 'Topic chart placeholder — error');
      if (speakerCanvas) drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — error');
      if (typeof console !== 'undefined') console.warn('analytics render failed', e);
      safeToast('Analytics refreshed (partial)', 1400);
      return null;
    }
  }

  // ---- initialization ----
  function safeInit() {
    var topicCanvas = document.getElementById('topic-chart');
    var speakerCanvas = document.getElementById('speaker-chart');

    // ensure canvases have reasonable default pixel sizes if not set
    [topicCanvas, speakerCanvas].forEach(function (c) {
      if (!c) return;
      // if canvas has no width/height attributes, set default CSS-based size converted to device pixels
      if (!c.hasAttribute('width')) {
        var rect = c.getBoundingClientRect();
        var w = Math.max(320, Math.min(900, Math.round(rect.width || 640)));
        var h = Math.max(120, Math.round((rect.height && rect.height > 0) ? rect.height : (w * 0.35)));
        // set drawing buffer size to CSS px * devicePixelRatio for crispness
        var ratio = window.devicePixelRatio || 1;
        c.width = Math.floor(w * ratio);
        c.height = Math.floor(h * ratio);
        c.style.width = w + 'px';
        c.style.height = h + 'px';
      } else {
        // respect explicit attrs but ensure pixel ratio
        var ratio = window.devicePixelRatio || 1;
        c.width = Math.floor(c.width * ratio);
        c.height = Math.floor(c.height * ratio);
      }
    });

    // Initial draw if not already drawn by fallbacks
    if (topicCanvas && !topicCanvas.__renderedByAnalytics) {
      drawPlaceholder(topicCanvas, 'Topic chart placeholder — loading');
    }
    if (speakerCanvas && !speakerCanvas.__renderedByAnalytics) {
      drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — loading');
    }

    // Bind refresh button
    var refreshBtn = document.getElementById('analytics-refresh');
    if (refreshBtn && !refreshBtn.__handled) {
      refreshBtn.addEventListener('click', function () {
        // call and ignore promise (UI shows toast)
        refreshPlaceholders(topicCanvas, speakerCanvas).catch(function () { /* swallow */ });
      }, { passive: true });
      refreshBtn.__handled = true;
    }

    // Expose API
    api.drawPlaceholder = drawPlaceholder;
    api.refresh = function () {
      return refreshPlaceholders(topicCanvas, speakerCanvas);
    };
    api.getLast = function () { return api._lastMetrics; };

    // Auto-refresh once when loaded (best-effort)
    // Don't block page load; swallow errors
    (function () {
      try {
        api.refresh();
      } catch (e) { /* ignore */ }
    }());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
})();
