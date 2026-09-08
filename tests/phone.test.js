const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPhone, normalizePhone, telHref } = require('../src/util');

test('formatPhone: US 10-digit -> (NPA) NXX-XXXX', () => {
  assert.equal(formatPhone('8048397984'), '(804) 839-7984');
  assert.equal(formatPhone('+18048397984'), '(804) 839-7984');
  assert.equal(formatPhone('1-804-839-7984'), '(804) 839-7984');
  assert.equal(formatPhone('(804) 839-7984'), '(804) 839-7984');
});

test('formatPhone: extension preserved on display', () => {
  assert.equal(formatPhone('+18048397984;ext=12'), '(804) 839-7984 x12');
  assert.equal(formatPhone('804-839-7984 x203'), '(804) 839-7984 x203');
});

test('formatPhone: non-US number is never mangled', () => {
  const out = formatPhone('+447911123456');
  assert.ok(out.startsWith('+44'), out);
  assert.ok(out.replace(/\D/g, '').includes('7911123456'), out);
});

test('formatPhone: empty / junk pass through safely', () => {
  assert.equal(formatPhone(''), '');
  assert.equal(formatPhone(null), '');
  assert.equal(formatPhone('call the office'), 'call the office');
});

test('normalizePhone: stores E.164, keeps extension as ;ext=', () => {
  assert.equal(normalizePhone('(804) 839-7984'), '+18048397984');
  assert.equal(normalizePhone('804-839-7984 ext 5'), '+18048397984;ext=5');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
});

test('normalize then format round-trips to human form', () => {
  assert.equal(formatPhone(normalizePhone('804.839.7984')), '(804) 839-7984');
  assert.equal(formatPhone(normalizePhone('8048397984 x9')), '(804) 839-7984 x9');
});

test('telHref: dialable, drops extension, keeps +', () => {
  assert.equal(telHref('+18048397984;ext=12'), '+18048397984');
  assert.equal(telHref('(804) 839-7984'), '8048397984');
});
