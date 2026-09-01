const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Shelves to Drawers RVA';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '(804) 839-7984';

const FAVICON_TAGS = `
<link rel="icon" type="image/x-icon" href="/static/img/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/static/img/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/static/img/favicon-16.png">
<link rel="apple-touch-icon" href="/static/img/apple-touch-icon.png">`;

function dashboardLayout({ title, active, body, flash, context }) {
  const nav = [
    ['/dashboard', 'Overview'],
    ['/dashboard/funnel', 'Funnel'],
    ['/dashboard/customers', 'Customers'],
    ['/dashboard/appointments', 'Appointments'],
    ['/dashboard/jobs', 'Jobs'],
    ['/dashboard/production', 'Factory Queue'],
    ['/dashboard/settings/product-options', 'Product Options'],
    ['/dashboard/finances', 'Bookkeeping'],
    ['/dashboard/booking-link', 'Booking Link / QR'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title ? title + ' - ' : ''}${BUSINESS_NAME} - The BOS</title>
${FAVICON_TAGS}
<link rel="stylesheet" href="/static/css/style.css">
<script>
  // Extract scroll position from URL immediately
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
</script>
</head>
<body onload="(function() { var match = window.location.search.match(/[?&]_scroll=([^&]+)/); if (match) { var pos = parseInt(decodeURIComponent(match[1]), 10); if (!isNaN(pos)) { window.scrollTo(0, pos); } } })()">
<script>
  // Inject scroll position into every form
  document.addEventListener('DOMContentLoaded', function() {
    var forms = document.querySelectorAll('form');
    forms.forEach(function(form) {
      // Check if form already has scroll input
      if (!form.querySelector('input[name="_scroll"]')) {
        form.addEventListener('submit', function() {
          var input = document.createElement('input');
          input.type = 'hidden';
          input.name = '_scroll';
          input.value = window.pageYOffset || window.scrollY || 0;
          form.appendChild(input);
        });
      }
    });
  });
</script>
<div class="topnav">
  <div class="wrap">
    <a class="brand" href="/dashboard">${BUSINESS_NAME} - The BOS</a>
    <nav>
      ${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('')}
    </nav>
  </div>
</div>
<main class="wrap">
  ${body}
  ${flash ? `<div class="msg ${flash.type === 'err' ? 'err' : 'ok'}" style="margin-top: 24px;">${flash.text}</div>` : ''}
</main>
${assistantWidget(context)}
</body>
</html>`;
}

// Office Manager Assistant (BETA) - a small chat box on every dashboard page.
// Talks to /dashboard/assistant/chat and /dashboard/assistant/history (JSON)
// so replies show up inline as chat bubbles instead of reloading the page.
// context.customerId (when the page passes one, e.g. a customer detail page)
// rides along with each message so "update this record" resolves without
// Andrew having to name the customer. See src/services/assistant.js.
// (/dashboard/assistant/message and /reset still exist as plain form-post
// fallbacks if JS is off.)
function assistantWidget(context) {
  const customerId = context && context.customerId ? context.customerId : '';
  return `
<div id="assistant-widget" data-context-customer-id="${customerId}" style="position:fixed;bottom:16px;right:16px;z-index:999;font-family:inherit">
  <details id="assistant-details" style="background:#1f2430;color:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.3);width:340px;max-width:90vw">
    <summary style="padding:10px 14px;cursor:pointer;font-weight:600;list-style:none">Assistant (beta)</summary>
    <div style="padding:0 14px 14px 14px">
      ${customerId ? `<p style="margin:0 0 6px;font-size:0.72rem;opacity:0.65">Talking about this customer's record</p>` : ''}
      <div id="assistant-log" style="max-height:260px;overflow-y:auto;margin-bottom:8px;display:flex;flex-direction:column;gap:6px"></div>
      <form id="assistant-form" enctype="multipart/form-data">
        <textarea id="assistant-input" rows="3" placeholder="e.g. add a lead for Jane Smith, 555-1234, met her at the home show" required
          style="width:100%;box-sizing:border-box;border-radius:6px;border:1px solid #444;padding:8px;font:inherit;resize:vertical;background:#12151c;color:#fff"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="assistant-send" type="submit" style="flex:1;padding:8px;border:0;border-radius:6px;background:#4a7dfc;color:#fff;font-weight:600;cursor:pointer">Send</button>
          <label style="flex:0;padding:8px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;font-size:0.8rem;cursor:pointer;display:flex;align-items:center">
            <input type="file" name="assistant-file" accept=".pdf,.doc,.docx,.txt,.jpg,.png,.xlsx,.csv" style="display:none">
            📎
          </label>
        </div>
      </form>
      <button id="assistant-reset" type="button" style="margin-top:8px;width:100%;padding:6px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;font-size:0.8rem;cursor:pointer">New conversation</button>
      <p style="margin:8px 0 0;font-size:0.75rem;opacity:0.7">Beta - no deletes yet. Remembers the last few messages.</p>
    </div>
  </details>
</div>
<script>
(function () {
  var widget = document.getElementById('assistant-widget');
  var contextCustomerId = widget.getAttribute('data-context-customer-id') || '';
  var log = document.getElementById('assistant-log');
  var form = document.getElementById('assistant-form');
  var input = document.getElementById('assistant-input');
  var sendBtn = document.getElementById('assistant-send');
  var resetBtn = document.getElementById('assistant-reset');
  var fileInput = form.querySelector('input[name="assistant-file"]');
  var selectedFile = null;

  fileInput.addEventListener('change', function () {
    selectedFile = this.files[0] || null;
    if (selectedFile) {
      addBubble('user', '📎 ' + selectedFile.name);
    }
  });

  function addBubble(role, text) {
    var isUser = role === 'user';
    var div = document.createElement('div');
    div.style.alignSelf = isUser ? 'flex-end' : 'flex-start';
    div.style.background = isUser ? '#4a7dfc' : '#333';
    div.style.color = '#fff';
    div.style.borderRadius = '10px';
    div.style.padding = '6px 10px';
    div.style.fontSize = '0.85rem';
    div.style.maxWidth = '85%';
    div.style.whiteSpace = 'pre-wrap';
    var span = document.createElement('span');
    span.textContent = text;
    div.appendChild(span);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function loadHistory() {
    fetch('/dashboard/assistant/history')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        (data.history || []).forEach(function (m) { addBubble(m.role, m.content); });
      })
      .catch(function () {});
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var message = input.value.trim();
    if (!message && !selectedFile) return;
    
    if (selectedFile) {
      addBubble('user', '📎 ' + selectedFile.name);
    } else if (message) {
      addBubble('user', message);
    }
    
    input.value = '';
    selectedFile = null;
    fileInput.value = '';
    sendBtn.disabled = true;
    sendBtn.textContent = 'Thinking...';
    
    var formData = new FormData();
    formData.append('message', message);
    if (contextCustomerId) formData.append('context_customer_id', contextCustomerId);
    if (selectedFile) formData.append('file', selectedFile);
    
    fetch('/dashboard/assistant/chat', {
      method: 'POST',
      body: formData,
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var bubble = addBubble('assistant', data.summary || '(no response)');
        if (data.changedCustomerId) {
          var note = document.createElement('div');
          note.textContent = 'Opening that record to confirm...';
          note.style.fontSize = '0.72rem';
          note.style.opacity = '0.7';
          note.style.marginTop = '4px';
          bubble.appendChild(note);
          setTimeout(function () {
            window.location.href = '/dashboard/customers/' + data.changedCustomerId;
          }, 1100);
        }
      })
      .catch(function () {
        addBubble('assistant', 'Something went wrong reaching the assistant.');
      })
      .finally(function () {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send';
      });
  });

  resetBtn.addEventListener('click', function () {
    fetch('/dashboard/assistant/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'redirect_to=' + encodeURIComponent(window.location.pathname),
    })
      .then(function () { log.innerHTML = ''; })
      .catch(function () {});
  });

  loadHistory();
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
  // Restore scroll IMMEDIATELY before page renders - this runs synchronously in <head>
  (function() {
    var pos = localStorage.getItem('__bos_scroll');
    if (pos !== null) {
      localStorage.removeItem('__bos_scroll');
      // Restore as soon as possible
      document.addEventListener('DOMContentLoaded', function() {
        window.scrollTo(0, parseInt(pos, 10));
      });
      // Also try immediately after head loads
      window.addEventListener('load', function() {
        window.scrollTo(0, parseInt(pos, 10));
      });
    }
  })();
</script>
</head>
<body>
<script>
  // Save scroll position before EVERY navigation
  window.addEventListener('beforeunload', function() {
    localStorage.setItem('__bos_scroll', window.pageYOffset || window.scrollY || 0);
  });
  // Also catch form submissions
  document.addEventListener('submit', function(e) {
    if (e.target && e.target.tagName === 'FORM') {
      localStorage.setItem('__bos_scroll', window.pageYOffset || window.scrollY || 0);
    }
  }, true);
  // And programmatic form submissions
  var origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    localStorage.setItem('__bos_scroll', window.pageYOffset || window.scrollY || 0);
    origSubmit.call(this);
  };
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

module.exports = { dashboardLayout, publicLayout, flashFromQuery, BUSINESS_NAME };
