// analytics.js — lightweight placeholder charting (no external libs)
(function () {
  'use strict';

  // Expose small API so inline fallback can detect analytics is active
  var api = window.stiAnalytics || (window.stiAnalytics = {});

  function drawPlaceholder(canvas, text) {
    if (!canvas || !canvas.getContext) return;

    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var w = canvas.width;
    var h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.font = '15px sans-serif';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
    ctx.restore();

    canvas.__renderedByAnalytics = true;
  }

  function refreshPlaceholders(topicCanvas, speakerCanvas) {
    if (topicCanvas) {
      drawPlaceholder(topicCanvas, 'Topic chart placeholder — no data');
    }
    if (speakerCanvas) {
      drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — no data');
    }

    if (typeof window.showToast === 'function') {
      window.showToast('Analytics refreshed (placeholder)', 1400);
    } else {
      console.info('Analytics refreshed (placeholder)');
    }
  }

  function safeInit() {
    var topicCanvas = document.getElementById('topic-chart');
    var speakerCanvas = document.getElementById('speaker-chart');

    // Initial draw if not already drawn by fallbacks
    if (topicCanvas && !topicCanvas.__renderedByAnalytics) {
      drawPlaceholder(topicCanvas, 'Topic chart placeholder — no data');
    }
    if (speakerCanvas && !speakerCanvas.__renderedByAnalytics) {
      drawPlaceholder(speakerCanvas, 'Speaker chart placeholder — no data');
    }

    // Bind refresh button
    var refreshBtn = document.getElementById('analytics-refresh');
    if (refreshBtn && !refreshBtn.__handled) {
      refreshBtn.addEventListener('click', function () {
        refreshPlaceholders(topicCanvas, speakerCanvas);
      });
      refreshBtn.__handled = true;
    }

    // Expose API
    api.drawPlaceholder = drawPlaceholder;
    api.refresh = function () {
      refreshPlaceholders(topicCanvas, speakerCanvas);
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
})();
