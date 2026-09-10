const { escapeHtml, formatPhone, telHref } = require('./util');

const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Shelves to Drawers RVA';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '(804) 839-7984';

const FAVICON_TAGS = `
<link rel="icon" type="image/x-icon" href="/static/img/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/static/img/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/static/img/favicon-16.png">
<link rel="apple-touch-icon" href="/static/img/apple-touch-icon.png">`;

// PWA + iOS Home Screen metadata. manifest.json and the icons are served from
// /static. status-bar-style "default" keeps text readable over the dark nav.
const PWA_HEAD = `
<meta name="theme-color" content="#1e3d22">
<link rel="manifest" href="/static/manifest.json">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="The BOS">
<meta name="format-detection" content="telephone=no">`;

// Shown instantly (inline, no network) so an iOS standalone launch never shows
// a black screen while the page/CSS load. Removed as soon as the doc is ready.
const BOOT_SPLASH = `
<div id="boot-splash" style="position:fixed;inset:0;z-index:99999;background:#1e3d22;color:#e9dfc4;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:Georgia,serif">
  <div style="font-size:1.4rem;font-style:italic;font-weight:700">The BOS</div>
  <div style="margin-top:10px;width:26px;height:26px;border:3px solid rgba(233,223,196,.3);border-top-color:#d9a628;border-radius:50%;animation:bootspin .8s linear infinite"></div>
</div>
<style>@keyframes bootspin{to{transform:rotate(360deg)}}</style>
<script>
  (function(){
    function kill(){ var s=document.getElementById('boot-splash'); if(s) s.parentNode.removeChild(s); }
    if(document.readyState!=='loading') setTimeout(kill,0);
    else document.addEventListener('DOMContentLoaded',kill);
    window.addEventListener('load',kill);
    setTimeout(kill,4000); // hard safety net
  })();
</script>`;

// Scroll-position preservation (unchanged behavior, kept from prior work).
const DASH_SCROLL_HEAD = `<script>
  (function() {
    var match = window.location.search.match(/[?&]_scroll=([^&]+)/);
    if (match) {
      var pos = parseInt(decodeURIComponent(match[1]), 10);
      if (!isNaN(pos)) {
        setTimeout(function() { window.scrollTo(0, pos); }, 50);
        setTimeout(function() { window.scrollTo(0, pos); }, 100);
        setTimeout(function() { window.scrollTo(0, pos); }, 200);
      }
    }
  })();
</script>`;
const DASH_SCROLL_BODY = `<script>
  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('form').forEach(function(form) {
      if (!form.querySelector('input[name="_scroll"]')) {
        form.addEventListener('submit', function() {
          var input = document.createElement('input');
          input.type = 'hidden'; input.name = '_scroll';
          input.value = window.pageYOffset || window.scrollY || 0;
          form.appendChild(input);
        });
      }
    });
  });
</script>`;

const PRIMARY_NAV = [
  ['/dashboard', 'Overview'],
  ['/dashboard/customers', 'Customers'],
  ['/dashboard/pipeline', 'Pipeline'],
  ['/dashboard/kpi', 'KPI'],
  ['/dashboard/appointments', 'Appts'],
  ['/dashboard/jobs', 'Jobs'],
  ['/dashboard/finances', 'Bookkeeping'],
];
const MORE_NAV = [
  ['/dashboard/production', 'Production Queue'],
  ['/dashboard/marketing', 'Marketing'],
  ['/dashboard/files', 'Files'],
  ['/dashboard/booking-link', 'Booking Link / QR'],
  ['/dashboard/settings/product-options', 'Product Options'],
  ['/dashboard/files/deleted', 'Deleted Files'],
];

function navHtml(active) {
  const isActive = (href) => (active === href ? ' class="active"' : '');
  const primary = PRIMARY_NAV.map(([h, l]) => `<a href="${h}"${isActive(h)}>${l}</a>`).join('');
  const more = MORE_NAV.map(([h, l]) => `<a href="${h}"${isActive(h)}>${l}</a>`).join('');
  const moreActive = MORE_NAV.some(([h]) => h === active);
  return `
    <nav class="topnav-links">
      ${primary}
      <details class="nav-more"${moreActive ? ' open' : ''}>
        <summary>More</summary>
        <div class="nav-more-menu">${more}</div>
      </details>
    </nav>`;
}

function dashboardLayout({ title, active, body, flash, context }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${title ? title + ' - ' : ''}${BUSINESS_NAME} - The BOS</title>
${FAVICON_TAGS}
${PWA_HEAD}
<link rel="stylesheet" href="/static/css/style.css">
${DASH_SCROLL_HEAD}
</head>
<body class="dash">
${BOOT_SPLASH}
${DASH_SCROLL_BODY}
<div class="topnav">
  <div class="wrap topnav-inner">
    <a class="brand" href="/dashboard">${BUSINESS_NAME} — The BOS</a>
    ${navHtml(active)}
    <a class="nav-logout" href="/logout">Log out</a>
  </div>
</div>
<main class="wrap">
  ${flash ? `<div class="msg ${flash.type === 'err' ? 'err' : 'ok'}">${escapeHtml(flash.text)}</div>` : ''}
  ${body}
</main>
${assistantWidget(context)}
${voiceMode(context)}
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function(){}); });
  }
</script>
</body>
</html>`;
}

// Minimal, nav-free, assistant-free page for the login screen.
function loginLayout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${title || 'Sign in'} - ${BUSINESS_NAME}</title>
${FAVICON_TAGS}
${PWA_HEAD}
<link rel="stylesheet" href="/static/css/style.css">
</head>
<body class="login-body">
<main class="login-card">
  <div class="login-logo">The BOS</div>
  ${body}
</main>
</body>
</html>`;
}

// ---------- shared UI helpers ----------

// Prominent contact + quick-action bar for the top of the customer page.
// Text / Email / Call / Map. Text and Email POST through the BOS so the
// message is actually recorded (see /dashboard/customers/:id/message);
// Call and Map are device handoffs (tel: / maps) and are not logged.
function quickActions(c) {
  const tel = telHref(c.phone);
  const btns = [];
  btns.push(
    c.phone
      ? `<a class="qa" href="#send-text" data-scroll-target>💬<span>Text</span></a>`
      : `<span class="qa disabled">💬<span>Text</span></span>`
  );
  btns.push(
    c.email
      ? `<a class="qa" href="#send-email" data-scroll-target>✉️<span>Email</span></a>`
      : `<span class="qa disabled">✉️<span>Email</span></span>`
  );
  btns.push(
    tel ? `<a class="qa" href="tel:${escapeHtml(tel)}">📞<span>Call</span></a>` : `<span class="qa disabled">📞<span>Call</span></span>`
  );
  btns.push(
    c.address
      ? `<a class="qa" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(c.address)}">📍<span>Map</span></a>`
      : `<span class="qa disabled">📍<span>Map</span></span>`
  );
  return `<div class="quick-actions">${btns.join('')}</div>`;
}

// One collapsible secondary section. Open by default only if `open`.
function section(id, label, inner, { open = false, count } = {}) {
  const badge = count !== undefined && count !== null ? ` <span class="badge">${count}</span>` : '';
  return `<details class="section" id="sec-${id}"${open ? ' open' : ''}>
    <summary>${escapeHtml(label)}${badge}</summary>
    <div class="section-body">${inner}</div>
  </details>`;
}

// Consistent "get me out of here" affordance for sub-pages / editors.
function backLink(href, label = 'Back') {
  return `<p class="back-link"><a href="${href}">&larr; ${escapeHtml(label)}</a></p>`;
}

function phone(v) {
  return escapeHtml(formatPhone(v));
}

// ---------- assistant widget ----------
// Floating chat. This phase's fixes (spec 16-23):
//  - X actually closes to the launcher; minimize collapses to the header bar;
//    reopening restores the conversation, the active customer, and any pending
//    attachment reference.
//  - Enter sends, Shift+Enter makes a newline, the Send button still works.
//  - Attachments upload on their OWN request and are kept as a reference, so a
//    slow/failed assistant call never loses the file. Failed sends keep the
//    typed message + attachment and offer Retry. Auth expiry says so plainly
//    instead of "could not reach the assistant".
//  - The assistant can navigate the BOS (navigate_to_record) without losing
//    context.
//  - Panel is size-capped so the BOS underneath stays usable on a laptop.
function assistantWidget(context) {
  const customerId = context && context.customerId ? context.customerId : '';
  return `
<button id="assistant-launch" type="button" aria-label="Open AI assistant" hidden>AI</button>
<div id="assistant-widget" data-context-customer-id="${customerId}" hidden>
  <div class="aw-head">
    <span class="aw-title">AI Assistant${customerId ? ' · this customer' : ''}</span>
    <span class="aw-head-btns">
      <button type="button" id="aw-min" aria-label="Minimize" title="Minimize">–</button>
      <button type="button" id="aw-close" aria-label="Close" title="Close">×</button>
    </span>
  </div>
  <div class="aw-body">
    <div id="assistant-log" class="aw-log"></div>
    <form id="assistant-form" enctype="multipart/form-data">
      <textarea id="assistant-input" rows="2" placeholder="Ask or tell the BOS…  (Enter sends, Shift+Enter = new line)"></textarea>
      <div class="aw-controls">
        <button id="assistant-send" type="submit">Send</button>
        <label class="aw-file" title="Attach a photo / PDF / receipt">
          <input type="file" name="file" accept=".pdf,.txt,.csv,.jpg,.jpeg,.png,.webp,.gif">📎
        </label>
        <button type="button" id="aw-mic" class="aw-mic" title="Voice input" hidden>🎤</button>
        <button type="button" id="assistant-reset" class="aw-reset" title="New conversation">⟲</button>
      </div>
      <p id="assistant-file-label" class="aw-file-label"></p>
    </form>
  </div>
</div>
<script>
(function () {
  var widget = document.getElementById('assistant-widget');
  var launch = document.getElementById('assistant-launch');
  if (!widget) return;
  var contextCustomerId = widget.getAttribute('data-context-customer-id') || '';
  var log = document.getElementById('assistant-log');
  var form = document.getElementById('assistant-form');
  var input = document.getElementById('assistant-input');
  var sendBtn = document.getElementById('assistant-send');
  var resetBtn = document.getElementById('assistant-reset');
  var fileInput = form.querySelector('input[name="file"]');
  var fileLabel = document.getElementById('assistant-file-label');
  var micBtn = document.getElementById('aw-mic');

  // Pending attachment: once uploaded it becomes { file_id, name, analyzable }.
  // Kept in sessionStorage so a page navigation (incl. one the assistant does)
  // or an accidental reload doesn't drop "you have X attached".
  var ATT_KEY = 'bos_assistant_attachment';
  var pendingAttachment = null;
  try { pendingAttachment = JSON.parse(sessionStorage.getItem(ATT_KEY) || 'null'); } catch (e) {}
  var lastFailedSend = null; // { message } kept for Retry

  function saveAttachment(a) {
    pendingAttachment = a;
    try {
      if (a) sessionStorage.setItem(ATT_KEY, JSON.stringify(a));
      else sessionStorage.removeItem(ATT_KEY);
    } catch (e) {}
    renderFileLabel();
  }
  function renderFileLabel() {
    if (!pendingAttachment) { fileLabel.textContent = ''; return; }
    fileLabel.textContent =
      '📎 ' + pendingAttachment.name +
      (pendingAttachment.analyzable === false ? ' (stored — will be reviewed by hand)' : ' — attached to your next message');
  }
  renderFileLabel();

  var STATE_KEY = 'bos_assistant_state';
  function getState(){
    try {
      var s = localStorage.getItem(STATE_KEY);
      if (s === 'open' || s === 'min' || s === 'closed') return s;
    } catch(e){}
    // First visit: minimized everywhere so the BOS underneath is never covered.
    return 'min';
  }
  function setState(s){ try { localStorage.setItem(STATE_KEY, s); } catch(e){} apply(s); }
  function apply(s){
    widget.classList.toggle('minimized', s === 'min');
    widget.hidden = (s === 'closed');
    launch.hidden = (s !== 'closed');
  }
  apply(getState());

  document.getElementById('aw-min').addEventListener('click', function(e){
    e.stopPropagation();
    setState(getState() === 'min' ? 'open' : 'min');
  });
  document.getElementById('aw-close').addEventListener('click', function(e){
    e.stopPropagation();
    setState('closed');
  });
  launch.addEventListener('click', function(){ setState('open'); setTimeout(function(){ input.focus(); }, 0); });
  document.querySelector('#assistant-widget .aw-head').addEventListener('click', function(e){
    if (e.target.closest('button')) return;
    if (widget.classList.contains('minimized')) setState('open');
  });

  fileInput.addEventListener('change', function () {
    var f = this.files[0] || null;
    this.value = '';
    if (!f) return;
    // ~4.5MB is Anthropic's inline ceiling; bigger files are stored but not analyzed.
    if (f.size > 25 * 1024 * 1024) {
      addBubble('assistant', 'That file is ' + Math.round(f.size / 1024 / 1024) + ' MB — too large to attach here. Add it from the customer or job Files section instead.');
      return;
    }
    fileLabel.textContent = '📎 ' + f.name + ' — uploading…';
    var fd = new FormData();
    fd.append('file', f);
    if (contextCustomerId) fd.append('context_customer_id', contextCustomerId);
    fetch('/dashboard/assistant/upload', { method: 'POST', headers: awHeaders(), body: fd })
      .then(readJson)
      .then(function (d) {
        if (d && d.ok) {
          saveAttachment({ file_id: d.file_id, name: d.filename, analyzable: d.analyzable });
        } else {
          fileLabel.textContent = '';
          addBubble('assistant', (d && d.error) || 'That file could not be uploaded. Try again.');
        }
      })
      .catch(function (err) {
        fileLabel.textContent = '';
        addBubble('assistant', awNetworkMessage(err));
      });
  });

  function awHeaders() {
    // Marks the request as a fetch so an expired session returns JSON 401
    // instead of an HTML redirect that would blow up r.json().
    return { 'Accept': 'application/json', 'X-Requested-With': 'fetch' };
  }
  function readJson(r) {
    return r.text().then(function (t) {
      var d;
      try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: true, _nonjson: true, _status: r.status }; }
      if (r.status === 401 || (d && d.reauth)) {
        d = d || {};
        d.error = true;
        d.summary = d.error && typeof d.error === 'string' ? d.error : 'Your session expired — reload the page to sign back in.';
        d._reauth = true;
      }
      return d;
    });
  }
  function awNetworkMessage(err) {
    if (err && err.name === 'AbortError') return 'That took too long and timed out. Your message is kept — press Retry.';
    return 'Could not reach the assistant (network). Your message is kept — press Retry when you have a connection.';
  }

  // Safety net for spec 23: if any ISO datetime slips into an assistant reply,
  // rewrite it to readable local form rather than showing "2026-09-14T13:00:00Z".
  function humanizeIso(text) {
    return String(text).replace(/\\b(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?)\\b/g, function (m) {
      var d = new Date(m);
      if (isNaN(d.getTime())) return m;
      return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    });
  }
  function addBubble(role, text) {
    var isUser = role === 'user';
    var div = document.createElement('div');
    div.className = 'aw-bubble ' + (isUser ? 'user' : 'bot');
    div.textContent = isUser ? text : humanizeIso(text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }
  function restoreInput(message) {
    // Put the text back so Andrew can tweak and resend instead of only retrying verbatim.
    if (message && !input.value.trim()) input.value = message;
  }
  function showRetry(message) {
    lastFailedSend = { message: message };
    var wrap = document.createElement('div');
    wrap.className = 'aw-retry';
    var btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = 'Retry';
    btn.addEventListener('click', function () {
      wrap.remove();
      doSend(message, true);
    });
    wrap.appendChild(btn);
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }

  fetch('/dashboard/assistant/history', { headers: awHeaders() }).then(readJson).then(function(d){
    (d && d.history || []).forEach(function(m){ addBubble(m.role, m.content); });
  }).catch(function(){});

  function doSend(message, isRetry) {
    if (!message && !pendingAttachment) return;
    if (!isRetry) {
      addBubble('user',
        (message ? message : '') +
        (pendingAttachment ? (message ? '\\n' : '') + '📎 ' + pendingAttachment.name : ''));
      input.value = '';
    }
    sendBtn.disabled = true; sendBtn.textContent = '…';
    var attachmentAtSend = pendingAttachment;

    var fd = new FormData();
    fd.append('message', message || '');
    if (contextCustomerId) fd.append('context_customer_id', contextCustomerId);
    if (attachmentAtSend && attachmentAtSend.file_id) fd.append('file_id', attachmentAtSend.file_id);

    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function(){ ctrl.abort(); }, 120000) : null;

    fetch('/dashboard/assistant/chat', { method: 'POST', headers: awHeaders(), body: fd, signal: ctrl ? ctrl.signal : undefined })
      .then(readJson)
      .then(function (data) {
        data = data || {};
        var b = addBubble('assistant', data.summary || (data.error ? 'The assistant hit an error.' : '(no response)'));
        if (data.error) {
          if (!data._reauth) { restoreInput(message); showRetry(message); }
          return;
        }
        // Success: the attachment has been consumed.
        if (attachmentAtSend && pendingAttachment && pendingAttachment.file_id === attachmentAtSend.file_id) {
          saveAttachment(null);
        }
        lastFailedSend = null;
        var dest = data.navigateTo || (data.changedCustomerId ? '/dashboard/customers/' + data.changedCustomerId : null);
        if (dest && dest !== window.location.pathname) {
          var n = document.createElement('div');
          n.className = 'aw-openhint'; n.textContent = 'Opening…';
          b.appendChild(n);
          setTimeout(function(){ window.location.href = dest; }, 900);
        }
      })
      .catch(function (err) {
        addBubble('assistant', awNetworkMessage(err));
        restoreInput(message);
        showRetry(message);
      })
      .finally(function () {
        if (timer) clearTimeout(timer);
        sendBtn.disabled = false; sendBtn.textContent = 'Send';
        setTimeout(function(){ input.focus(); }, 0);
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    doSend(input.value.trim(), false);
  });

  // Enter sends; Shift+Enter (or Ctrl/Cmd+Enter) makes a newline.
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
      e.preventDefault();
      doSend(input.value.trim(), false);
    }
  });

  resetBtn.addEventListener('click', function () {
    fetch('/dashboard/assistant/reset', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' }, body: 'x=1' })
      .then(function(){ log.innerHTML = ''; saveAttachment(null); lastFailedSend = null; }).catch(function(){});
  });

  // Voice input (Web Speech API) - progressive enhancement only.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    micBtn.hidden = false;
    var rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1;
    var listening = false;
    micBtn.addEventListener('click', function(){
      if (listening) { rec.stop(); return; }
      try { rec.start(); listening = true; micBtn.classList.add('on'); } catch(e){}
    });
    rec.onresult = function(ev){
      var t = ev.results[0][0].transcript;
      input.value = (input.value ? input.value + ' ' : '') + t;
      input.focus();
    };
    rec.onend = function(){ listening = false; micBtn.classList.remove('on'); };
    rec.onerror = function(){ listening = false; micBtn.classList.remove('on'); };
  }

  // In-page anchor scrolling for the quick-action Text/Email buttons - opens
  // any collapsed <details> ancestor so the target is actually visible.
  document.querySelectorAll('[data-scroll-target]').forEach(function(a){
    a.addEventListener('click', function(e){
      var id = a.getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      var p = el.parentElement;
      while (p) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var f = el.matches && el.matches('textarea,input') ? el : el.parentElement.querySelector('textarea,input');
      if (f) setTimeout(function(){ f.focus(); }, 300);
    });
  });
})();
</script>`;
}

// ---------- Voice Mode (spec 10-15, 24-25) ----------
// A full-screen, hands-free voice conversation with the SAME assistant (same
// server-side conversation, same tools, same customer context). Web Speech API,
// zero dependencies. It POSTs to /dashboard/assistant/chat with mode=voice, so
// opening/closing Voice never loses the conversation. Built for the Home Show
// "salesperson briefs, then hands the customer the phone" workflow.
function voiceMode(context) {
  const customerId = context && context.customerId ? context.customerId : '';
  return `
<button id="voice-launch" type="button" aria-label="Start Voice Mode">🎤 <span>Voice</span></button>
<div id="voice-overlay" data-context-customer-id="${customerId}" data-state="idle" hidden>
  <div class="vm-inner">
    <button type="button" id="vm-end" class="vm-end" aria-label="End voice">✕ End</button>
    <div class="vm-status" id="vm-status">Starting…</div>
    <button type="button" id="vm-orb" class="vm-orb" aria-label="Tap to talk"><span class="vm-orb-icon">🎤</span></button>
    <p class="vm-hint">Speak naturally. It listens, answers out loud, then listens again — no buttons. Tap the mic to pause or interrupt.</p>
    <div class="vm-log" id="vm-log"></div>
    <p class="vm-fallback" id="vm-fallback" hidden>This browser's voice support is limited (iPhone Safari especially). It still works one turn at a time — tap the mic, speak, wait for the reply, tap again. For the smoothest experience use Chrome.</p>
  </div>
</div>
<script>
(function () {
  var launch = document.getElementById('voice-launch');
  var overlay = document.getElementById('voice-overlay');
  if (!launch || !overlay) return;
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var synth = window.speechSynthesis;
  var statusEl = document.getElementById('vm-status');
  var logEl = document.getElementById('vm-log');
  var orb = document.getElementById('vm-orb');
  var endBtn = document.getElementById('vm-end');
  var fallbackEl = document.getElementById('vm-fallback');
  var ctxCustomerId = overlay.getAttribute('data-context-customer-id') || '';
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  var rec = null, running = false, speaking = false, busy = false, wantListen = false;

  function setStatus(s, cls) { statusEl.textContent = s; overlay.setAttribute('data-state', cls || 'idle'); }
  function addLine(role, text) {
    var d = document.createElement('div');
    d.className = 'vm-line ' + (role === 'user' ? 'me' : 'ai');
    d.textContent = (role === 'user' ? 'You: ' : '') + text;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
    // Mirror into the text assistant log if it's on the page, so the two views agree.
    var al = document.getElementById('assistant-log');
    if (al) {
      var b = document.createElement('div');
      b.className = 'aw-bubble ' + (role === 'user' ? 'user' : 'bot');
      b.textContent = text;
      al.appendChild(b); al.scrollTop = al.scrollHeight;
    }
  }
  function stripForSpeech(t) { return String(t).replace(/[*_\\\`#>|]/g, '').replace(/\\s+/g, ' ').trim(); }

  function open() {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    if (!SR) {
      setStatus("This browser can't run voice. Use the typing assistant instead.", 'error');
      fallbackEl.hidden = false;
      return;
    }
    if (isIOS) fallbackEl.hidden = false;
    // Unlock speech synthesis inside the tap gesture (needed on iOS).
    try { if (synth) { synth.cancel(); var u0 = new SpeechSynthesisUtterance(' '); u0.volume = 0; synth.speak(u0); } } catch (e) {}
    setStatus('Listening…', 'listening');
    startListening();
  }
  function close() {
    wantListen = false;
    try { if (rec) rec.stop(); } catch (e) {}
    try { if (synth) synth.cancel(); } catch (e) {}
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  function makeRec() {
    var r = new SR();
    r.lang = 'en-US'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    var finalText = '';
    r.onstart = function () { running = true; if (!busy && !speaking) setStatus('Listening…', 'listening'); };
    r.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t + ' '; else interim += t;
      }
      if (interim && !busy) setStatus('\\u201c' + interim.trim() + '\\u201d', 'listening');
      if (speaking) { try { synth.cancel(); } catch (e) {} speaking = false; } // barge-in
    };
    r.onerror = function (ev) {
      running = false;
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        wantListen = false;
        setStatus('Microphone is blocked. Allow mic access, then reopen Voice.', 'error');
      }
    };
    r.onend = function () {
      running = false;
      var said = finalText.trim(); finalText = '';
      if (said) handleUtterance(said);
      else if (wantListen && !busy && !speaking) startListening();
    };
    return r;
  }
  function startListening() {
    if (busy || speaking) return;
    wantListen = true;
    rec = makeRec();
    try { rec.start(); } catch (e) { setTimeout(function () { if (wantListen) startListening(); }, 500); }
  }
  function stopListening() { wantListen = false; try { if (rec) rec.stop(); } catch (e) {} }

  function handleUtterance(text) {
    addLine('user', text);
    busy = true; setStatus('Thinking…', 'thinking');
    var fd = new FormData();
    fd.append('message', text);
    fd.append('mode', 'voice');
    if (ctxCustomerId) fd.append('context_customer_id', ctxCustomerId);
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 120000) : null;
    fetch('/dashboard/assistant/chat', { method: 'POST', headers: { 'Accept': 'application/json', 'X-Requested-With': 'fetch' }, body: fd, signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var d; try { d = t ? JSON.parse(t) : {}; } catch (e) { d = { error: true }; }
        var reply;
        if (d && (d._reauth || d.reauth || /your session expired/i.test(d.error || ''))) reply = 'Your session timed out. Please reload the page and start Voice again.';
        else reply = (d && d.summary) || 'Sorry, I did not catch that. Say it again?';
        addLine('bot', reply);
        speak(reply);
        if (d && d.navigateTo) setTimeout(function () { window.location.href = d.navigateTo; }, 3500);
      })
      .catch(function (err) {
        var msg = (err && err.name === 'AbortError') ? 'That took too long. Let\\'s try again.' : 'I lost the connection. Try again in a moment.';
        addLine('bot', msg); speak(msg);
      })
      .finally(function () { if (timer) clearTimeout(timer); busy = false; });
  }

  function speak(text) {
    var clean = stripForSpeech(text);
    if (!synth || !clean) { if (wantListen) startListening(); return; }
    try { synth.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.03; u.pitch = 1;
    speaking = true; setStatus('Speaking…', 'speaking');
    u.onend = function () { speaking = false; if (wantListen) startListening(); else setStatus('Tap the mic to talk', 'idle'); };
    u.onerror = function () { speaking = false; if (wantListen) startListening(); };
    try { synth.speak(u); } catch (e) { speaking = false; if (wantListen) startListening(); }
  }

  launch.addEventListener('click', open);
  endBtn.addEventListener('click', close);
  orb.addEventListener('click', function () {
    if (busy) return;
    if (speaking) { try { synth.cancel(); } catch (e) {} speaking = false; startListening(); return; }
    if (running) { stopListening(); setStatus('Paused — tap the mic to talk', 'idle'); }
    else { startListening(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) close(); });
})();
</script>`;
}

function publicLayout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title ? title + ' - ' : ''}${BUSINESS_NAME}</title>
${FAVICON_TAGS}
<link rel="stylesheet" href="/static/css/style.css">
<script>
  (function() {
    var pos = localStorage.getItem('__bos_scroll');
    if (pos !== null) {
      localStorage.removeItem('__bos_scroll');
      document.addEventListener('DOMContentLoaded', function() { window.scrollTo(0, parseInt(pos, 10)); });
      window.addEventListener('load', function() { window.scrollTo(0, parseInt(pos, 10)); });
    }
  })();
</script>
</head>
<body>
<script>
  function saveScrollPos() {
    try { localStorage.setItem('__bos_scroll', window.pageYOffset || window.scrollY || 0); } catch (e) {}
  }
  document.addEventListener('click', function(e) {
    var link = e.target.closest && e.target.closest('a[href]');
    if (link) saveScrollPos();
  }, true);
  document.addEventListener('submit', function(e) {
    if (e.target && e.target.tagName === 'FORM') saveScrollPos();
  }, true);
  window.addEventListener('pagehide', saveScrollPos);
  window.addEventListener('beforeunload', saveScrollPos);
  var origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() { saveScrollPos(); origSubmit.call(this); };
</script>
<div class="public-header"><img src="/static/img/logo.png" alt="${BUSINESS_NAME}"></div>
<main class="narrow">
  ${body}
</main>
<footer class="public-footer">${BUSINESS_NAME} &middot; <span class="phone">${BUSINESS_PHONE}</span></footer>
</body>
</html>`;
}

function flashFromQuery(query) {
  if (query.ok) return { type: 'ok', text: query.ok };
  if (query.err) return { type: 'err', text: query.err };
  return null;
}

module.exports = {
  dashboardLayout,
  loginLayout,
  publicLayout,
  flashFromQuery,
  quickActions,
  section,
  backLink,
  phone,
  BUSINESS_NAME,
};
