import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, STATUS as S, countWorkingDays, parseISODate } from '../src/rules.js';

const L = (s, e) => evaluate('LEAVE', { start_date: s, end_date: e });
test('Mon 9 Nov - Wed 11 Nov 2026 = 3 working days -> auto', () => { const r = L('2026-11-09', '2026-11-11'); assert.equal(r.workingDays, 3); assert.equal(r.status, S.AUTO); });
test('Mon-Fri 9-13 Nov 2026 = 5 -> manager', () => { const r = L('2026-11-09', '2026-11-13'); assert.equal(r.workingDays, 5); assert.equal(r.status, S.MANAGER); });
test('weekends are excluded: Fri 13 -> Mon 16 Nov = 2', () => assert.equal(L('2026-11-13', '2026-11-16').workingDays, 2));
test('Sat-Sun only = 0 working days -> auto', () => assert.equal(L('2026-11-14', '2026-11-15').workingDays, 0));
test('Mon 9 - Thu 12 = 4 -> manager (boundary)', () => assert.equal(L('2026-11-09', '2026-11-12').status, S.MANAGER));
test('end before start -> review', () => assert.equal(L('2026-11-12', '2026-11-09').status, S.REVIEW));
test('missing / invalid / impossible dates -> review', () => {
  for (const [a, b] of [[null, '2026-11-09'], ['2026-11-09', null], ['9 Nov', '11 Nov'], ['2026-02-30', '2026-03-01']]) assert.equal(L(a, b).status, S.REVIEW);
});
test('parseISODate rejects bad input', () => { assert.equal(parseISODate('2026-13-01'), null); assert.ok(parseISODate('2026-11-09')); assert.equal(countWorkingDays(parseISODate('2026-11-09'), parseISODate('2026-11-09')), 1); });

const X = (amount, receipt_available) => evaluate('EXPENSE', { amount, receipt_available }).status;
test('expense 1500 + receipt -> auto', () => assert.equal(X(1500, true), S.AUTO));
test('expense exactly 2000 + receipt -> auto', () => assert.equal(X(2000, true), S.AUTO));
test('expense 3500 + receipt -> finance', () => assert.equal(X(3500, true), S.FINANCE));
test('expense 1200 no receipt -> verify', () => assert.equal(X(1200, false), S.VERIFY));
test('receipt unknown (null) is NOT assumed -> verify', () => assert.equal(X(1200, null), S.VERIFY));
test('missing / zero / negative / NaN / string amount -> verify', () => { for (const a of [null, 0, -5, NaN, '1500']) assert.equal(X(a, true), S.VERIFY); });

const T = (f) => evaluate('IT_SUPPORT', f).status;
test('IT: blocked_from_work true -> Urgent regardless of severity', () => {
  assert.equal(T({ blocked_from_work: true, severity: 'Low' }), S.URGENT);
  assert.equal(T({ blocked_from_work: true, severity: 'High' }), S.URGENT);
  assert.equal(T({ work_impact: 'Cannot work', severity: 'Low' }), S.URGENT);
});
test('IT: blocked_from_work false -> Normal regardless of severity', () => {
  assert.equal(T({ blocked_from_work: false, severity: 'High' }), S.NORMAL);
  assert.equal(T({ blocked_from_work: false, severity: 'Low' }), S.NORMAL);
  assert.equal(T({ work_impact: 'No impact', severity: 'High' }), S.NORMAL);
});

test('IT: AI could not tell if blocked -> manual review, never Normal', () => {
  assert.equal(T({ severity: 'High' }), S.REVIEW);
  assert.equal(T({ blocked_from_work: null, work_impact: null }), S.REVIEW);
});

test('Leave: a holiday from the Holidays tab is not a working day', () => {
  const f = { start_date: '2026-12-23', end_date: '2026-12-28' }; // Wed..Mon = 4 weekdays
  assert.equal(evaluate('LEAVE', f).status, S.MANAGER);                                   // no holidays: 4 days
  const r = evaluate('LEAVE', f, { holidays: ['2026-12-25'] });                          // Christmas skipped: 3 days
  assert.equal(r.status, S.AUTO);
  assert.equal(r.workingDays, 3);
  assert.deepEqual(r.holidaysSkipped, ['2026-12-25']);
  assert.equal(evaluate('LEAVE', f, { holidays: ['2026-12-26'] }).workingDays, 4);       // a Saturday holiday changes nothing
});

test('Leave: 0 working days (only holidays/weekends) -> manual review, never auto-approve', () => {
  const r = evaluate('LEAVE', { start_date: '2027-01-26', end_date: '2027-01-26' }, { holidays: ['2027-01-26'] });
  assert.equal(r.status, S.REVIEW);
  assert.equal(r.workingDays, 0);
  assert.equal(evaluate('LEAVE', { start_date: '2026-11-28', end_date: '2026-11-29' }).status, S.REVIEW); // Sat-Sun only
});

test('OTHER -> Check by hand', () => assert.equal(evaluate('OTHER', {}).status, S.HAND));
