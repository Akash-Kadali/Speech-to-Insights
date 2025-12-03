// sessions.js — Final corrected
// Robust session list + detail UI. Defensive fetches with timeout, graceful fallbacks,
// clickable transcript lines that deep-link by time, and stable API on window.sti.sessions.
(function () {
  'use strict';

  var sti = window.sti || (window.sti = {});
  sti.sessions = sti.sessions || {};

  // Configurable endpoints and timeouts (override via window.STI if needed)
  var SESSIONS_ENDPOINT = (window.STI && window.STI.SESSIONS_ENDPOINT) || window.STI_SESSIONS_ENDPOINT || '/sessions';
  var FETCH_TIMEOUT_MS = (window.STI && window.STI.FETCH_TIMEOUT_MS) || 3000;

  // Normalize endpoint if array provided
  if (Array.isArray(SESSIONS_ENDPOINT)) SESSIONS_ENDPOINT = SESSIONS_ENDPOINT[0];

  // Simple toast helper
  function toast(msg, t) {
    if (typeof window.showToast === 'function') return window.showToast(msg, t || 3000);
    try { if (console && console.log) console.log('TOAST:', msg); } catch (e) {}
  }

  // Fetch wrapper with timeout; returns parsed JSON or throws
  function fetchJsonWithTimeout(url, opts, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : FETCH_TIMEOUT_MS;
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs);
    opts = opts || {};
    opts.credentials = opts.credentials || 'same-origin';
    opts.signal = controller.signal;
    return fetch(url, opts)
      .then(function (res) {
        clearTimeout(id);
        if (!res.ok) {
          var err = new Error('Network response not ok: ' + res.status);
          err.status = res.status;
          throw err;
        }
        return res.text().then(function (txt) {
          try { return JSON.parse(txt); } catch (e) { return null; }
        });
      })
      .finally(function () { clearTimeout(id); });
  }

  // Normalise sessions list response shapes to an array
  function _normalizeSessionsList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.sessions)) return payload.sessions;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    // try common nested keys
    var keys = Object.keys(payload || {});
    for (var i = 0; i < keys.length; i++) {
      var v = payload[keys[i]];
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  // Public: fetch sessions list
  async function fetchSessions() {
    try {
      var url = SESSIONS_ENDPOINT;
      var resp = await fetchJsonWithTimeout(url, { method: 'GET' }, FETCH_TIMEOUT_MS);
      return _normalizeSessionsList(resp);
    } catch (e) {
      if (console && console.warn) console.warn('fetchSessions error', e && e.message ? e.message : e);
      return null;
    }
  }

  // Public: fetch single session by id
  async function fetchSession(id) {
    if (!id) return null;
    try {
      var safeId = encodeURIComponent(String(id));
      var base = SESSIONS_ENDPOINT.replace(/\/$/, '');
      var url = base + '/' + safeId;
      var resp = await fetchJsonWithTimeout(url, { method: 'GET' }, FETCH_TIMEOUT_MS);
      return resp || null;
    } catch (e) {
      if (console && console.warn) console.warn('fetchSession error', e && e.message ? e.message : e);
      return null;
    }
  }

  // DOM helpers
  function _makeMuted(text) {
    var li = document.createElement('li');
    li.className = 'muted';
    li.textContent = text;
    return li;
  }

  function renderList(container, sessions) {
    if (!container) return;
    container.innerHTML = '';
    if (!sessions || sessions.length === 0) {
      container.appendChild(_makeMuted('No sessions found'));
      return;
    }

    var frag = document.createDocumentFragment();
    sessions.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'session-item';

      var a = document.createElement('a');
      var sid = s && (s.id || s.session_id || s.upload_id || s.key || s.name) || '';
      a.textContent = (s && (s.title || s.name)) || sid || 'Session';
      try {
        // prefer relative link to sessions page if available
        a.href = '/sessions.html#' + encodeURIComponent(sid);
      } catch (e) {
        a.href = '#';
      }
      a.setAttribute('aria-label', a.textContent);
      li.appendChild(a);

      var meta = document.createElement('div');
      meta.className = 'session-meta muted small';
      var parts = [];
      if (s && s.status) parts.push(String(s.status));
      var dur = (s && s.meta && s.meta.duration) || (s && (s.duration || s.length));
      if (dur != null && !Number.isNaN(Number(dur))) parts.push(Math.round(Number(dur)) + 's');
      meta.textContent = parts.join(' • ');
      li.appendChild(meta);

      frag.appendChild(li);
    });

    container.appendChild(frag);
  }

  // Render a transcript with clickable timestamps that update URL (deep-link)
  function renderSessionDetail(container, session) {
    if (!container) return;
    container.innerHTML = '';

    if (!session) {
      container.appendChild(_makeMuted('Session not found'));
      return;
    }

    var title = document.createElement('h2');
    title.textContent = session.title || session.id || session.session_id || 'Session';
    container.appendChild(title);

    var info = document.createElement('div');
    info.className = 'muted small';
    var status = session.status || session.state || 'unknown';
    var dur = (session.meta && session.meta.duration) || session.duration;
    info.textContent = 'Status: ' + status + (dur != null ? ' • duration: ' + Math.round(Number(dur)) + 's' : '');
    container.appendChild(info);

    // Actions
    var actions = document.createElement('div');
    actions.className = 'session-actions';
    if (session.s3_uri || session.s3 || session.storage_uri) {
      var dl = document.createElement('a');
      dl.className = 'btn muted small';
      dl.textContent = 'Download raw';
      dl.href = session.s3_uri || session.s3 || session.storage_uri;
      dl.target = '_blank';
      actions.appendChild(dl);
    }
    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'btn small';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.addEventListener('click', function () {
      fetchSession(session.id || session.session_id).then(function (s) {
        if (s) renderSessionDetail(container, s);
        else toast('Refresh failed');
      }).catch(function () { toast('Refresh failed'); });
    }, { passive: true });
    actions.appendChild(refreshBtn);
    container.appendChild(actions);

    // Transcript area
    var transcriptWrap = document.createElement('div');
    transcriptWrap.className = 'transcript-wrap';

    function _makeTimeAnchor(sec) {
      var a = document.createElement('a');
      a.href = '#t=' + encodeURIComponent(Math.round(sec));
      a.className = 'time-anchor';
      a.textContent = '[' + (Math.round(sec) + 's') + ']';
      a.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        var sid = session.id || session.session_id || session.upload_id || '';
        try {
          var base = '/sessions.html';
          window.location.href = base + '#' + encodeURIComponent(sid) + '?t=' + encodeURIComponent(Math.round(sec));
        } catch (e) {
          try { window.location.hash = 't=' + encodeURIComponent(Math.round(sec)); } catch (e2) {}
        }
      }, { passive: true });
      return a;
    }

    // Render transcript lines
    if (session.transcript && Array.isArray(session.transcript)) {
      session.transcript.forEach(function (line) {
        var p = document.createElement('p');
        p.className = 'transcript-line';

        var metaSpan = document.createElement('span');
        metaSpan.className = 'transcript-meta small muted';

        var speaker = line && (line.speaker || line.spk) || '';
        var start = null;
        if (line && line.start_time != null) start = Number(line.start_time);
        else if (line && line.start != null) start = Number(line.start);
        if (speaker) metaSpan.textContent = speaker + ' ';
        if (start != null && !Number.isNaN(start)) {
          var timeAnchor = _makeTimeAnchor(start);
          metaSpan.appendChild(timeAnchor);
          metaSpan.appendChild(document.createTextNode(' '));
        }
        p.appendChild(metaSpan);

        var txt = document.createElement('span');
        txt.className = 'transcript-text';
        txt.textContent = line && (line.text || line.content) || '';
        p.appendChild(txt);

        transcriptWrap.appendChild(p);
      });
    } else if (typeof session.transcript === 'string' && session.transcript.trim()) {
      var pre = document.createElement('pre');
      pre.className = 'transcript-pre';
      pre.textContent = session.transcript;
      transcriptWrap.appendChild(pre);
    } else {
      transcriptWrap.appendChild(_makeMuted('Transcript unavailable'));
    }

    container.appendChild(transcriptWrap);
  }

  // Initialize list mode: populate #recent-sessions or #sessions-list
  async function initListMode() {
    var listEl = document.getElementById('recent-sessions') || document.getElementById('sessions-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    listEl.appendChild(_makeMuted('Loading sessions...'));

    var sessions = await fetchSessions();
    if (!sessions) {
      listEl.innerHTML = '';
      listEl.appendChild(_makeMuted('Sessions API not available. Showing demo data.'));
      return;
    }
    renderList(listEl, sessions);
  }

  // Initialize detail mode: read hash and render
  async function initDetailMode() {
    var raw = window.location.hash || '';
    if (!raw) return;

    var hash = raw.replace(/^#/, '');
    var idPart = hash;
    var queryPart = '';
    var qIdx = hash.indexOf('?');
    if (qIdx !== -1) {
      idPart = hash.slice(0, qIdx);
      queryPart = hash.slice(qIdx + 1);
    }

    var id = idPart || '';
    if (!id) return;

    try { id = decodeURIComponent(id); } catch (e) { /* ignore decode errors */ }

    var container = document.getElementById('session-detail') || document.getElementById('session-transcript') || document.getElementById('session-view');
    if (!container) return;
    container.innerHTML = '';
    container.appendChild(_makeMuted('Loading session...'));

    var session = await fetchSession(id);
    if (!session) {
      container.innerHTML = '';
      container.appendChild(_makeMuted('Could not load session details.'));
      return;
    }

    renderSessionDetail(container, session);

    // If queryPart includes t=, scroll/highlight nearest line
    try {
      var params = {};
      if (queryPart) {
        queryPart.split('&').forEach(function (kv) {
          var p = kv.split('=');
          if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
        });
      } else {
        var m = window.location.hash.match(/[?&]t=(\d+)/);
        if (m) params.t = m[1];
      }
      if (params.t) {
        var targetSec = Number(params.t);
        var lines = container.querySelectorAll('.transcript-line');
        if (lines && lines.length) {
          var found = null;
          for (var i = 0; i < lines.length; i++) {
            var a = lines[i].querySelector('.time-anchor');
            if (!a) continue;
            var href = a.getAttribute('href') || '';
            var tt = href.match(/t=(\d+)/);
            var val = null;
            if (tt) val = Number(tt[1]);
            else {
              var txt = a.textContent || '';
              var mm = txt.match(/\[(\d+)s\]/);
              if (mm) val = Number(mm[1]);
            }
            if (val != null && Math.abs(val - targetSec) <= 3) { found = lines[i]; break; }
            if (val != null && val >= targetSec) { found = lines[i]; break; }
          }
          if (!found && lines.length) found = lines[0];
          if (found) {
            found.scrollIntoView({ behavior: 'smooth', block: 'center' });
            found.classList.add('highlight');
            setTimeout(function () { found.classList.remove('highlight'); }, 2200);
          }
        }
      }
    } catch (e) { /* ignore highlight errors */ }
  }

  // Top-level init: decide list vs detail
  function safeInit() {
    if (document.getElementById('session-detail') || (window.location.hash && window.location.hash.length > 1)) {
      try { initDetailMode(); } catch (e) { if (console && console.warn) console.warn('initDetailMode error', e); }
    }
    try { initListMode(); } catch (e) { if (console && console.warn) console.warn('initListMode error', e); }
  }

  // Expose API
  sti.sessions.fetchSessions = fetchSessions;
  sti.sessions.fetchSession = fetchSession;
  sti.sessions.renderList = renderList;
  sti.sessions.renderSessionDetail = renderSessionDetail;
  sti.sessions.initListMode = initListMode;
  sti.sessions.initDetailMode = initDetailMode;
  sti.sessions.init = safeInit;

  // Auto-run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }
})();
