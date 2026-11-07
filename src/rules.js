// BUSINESS RULES - plain JavaScript IF/THEN. No AI is called from this file.
export const STATUS = {
  AUTO: 'Auto-approved',
  MANAGER: 'Needs manager approval',
  FINANCE: 'Needs finance approval',
  REVIEW: 'Needs manual review',
  VERIFY: 'Needs manual verification',
  ESCALATED: 'Escalated',
  STANDARD: 'Standard support ticket',
  HAND: 'Check by hand',
  CLASSIFICATION_FAILED: 'CLASSIFICATION_FAILED',
  URGENT: 'Urgent',
  NORMAL: 'Normal',
};
// Statuses where a person must still act.
const HUMAN = new Set([
  STATUS.MANAGER,
  STATUS.FINANCE,
  STATUS.REVIEW,
  STATUS.VERIFY,
  STATUS.ESCALATED,
  STATUS.HAND,
  STATUS.CLASSIFICATION_FAILED,
  STATUS.URGENT,
]);
export const needsHuman = (status) => HUMAN.has(status);

export function parseISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

// Holidays come from the "Holidays" tab of the Sheet as 'YYYY-MM-DD' strings.
const isoOf = (t) => new Date(t).toISOString().slice(0, 10);

export function countWorkingDays(start, end, holidays = []) {
  const skip = new Set(holidays);
  let n = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue; // skip Sunday(0) and Saturday(6)
    if (skip.has(isoOf(t))) continue;      // skip public holidays from the Holidays tab
    n++;
  }
  return n;
}

// Weekday holidays that fall inside the leave (used to explain the rule).
export function holidaysInRange(start, end, holidays = []) {
  const skip = new Set(holidays), hit = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6 && skip.has(isoOf(t))) hit.push(isoOf(t));
  }
  return hit;
}

export function evaluateLeave(f, holidays = []) {
  const s = parseISODate(f.start_date), e = parseISODate(f.end_date);
  if (!s || !e) return { status: STATUS.REVIEW, rule: 'Leave: start or end date missing/invalid', workingDays: null };
  if (e < s) return { status: STATUS.REVIEW, rule: 'Leave: end date is before start date', workingDays: null };
  const wd = countWorkingDays(s, e, holidays);
  const hit = holidaysInRange(s, e, holidays);
  const note = hit.length ? ` (${hit.length} holiday skipped: ${hit.join(', ')})` : '';
  if (wd <= 3) return { status: STATUS.AUTO, rule: `Leave: ${wd} working day(s)${note} <= 3 -> auto-approve`, workingDays: wd, holidaysSkipped: hit };
  return { status: STATUS.MANAGER, rule: `Leave: ${wd} working days${note} > 3 -> manager approval`, workingDays: wd, holidaysSkipped: hit };
}

export function evaluateExpense(f) {
  const a = f.amount;
  if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0)
    return { status: STATUS.VERIFY, rule: 'Expense: amount missing or not a positive number' };
  if (f.receipt_available !== true)
    return { status: STATUS.VERIFY, rule: f.receipt_available === false ? 'Expense: no receipt' : 'Expense: receipt not established from request' };
  if (a <= 2000) return { status: STATUS.AUTO, rule: 'Expense: amount <= INR 2,000 with receipt -> auto-approve' };
  return { status: STATUS.FINANCE, rule: 'Expense: amount > INR 2,000 with receipt -> finance approval' };
}

export function evaluateIT(f) {
  // IT_SUPPORT rule: status depends ONLY on blocked_from_work (true -> "Urgent", false -> "Normal").
  // Severity is recorded in the sheet but must never affect the status.
  // If the AI could not tell whether the person is blocked, a person decides. Never guess "Normal".
  const knownImpact = f.work_impact === 'Cannot work' || f.work_impact === 'No impact';
  if (typeof f.blocked_from_work !== 'boolean' && !knownImpact) {
    return { status: STATUS.REVIEW, rule: 'IT: could not tell if employee is blocked -> manual review' };
  }
  const isBlocked = f.blocked_from_work === true || f.work_impact === 'Cannot work';
  if (isBlocked) {
    return { status: STATUS.URGENT, rule: 'IT: blocked from work -> Urgent' };
  }
  return { status: STATUS.NORMAL, rule: 'IT: not blocked from work -> Normal' };
}

export function evaluate(type, fields, ctx = {}) {
  switch (type) {
    case 'LEAVE': return evaluateLeave(fields, ctx.holidays || []);
    case 'EXPENSE': return evaluateExpense(fields);
    case 'IT_SUPPORT': return evaluateIT(fields);
    case 'OTHER': return { status: STATUS.HAND, rule: 'Other: all OTHER requests are checked by hand' };
    default: return { status: STATUS.CLASSIFICATION_FAILED, rule: 'AI classification is temporarily unavailable. Please retry or send this request for manual review.' };
  }
}
