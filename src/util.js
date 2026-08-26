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

function nowIso() {
  return new Date().toISOString();
}

// Normalize a US-ish phone number to E.164 (+1XXXXXXXXXX). Falls back to
// stripping non-digits and prefixing + if it already looks international.
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  const d = digits.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d ? '+' + d : '';
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(str || ''));
}

module.exports = {
  newId,
  newToken,
  escapeHtml,
  fmtMoney,
  fmtDate,
  fmtDateTime,
  nowIso,
  normalizePhone,
  isValidEmail,
};
