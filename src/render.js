const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Shelves to Drawers RVA';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '(804) 839-7984';

const FAVICON_TAGS = `
<link rel="icon" type="image/x-icon" href="/static/img/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/static/img/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/static/img/favicon-16.png">
<link rel="apple-touch-icon" href="/static/img/apple-touch-icon.png">`;

function dashboardLayout({ title, active, body, flash }) {
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
<title>${title ? title + ' - ' : ''}${BUSINESS_NAME} CRM</title>
${FAVICON_TAGS}
<link rel="stylesheet" href="/static/css/style.css">
</head>
<body>
<div class="topnav">
  <div class="wrap">
    <a class="brand" href="/dashboard">${BUSINESS_NAME} CRM</a>
    <nav>
      ${nav.map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('')}
    </nav>
  </div>
</div>
<main class="wrap">
  ${flash ? `<div class="msg ${flash.type === 'err' ? 'err' : 'ok'}">${flash.text}</div>` : ''}
  ${body}
</main>
${assistantWidget()}
</body>
</html>`;
}

// Office Manager Assistant (BETA) - a small chat box on every dashboard page.
// Submits to /dashboard/assistant/message, which redirects back with the
// result as a flash message (to the changed customer's page when there is
// one). See src/services/assistant.js.
function assistantWidget() {
  return `
<div id="assistant-widget" style="position:fixed;bottom:16px;right:16px;z-index:999;font-family:inherit">
  <details style="background:#1f2430;color:#fff;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.3);width:320px;max-width:90vw">
    <summary style="padding:10px 14px;cursor:pointer;font-weight:600;list-style:none">Assistant (beta)</summary>
    <form method="POST" action="/dashboard/assistant/message" style="padding:0 14px 14px 14px">
      <input type="hidden" name="redirect_to" value="/dashboard">
      <textarea name="message" rows="3" placeholder="e.g. add a lead for Jane Smith, 555-1234, met her at the home show" required
        style="width:100%;box-sizing:border-box;border-radius:6px;border:1px solid #444;padding:8px;font:inherit;resize:vertical"></textarea>
      <button type="submit" style="margin-top:8px;width:100%;padding:8px;border:0;border-radius:6px;background:#4a7dfc;color:#fff;font-weight:600;cursor:pointer">Send</button>
      <p style="margin:8px 0 0;font-size:0.75rem;opacity:0.7">Beta - reviews and confirms on the page it changed. No deletes yet. Remembers the last few messages - use "New conversation" to clear it.</p>
    </form>
    <form method="POST" action="/dashboard/assistant/reset" style="padding:0 14px 14px 14px">
      <input type="hidden" name="redirect_to" value="/dashboard">
      <button type="submit" style="width:100%;padding:6px;border:1px solid #555;border-radius:6px;background:transparent;color:#ccc;font-size:0.8rem;cursor:pointer">New conversation</button>
    </form>
  </details>
</div>`;
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
</head>
<body>
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
