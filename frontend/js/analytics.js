/**
 * analytics.js — Upgraded, defensive, configurable analytics drawing (no external libs)
 *
 * - Tries multiple backend endpoints, falls back to graceful placeholders.
 * - Exposes stable window.stiAnalytics API for integration & testing.
 * - Defensive: tolerant parsing, timeouts, Abort support, and helpful CustomEvents.
 *
 * Public API (window.stiAnalytics):
 *   .refresh() -> Promise resolves to metrics or null
 *   .getLast() -> last fetched metrics (or null)
 *   .setEndpoints(array|string) -> replace endpoints used for probing
 *   ._setFetch(fn) / ._setAbortController(Ctor) -> test hooks
 *
 * Design goals: readable, testable, non-destructive to host page, accessible.
 */
(function () {
  'use strict';

  // ---------- configuration ----------
  const DEFAULT_ENDPOINTS = ['/admin/metrics', '/metrics', '/analytics', '/admin/stats'];
  const cfg = (window.STI && window.STI.ANALYTICS) || window.STI_ANALYTICS || {};

  let endpoints = Array.isArray(cfg.ENDPOINTS) ? cfg.ENDPOINTS.slice()
    : (typeof cfg.ENDPOINTS === 'string' ? [cfg.ENDPOINTS]
      : (Array.isArray(window.STI_ANALYTICS_ENDPOINTS) ? window.STI_ANALYTICS_ENDPOINTS.slice()
        : (typeof window.STI_ANALYTICS_ENDPOINTS === 'string' ? [window.STI_ANALYTICS_ENDPOINTS] : DEFAULT_ENDPOINTS.slice())));

  const DEFAULT_FETCH_TIMEOUT_MS = (Number.isFinite(cfg.FETCH_TIMEOUT_MS) && cfg.FETCH_TIMEOUT_MS) ||
    (Number.isFinite(window.STI_ANALYTICS_FETCH_TIMEOUT_MS) && window.STI_ANALYTICS_FETCH_TIMEOUT_MS) ||
    2500;

  const DRAW_CONFIG = Object.assign({ maxWordCloudItems: 40 }, cfg.DRAW || {});

  // ---------- api surface ----------
  const api = window.stiAnalytics || (window.stiAnalytics = {});
  api._lastMetrics = null;
  api._config = { endpoints: endpoints.slice(), FETCH_TIMEOUT_MS: DEFAULT_FETCH_TIMEOUT_MS, DRAW_CONFIG };

  // Platform wrappers (allow overriding for tests)
  const platform = {
    fetch: (typeof window.fetch === 'function') ? window.fetch.bind(window) : null,
    AbortController: (typeof window.AbortController === 'function') ? window.AbortController : null,
    now: () => Date.now()
  };

  // Allow test overrides via api._setFetch / _setAbortController
  api._fetchOverride = null;
  api._AbortControllerOverride = null;

  // ---------- small utilities ----------
  function _tryParseJson(text) {
    if (text === undefined || text === null) return null;
    if (typeof text === 'object') return text;
    try {
      return JSON.parse(String(text));
    } catch (e) {
      // attempt to parse first non-empty line (JSONL)
      try {
        const first = String(text).split(/\r?\n/).find(Boolean) || '';
        return first ? JSON.parse(first) : null;
      } catch (e2) {
        return null;
      }
    }
  }

  function _toast(msg, ms = 2000) {
    try {
      if (typeof window.showToast === 'function') { window.showToast(msg, ms); return; }
    } catch (e) { /* ignore */ }
    if (console && console.info) console.info('stiAnalytics:', msg);
  }

  // Robust fetch with timeout and parsing
  async function fetchJsonWithTimeout(url, opts = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    if (!url) throw new TypeError('fetchJsonWithTimeout: missing url');

    const fetchFn = api._fetchOverride || platform.fetch;
    if (!fetchFn) throw new Error('Fetch is not available in this environment');

    const AbortCtor = api._AbortControllerOverride || platform.AbortController;
    let controller = null;
    if (AbortCtor) controller = new AbortCtor();

    const finalOpts = Object.assign({}, opts);
    if (controller) finalOpts.signal = controller.signal;
    finalOpts.credentials = finalOpts.credentials || 'same-origin';

    let timer = null;
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(url, finalOpts);
      if (timer) clearTimeout(timer);
      const text = await (res.text ? res.text().catch(() => '') : Promise.resolve(''));
      if (!res.ok) {
        const parsed = _tryParseJson(text) || text || `status ${res.status}`;
        const err = new Error(`Request ${url} failed (${res.status})`);
        err.status = res.status;
        err.body = parsed;
        throw err;
      }
      const parsed = _tryParseJson(text);
      if (parsed !== null) return parsed;
      // fallback: try first non-empty line (JSONL)
      const first = (text || '').split(/\r?\n/).find(Boolean) || '';
      const firstParsed = _tryParseJson(first);
      if (firstParsed !== null) return firstParsed;
      // give raw text as last resort
      return text;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const e = new Error('Request aborted (timeout)');
        e.code = 'ABORT';
        throw e;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- drawing primitives ----------
  function _clearCanvas(canvas) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawPlaceholder(canvas, text) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    // compute logical CSS space
    const cssW = Math.max(320, Math.floor((canvas.width || 640) / ratio));
    const cssH = Math.max(120, Math.floor((canvas.height || 240) / ratio));
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#ffffff';
    // subtle background (respect transparency if host wants)
    // ctx.fillRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#666';
    const fontSize = Math.max(12, Math.round(cssH * 0.05));
    ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    _wrapText(ctx, text || 'No data', cssW / 2, cssH / 2, Math.max(120, cssW * 0.8), Math.max(16, fontSize + 4));
    ctx.restore();
    canvas.__renderedByAnalytics = true;
  }

  function _wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = String(text || '').split(' ');
    let line = '';
    const lines = [];
    for (let i = 0; i < words.length; i++) {
      const testLine = line ? (line + ' ' + words[i]) : words[i];
      const tm = ctx.measureText(testLine).width;
      if (tm > maxWidth && line) {
        lines.push(line);
        line = words[i];
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line);
    const startY = y - ((lines.length - 1) * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, startY + i * lineHeight);
    }
  }

  // simple bar chart: neutral, no color hardcoding required by consumer
  function drawBarChart(canvas, labels = [], values = [], opts = {}) {
    if (!canvas || !canvas.getContext) return;
    if (!Array.isArray(values) || values.length === 0) {
      drawPlaceholder(canvas, opts.emptyText || 'No data');
      return;
    }

    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const cssW = Math.max(320, Math.floor(canvas.width / ratio));
    const cssH = Math.max(120, Math.floor(canvas.height / ratio));
    const padding = Math.max(6, Math.round(cssW * 0.04));
    const chartW = cssW - padding * 2;
    const chartH = cssH - padding * 2 - 28;
    const numeric = values.map(v => (typeof v === 'number' ? v : (parseFloat(v) || 0)));
    const maxVal = Math.max.apply(null, numeric) || 1;
    const count = Math.max(1, numeric.length);
    const gap = Math.max(4, Math.floor(chartW / count * 0.06));
    const barW = Math.max(6, Math.floor((chartW - gap * (count - 1)) / count));

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(ratio, ratio);

    // optional title
    if (opts.title) {
      ctx.font = `${Math.max(12, Math.round(cssH * 0.035))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = opts.titleColor || '#222';
      ctx.fillText(opts.title, cssW / 2, Math.max(16, Math.round(cssH * 0.04)));
    }

    // bars
    const baseY = padding + chartH;
    ctx.textAlign = 'center';
    ctx.font = `${Math.max(10, Math.round(cssH * 0.03))}px system-ui, sans-serif`;
    numeric.forEach((v, i) => {
      const x = padding + i * (barW + gap);
      const barH = Math.round((Math.max(0, v) / maxVal) * chartH);
      const y = baseY - barH;
      // bar fill
      ctx.fillStyle = (opts.barColor || '#2b6') ; // neutral default but overrideable
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(barW), Math.round(barH));
      // label (shorten if needed)
      const label = (labels && labels[i]) ? String(labels[i]) : '';
      const shortLabel = label.length > 20 ? label.slice(0, 17) + '...' : label;
      ctx.fillStyle = opts.labelColor || '#444';
      ctx.fillText(shortLabel, Math.round(x + barW / 2), baseY + 16);
    });

    ctx.restore();
    canvas.__renderedByAnalytics = true;
  }

  function drawListOnCanvas(canvas, items = [], opts = {}) {
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const cssW = Math.max(320, Math.floor(canvas.width / ratio));
    const cssH = Math.max(120, Math.floor(canvas.height / ratio));
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(ratio, ratio);
    ctx.font = `${Math.max(10, Math.round(cssH * 0.03))}px system-ui, sans-serif`;
    ctx.fillStyle = opts.textColor || '#333';
    let y = Math.max(18, Math.round(cssH * 0.05));
    const max = Math.min(items.length, opts.maxItems || DRAW_CONFIG.maxWordCloudItems || 10);
    for (let i = 0; i < max; i++) {
      const it = items[i];
      const txt = (it && (it.name || it.topic || it.text || String(it))) || String(it);
      const suffix = (it && (it.count || it.value || it.score)) ? ' — ' + (it.count || it.value || it.score) : '';
      ctx.fillText(String(txt) + suffix, 10, y);
      y += Math.max(16, Math.round(cssH * 0.045));
      if (y > cssH - 10) break;
    }
    ctx.restore();
    canvas.__renderedByAnalytics = true;
  }

  // ---------- high-level refresh & rendering ----------
  async function tryFetchMetrics() {
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      if (!ep) continue;
      try {
        const data = await fetchJsonWithTimeout(ep, { method: 'GET' }, DEFAULT_FETCH_TIMEOUT_MS);
        if (data) {
          // emit success event
          document.dispatchEvent(new CustomEvent('sti:analytics:fetch:ok', { detail: { endpoint: ep, data } }));
          return data;
        }
      } catch (err) {
        // debug but continue to next endpoint
        if (console && console.debug) console.debug('tryFetchMetrics failed for', ep, err && err.message ? err.message : err);
        document.dispatchEvent(new CustomEvent('sti:analytics:fetch:error', { detail: { endpoint: ep, error: err && (err.message || err) } }));
      }
    }
    document.dispatchEvent(new CustomEvent('sti:analytics:fetch:none', { detail: { endpoints: endpoints.slice() } }));
    return null;
  }

  async function refreshPlaceholders(topicCanvas, speakerCanvas, wordCloudEl) {
    let data = null;
    try {
      data = await tryFetchMetrics();
    } catch (e) {
      data = null;
      if (console && console.debug) console.debug('tryFetchMetrics threw', e);
    }

    api._lastMetrics = data;

    if (!data) {
      if (topicCanvas) drawPlaceholder(topicCanvas, 'Topic chart placeholder — no data');
      if (speakerCanvas) drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — no data');
      if (wordCloudEl) {
        if (!wordCloudEl.children || wordCloudEl.children.length === 0) {
          wordCloudEl.innerHTML = '<p class="muted">No keywords to display. Upload sessions to populate analytics.</p>';
        }
      }
      _toast('Analytics refreshed (placeholder)', 1400);
      document.dispatchEvent(new CustomEvent('sti:analytics:refresh', { detail: { ok: false, data: null } }));
      return null;
    }

    try {
      // Topics -> bar chart
      if (topicCanvas) {
        const topics =
          data.topics || data.top_topics || data.topics_by_count || data.topK ||
          (data.topicCounts ? Object.keys(data.topicCounts).map(k => ({ name: k, count: data.topicCounts[k] })) : null);
        if (Array.isArray(topics) && topics.length > 0) {
          const labels = topics.map(t => (t && (t.name || t.topic)) || String(t));
          const vals = topics.map(t => (t && (t.count || t.value || t.score || 0)) || 0);
          drawBarChart(topicCanvas, labels, vals, { title: 'Top Topics', emptyText: 'No topics', barColor: '#1f6' });
        } else {
          drawPlaceholder(topicCanvas, 'No topic metrics');
        }
      }

      // Speakers -> bar chart
      if (speakerCanvas) {
        const speakers = data.speakers || data.speaker_participation || data.speakers_by_time ||
          (data.speakerCounts ? Object.keys(data.speakerCounts).map(k => ({ name: k, count: data.speakerCounts[k] })) : null);
        if (Array.isArray(speakers) && speakers.length > 0) {
          const labels = speakers.map(s => (s && (s.name || s.speaker)) || String(s));
          const vals = speakers.map(s => (s && (s.duration || s.talk_time || s.value || s.count)) || 0);
          drawBarChart(speakerCanvas, labels, vals, { title: 'Speaker participation', emptyText: 'No speakers', barColor: '#36a' });
        } else {
          drawPlaceholder(speakerCanvas, 'No speaker metrics');
        }
      }

      // Keywords / word cloud -> DOM render (prefer DOM for accessibility)
      if (wordCloudEl) {
        const kws = data.keywords || data.top_keywords || data.wordcloud || data.topTerms || data.key_terms || [];
        if (Array.isArray(kws) && kws.length > 0) {
          wordCloudEl.innerHTML = '';
          const frag = document.createDocumentFragment();
          const max = Math.min(kws.length, DRAW_CONFIG.maxWordCloudItems || 40);
          for (let i = 0; i < max; i++) {
            const k = kws[i];
            const span = document.createElement('span');
            span.className = 'keyword-item';
            span.textContent = (k && (k.text || k.word || k.name || String(k))) || String(k);
            span.setAttribute('role', 'listitem');
            frag.appendChild(span);
          }
          wordCloudEl.appendChild(frag);
        } else {
          if (!wordCloudEl.children || wordCloudEl.children.length === 0) {
            wordCloudEl.innerHTML = '<p class="muted">No keywords to display.</p>';
          }
        }
      }

      _toast('Analytics refreshed', 1200);
      document.dispatchEvent(new CustomEvent('sti:analytics:refresh', { detail: { ok: true, data } }));
      return data;
    } catch (e) {
      // partial failure: draw placeholders
      if (topicCanvas) drawPlaceholder(topicCanvas, 'Topic chart placeholder — error');
      if (speakerCanvas) drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — error');
      if (console && console.warn) console.warn('analytics render failed', e);
      _toast('Analytics refreshed (partial)', 1400);
      document.dispatchEvent(new CustomEvent('sti:analytics:refresh', { detail: { ok: false, data: null, error: e && (e.message || e) } }));
      return null;
    }
  }

  // ---------- initialization ----------
  function safeInit() {
    try {
      const topicCanvas = document.getElementById('topic-chart');
      const speakerCanvas = document.getElementById('speaker-chart');
      const wordCloudEl = document.getElementById('wordcloud');
      const refreshBtn = document.getElementById('analytics-refresh');

      // ensure crisp buffer sizing (caller can override sizing later)
      [topicCanvas, speakerCanvas].forEach(c => {
        if (!c || !c.getContext) return;
        try {
          const rect = c.getBoundingClientRect();
          const cssW = Math.max(320, Math.round(rect.width || 640));
          const cssH = Math.max(120, Math.round(rect.height || Math.floor(cssW * 0.35)));
          const ratio = window.devicePixelRatio || 1;
          c.width = Math.floor(cssW * ratio);
          c.height = Math.floor(cssH * ratio);
          c.style.width = `${cssW}px`;
          c.style.height = `${cssH}px`;
        } catch (e) {
          // non-fatal
        }
      });

      // initial placeholders
      if (topicCanvas && !topicCanvas.__renderedByAnalytics) drawPlaceholder(topicCanvas, 'Topic chart placeholder — loading');
      if (speakerCanvas && !speakerCanvas.__renderedByAnalytics) drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — loading');
      if (wordCloudEl && (!wordCloudEl.children || wordCloudEl.children.length === 0)) wordCloudEl.innerHTML = '<p class="muted">No keywords to display.</p>';

      if (refreshBtn && !refreshBtn.__handled) {
        refreshBtn.addEventListener('click', function () {
          refreshPlaceholders(topicCanvas, speakerCanvas, wordCloudEl).catch(() => {});
        }, { passive: true });
        refreshBtn.addEventListener('keydown', function (ev) {
          if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
            ev.preventDefault();
            refreshPlaceholders(topicCanvas, speakerCanvas, wordCloudEl).catch(() => {});
          }
        }, { passive: true });
        refreshBtn.__handled = true;
      }

      // expose API
      api.drawPlaceholder = drawPlaceholder;
      api.drawBarChart = drawBarChart;
      api.drawListOnCanvas = drawListOnCanvas;
      api.refresh = function () {
        return refreshPlaceholders(topicCanvas, speakerCanvas, wordCloudEl);
      };
      api.getLast = function () { return api._lastMetrics; };
      api.setEndpoints = function (ep) {
        if (!ep) return;
        endpoints = Array.isArray(ep) ? ep.slice() : (typeof ep === 'string' ? [ep] : endpoints);
        api._config.endpoints = endpoints.slice();
        document.dispatchEvent(new CustomEvent('sti:analytics:endpoints:set', { detail: { endpoints: endpoints.slice() } }));
      };

      // test hooks
      api._setFetch = function (fn) { api._fetchOverride = fn; };
      api._setAbortController = function (Ctor) { api._AbortControllerOverride = Ctor; };
      api._resetOverrides = function () { delete api._fetchOverride; delete api._AbortControllerOverride; };

      // auto-refresh once (best-effort)
      (async function () {
        try { await api.refresh(); } catch (e) { /* swallow */ }
      }());

      // ready event
      document.dispatchEvent(new CustomEvent('sti:analytics:ready', { detail: { endpoints: endpoints.slice() } }));
    } catch (e) {
      if (console && console.warn) console.warn('stiAnalytics safeInit failed', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }

  // expose internals for testing / debug completeness
  api._fetchJsonWithTimeout = fetchJsonWithTimeout;
  api.tryFetchMetrics = tryFetchMetrics;
  api._drawPlaceholder = drawPlaceholder;
  api._drawBarChart = drawBarChart;
  api._drawListOnCanvas = drawListOnCanvas;

  // final assignment
  window.stiAnalytics = window.stiAnalytics || api;
})();
