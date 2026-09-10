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
