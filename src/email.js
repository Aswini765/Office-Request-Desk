// EMAIL BUILDER MODULE - builds plain-text notification email entirely in code.
// No Gemini or AI is used to compose the email subject, body, or routing.

export const EMAIL_TO = 'aswini.27196@gmail.com';

export const TEAM_FOR = {
  LEAVE: 'HR',
  EXPENSE: 'Finance',
  IT_SUPPORT: 'IT',
  OTHER: 'Admin',
};

export const PATH_NAME = {
  LEAVE: 'Leave',
  EXPENSE: 'Expense',
  IT_SUPPORT: 'IT Support',
  OTHER: 'Other',
};

export const SHORT_STATUS = {
  'Auto-approved': 'auto-approved',
  'Needs manager approval': 'manager approval',
  'Needs finance approval': 'review',
  'Finance review': 'review',
  'Needs manual verification': 'verification',
  'needs receipt/amount': 'verification',
  'Needs manual review': 'review',
  'Urgent': 'urgent',
  'Urgent IT': 'urgent',
  'Normal': 'normal',
  'Escalated': 'urgent',
  'Standard support ticket': 'ticket',
  'Check by hand': 'review',
  'CLASSIFICATION_FAILED': 'review',
};

export const NEXT_STEPS = {
  'Auto-approved': 'No action needed, approved automatically',
  'Needs manager approval': 'Waiting for manager approval',
  'Needs finance approval': 'Waiting for finance review',
  'Finance review': 'Waiting for finance review',
  'Needs manual verification': 'Waiting for the employee to send the receipt or amount',
  'needs receipt/amount': 'Waiting for the employee to send the receipt or amount',
  'Urgent': 'IT to respond urgently, employee cannot work',
  'Urgent IT': 'IT to respond urgently, employee cannot work',
  'Normal': 'IT to respond in the normal queue',
  'Check by hand': 'A person will check this request',
  'Needs manual review': 'A person will check this request',
  'CLASSIFICATION_FAILED': 'A person will check this request',
  'Escalated': 'IT to respond urgently, employee cannot work',
  'Standard support ticket': 'IT to respond in the normal queue',
};

export function getNextStep(status) {
  return NEXT_STEPS[status] || 'A person will check this request';
}

export function getShortStatus(status) {
  return SHORT_STATUS[status] || (status ? String(status).toLowerCase() : 'review');
}

export function buildShortSummary(rec) {
  const f = rec.extracted || {};
  const cat = rec.category;

  if (cat === 'LEAVE') {
    const type = f.leave_type || 'Leave';
    const days = rec.rule?.workingDays != null
      ? ` ${rec.rule.workingDays} ${rec.rule.workingDays === 1 ? 'day' : 'days'}`
      : '';
    const res = `${type}${days}`.trim();
    if (res && res !== 'Leave') return res;
    if (f.start_date) return `Leave ${f.start_date}${f.end_date ? ' to ' + f.end_date : ''}`;
  } else if (cat === 'EXPENSE') {
    const item = f.category || 'Expense';
    const amt = f.amount != null
      ? ` ₹${typeof f.amount === 'number' ? f.amount.toLocaleString('en-IN') : f.amount}`
      : '';
    const res = `${item}${amt}`.trim();
    if (res && res !== 'Expense') return res;
  } else if (cat === 'IT_SUPPORT') {
    const dev = f.device_or_system ? `${f.device_or_system}: ` : '';
    const issue = f.issue_description || f.issue_category || '';
    const res = `${dev}${issue}`.trim();
    if (res) return res.length > 40 ? res.slice(0, 37) + '...' : res;
  } else if (cat === 'OTHER') {
    const reason = rec.classification?.classification_reason || f.classification_reason || '';
    if (reason) return reason.length > 40 ? reason.slice(0, 37) + '...' : reason;
  }

  const desc = (rec.description || '').trim().replace(/\s+/g, ' ');
  return desc.length > 40 ? desc.slice(0, 37) + '...' : (desc || 'Request');
}

export function formatFacts(rec) {
  const cat = rec.category;
  const f = rec.extracted || {};
  let entries = [];

  if (cat === 'LEAVE') {
    entries = [
      ['start_date', f.start_date],
      ['end_date', f.end_date],
      ['leave_type', f.leave_type],
      ['reason', f.reason],
    ];
  } else if (cat === 'EXPENSE') {
    entries = [
      ['amount', f.amount],
      ['category', f.category],
      ['expense_date', f.expense_date],
      ['receipt_available', f.receipt_available],
      ['business_purpose', f.business_purpose],
    ];
  } else if (cat === 'IT_SUPPORT') {
    entries = [
      ['issue_category', f.issue_category],
      ['severity', f.severity],
      ['device_or_system', f.device_or_system],
      ['work_impact', f.work_impact],
      ['issue_description', f.issue_description],
    ];
    if (f.blocked_from_work !== undefined) {
      entries.push(['blocked_from_work', f.blocked_from_work]);
    }
  } else if (cat === 'OTHER') {
    entries = [
      ['classification_reason', rec.classification?.classification_reason || f.classification_reason || 'N/A'],
    ];
  } else {
    entries = Object.entries(f);
  }

  if (entries.length === 0) {
    return 'none';
  }

  return entries
    .map(([k, v]) => `${k}: ${v === null || v === undefined ? 'null' : v}`)
    .join('\n');
}

export function buildEmail(rec) {
  const cat = rec.category || 'OTHER';
  const path = PATH_NAME[cat] || 'Other';
  const team = TEAM_FOR[cat] || 'Admin';
  const status = rec.rule?.status || 'Needs manual review';
  const shortStatus = getShortStatus(status);
  const summary = buildShortSummary(rec);
  const employeeName = rec.employee || 'Employee';

  // Subject: "[<Path>] <Team> <short status> – <short request summary> – <employee name>"
  // Example: "[Expense] Finance review – Taxi ₹5,000 – Priya"
  const subject = `[${path}] ${team} ${shortStatus} – ${summary} – ${employeeName}`;

  const factsText = formatFacts(rec);
  const ruleText = rec.rule?.rule || 'None';
  const nextStep = getNextStep(status);

  // Body plain text exact structure:
  // Request: <the original request text>
  // From: <name> (<email>)
  // Facts read by AI: <each extracted fact as "field: value", one per line>
  // Status: <status>
  // Rule applied: <the rule text from code>
  // Next step: <what happens next>
  const body = [
    `Request: ${rec.description || ''}`,
    `From: ${rec.employee || ''} (${rec.email || ''})`,
    `Facts read by AI:\n${factsText}`,
    `Status: ${status}`,
    `Rule applied: ${ruleText}`,
    `Next step: ${nextStep}`,
  ].join('\n');

  return {
    to: EMAIL_TO,
    team,
    path,
    subject,
    body,
    nextStep,
  };
}
