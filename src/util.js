const crypto = require('crypto');

function newId() {
  return crypto.randomUUID();
}

// Longer, URL-safe token for public (unauthenticated) links - harder to guess than a UUID segment.
function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(cents) {
  const n = Number(cents || 0);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Activity log field/old_value/new_value are free-text - some carry a raw ISO
// timestamp (e.g. a rescheduled scheduled_at) straight through. Rewrite any
// such timestamp to a readable US Eastern string (spec E11) rather than
// leaking "2026-09-20T18:00:00.000Z" into the dashboard. Text with no ISO
// timestamp in it passes through unchanged.
function humanizeActivityValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, (m) => {
    const d = new Date(m);
    if (isNaN(d.getTime())) return m;
    return (
      d.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }) + ' ET'
    );
  });
}

function nowIso() {
  return new Date().toISOString();
}

// Normalize a US-ish phone number to E.164 (+1XXXXXXXXXX) for STORAGE. Falls
// back to stripping non-digits and prefixing + if it already looks
// international. An extension (x123, ext 123, #123) is preserved as ";ext=123"
// on the end so display formatting can pull it back out without polluting the
// dialable number.
function normalizePhone(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  let ext = '';
  const extMatch = s.match(/(?:\s*(?:x|ext\.?|extension|#)\s*)(\d{1,6})\s*$/i);
  if (extMatch) {
    ext = extMatch[1];
    s = s.slice(0, extMatch.index);
  }
  const hadPlus = s.trim().startsWith('+');
  const digits = s.replace(/\D/g, '');
  let core;
  if (hadPlus) {
    core = '+' + digits;
  } else if (digits.length === 10) {
    core = '+1' + digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    core = '+' + digits;
  } else {
    core = digits ? '+' + digits : '';
  }
  if (!core) return '';
  return ext ? `${core};ext=${ext}` : core;
}

// ONE place that turns a stored phone value into the human display form.
// Use this everywhere a phone number is shown - customers, appointments,
// opportunities, jobs, communications, search results, history.
//   +18048397984            -> (804) 839-7984
//   +18048397984;ext=12     -> (804) 839-7984 x12
//   8048397984              -> (804) 839-7984
//   +447911123456           -> +44 7911 123456   (non-US: light spacing, never mangled)
// Anything it doesn't recognize is returned unchanged rather than guessed at.
function formatPhone(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  let s = String(raw).trim();
  let ext = '';
  const extMatch = s.match(/;ext=(\d{1,6})$/i) || s.match(/(?:\s*(?:x|ext\.?|#)\s*)(\d{1,6})\s*$/i);
  if (extMatch) {
    ext = extMatch[1];
    s = s.slice(0, extMatch.index).trim();
  }
  const extSuffix = ext ? ` x${ext}` : '';
  const digits = s.replace(/\D/g, '');
  // US / North American: 10 digits, or 11 starting with 1.
  let na = null;
  if (digits.length === 10) na = digits;
  else if (digits.length === 11 && digits.startsWith('1')) na = digits.slice(1);
  if (na) {
    return `(${na.slice(0, 3)}) ${na.slice(3, 6)}-${na.slice(6)}${extSuffix}`;
  }
  // Other international (starts with +, not +1): group loosely, don't mangle.
  if (s.startsWith('+') && digits.length > 6) {
    const cc = digits.length > 11 ? digits.slice(0, digits.length - 10) : digits.slice(0, 2);
    const rest = digits.slice(cc.length);
    const grouped = rest.replace(/(\d{3,4})(?=\d)/g, '$1 ').trim();
    return `+${cc} ${grouped}${extSuffix}`.trim();
  }
  // Unknown shape - hand back what we were given (minus a parsed ;ext= tag).
  return `${s}${extSuffix}`;
}

// Digits-only value safe to drop into a tel: / sms: link (keeps a leading +).
function telHref(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/;ext=\d+$/i, '');
  const plus = s.trim().startsWith('+');
  const digits = s.replace(/\D/g, '');
  return (plus ? '+' : '') + digits;
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(str || ''));
}

// Relative "due" phrasing for follow-ups / attention items. Past due is
// deliberately loud ("2 days overdue"); near-future is quiet ("in 3 days").
function fmtRelativeDue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const ms = d.getTime() - Date.now();
  const days = Math.round(ms / 86400000);
  if (days < -1) return `${Math.abs(days)} days overdue`;
  if (days === -1) return 'due yesterday';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days <= 7) return `due in ${days} days`;
  return `due ${fmtDate(iso)}`;
}

module.exports = {
  newId,
  newToken,
  escapeHtml,
  fmtMoney,
  fmtDate,
  fmtDateTime,
  humanizeActivityValue,
  fmtRelativeDue,
  nowIso,
  normalizePhone,
  formatPhone,
  telHref,
  isValidEmail,
};
