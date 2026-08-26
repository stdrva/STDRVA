const BUSINESS_NAME = process.env.BUSINESS_NAME || 'Shelves to Drawers RVA';

function dashboardLayout({ title, active, body, flash }) {
  const nav = [
    ['/dashboard', 'Overview'],
    ['/dashboard/funnel', 'Funnel'],
    ['/dashboard/customers', 'Customers'],
    ['/dashboard/appointments', 'Appointments'],
    ['/dashboard/jobs', 'Jobs'],
    ['/dashboard/production', 'Factory Queue'],
    ['/dashboard/finances', 'Bookkeeping'],
    ['/dashboard/booking-link', 'Booking Link / QR'],
  ];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title ? title + ' - ' : ''}${BUSINESS_NAME} CRM</title>
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
</body>
</html>`;
}

function publicLayout({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title ? title + ' - ' : ''}${BUSINESS_NAME}</title>
<link rel="stylesheet" href="/static/css/style.css">
</head>
<body>
<main class="narrow">
  ${body}
</main>
<footer class="public-footer">${BUSINESS_NAME}</footer>
</body>
</html>`;
}

function flashFromQuery(query) {
  if (query.ok) return { type: 'ok', text: query.ok };
  if (query.err) return { type: 'err', text: query.err };
  return null;
}

module.exports = { dashboardLayout, publicLayout, flashFromQuery, BUSINESS_NAME };
