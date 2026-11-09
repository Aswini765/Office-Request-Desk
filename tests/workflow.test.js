// These use STUB Gemini and STUB Sheets to prove controller wiring and retry semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processRequest, retrySave } from '../src/workflow.js';
import { buildRow, saveToSheets, objectToRow, runSheetsDiagnostic, EXPECTED_COLUMNS } from '../src/sheets.js';
import { validateClassification, normalizeExtraction, callGemini } from '../src/gemini.js';
import { buildEmail, EMAIL_TO, NEXT_STEPS, TEAM_FOR } from '../src/email.js';

const input = { name: 'Asha Rao', email: 'asha@example.com', description: 'test request' };
const mk = (over = {}) => {
  const saved = [];
  return {
    saved,
    classify: async () => ({ type: 'LEAVE', classification_reason: 'leave', is_unclear: false, has_multiple_categories: false }),
    extract: async () => ({ start_date: '2026-11-09', end_date: '2026-11-11', leave_type: 'Casual Leave', reason: 'Family' }),
    save: async (tab, row) => { saved.push({ tab, row }); return { ok: true, tab, row: 2, error: null, maybeDuplicate: false }; },
    now: () => new Date('2026-11-05T09:00:00Z'),
    ...over,
  };
};

// 1. A valid three-day leave request
test('Case 1: valid three-day leave request -> LEAVE, Auto-approved, saved to Leave tab', async () => {
  const d = mk();
  const r = await processRequest(input, d);
  assert.equal(r.category, 'LEAVE');
  assert.equal(r.rule.status, 'Auto-approved');
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].tab, 'Leave');
  assert.equal(d.saved[0].row.length, 11);
  assert.deepEqual(d.saved[0].row.slice(4, 9), ['2026-11-09', '2026-11-11', 'Casual Leave', 'Family', 3]);
  assert.equal(r.save.ok, true);
  assert.equal(r.save.row, 2);
});

// 2. A leave request longer than three working days
test('Case 2: leave request longer than 3 working days -> LEAVE, Needs manager approval, saved to Leave tab', async () => {
  const d = mk({
    extract: async () => ({ start_date: '2026-11-09', end_date: '2026-11-13', leave_type: 'Annual Leave', reason: 'Trip' }),
  });
  const r = await processRequest(input, d);
  assert.equal(r.category, 'LEAVE');
  assert.equal(r.rule.status, 'Needs manager approval');
  assert.equal(r.rule.workingDays, 5);
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].tab, 'Leave');
  assert.equal(d.saved[0].row[9], 'Needs manager approval');
});

// 3. A genuine Other request
test('Case 3: genuine Other request -> OTHER, Check by hand, saved to Other tab', async () => {
  const d = mk({
    classify: async () => ({ type: 'OTHER', classification_reason: 'Desk chair ergonomic assessment', is_unclear: false, has_multiple_categories: false }),
    extract: async () => ({}),
  });
  const r = await processRequest(input, d);
  assert.equal(r.category, 'OTHER');
  assert.equal(r.rule.status, 'Check by hand');
  assert.equal(r.needsHuman, true);
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].tab, 'Other');
  assert.equal(d.saved[0].row.length, 7);
  assert.equal(d.saved[0].row[4], 'Desk chair ergonomic assessment');
});

// 4. An ambiguous mixed request
test('Case 4: ambiguous mixed request -> forces OTHER, Check by hand, saved to Other tab', async () => {
  const d = mk({
    classify: async () => ({ type: 'LEAVE', classification_reason: 'I need leave and also reimburse travel expenses', is_unclear: false, has_multiple_categories: true }),
  });
  const r = await processRequest(input, d);
  assert.equal(r.category, 'OTHER');
  assert.equal(r.rule.status, 'Check by hand');
  assert.equal(r.needsHuman, true);
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].tab, 'Other');
});

// 5. Simulated Gemini HTTP 503 response
test('Case 5: simulated Gemini HTTP 503 -> retries 3 times, status CLASSIFICATION_FAILED, never OTHER, never saved to Sheets', async () => {
  let callCount = 0;
  const d = mk({
    classify: async () => {
      callCount++;
      throw new Error('Gemini API returned HTTP 503: The model is overloaded. Please try again later.');
    },
  });
  const r = await processRequest(input, d);
  assert.equal(callCount, 1);
  assert.equal(r.category, null);
  assert.notEqual(r.category, 'OTHER');
  assert.equal(r.rule.status, 'CLASSIFICATION_FAILED');
  assert.equal(r.needsHuman, true);
  assert.equal(r.rule.rule, 'AI classification is temporarily unavailable. Please retry or send this request for manual review.');
  assert.equal(r.tab, null);
  assert.equal(r.row, null);
  assert.equal(d.saved.length, 0); // MUST NEVER SAVE TO SHEETS
  assert.equal(r.save.ok, false);
  assert.equal(r.save.skipped, true);
});

// 6. Successful Gemini response after a temporary failure
test('Case 6: callGemini retries on HTTP 503 with exponential backoff and succeeds on subsequent attempt', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-valid-gemini-key-for-test';
  let attempts = 0;
  const delays = [];
  const fakeFetch = async () => {
    attempts++;
    if (attempts === 1) {
      return { ok: false, status: 503, json: async () => ({ error: { message: 'The model is overloaded.' } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ type: 'LEAVE', classification_reason: 'vacation', is_unclear: false, has_multiple_categories: false }) }] } }],
      }),
    };
  };

  try {
    const res = await callGemini('test prompt', {
      fetchImpl: fakeFetch,
      maxAttempts: 3,
      initialDelayMs: 10,
      sleepImpl: (ms) => { delays.push(ms); return Promise.resolve(); },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [10]);
    assert.equal(res.type, 'LEAVE');
  } finally {
    process.env.GEMINI_API_KEY = originalKey;
  }
});

// 7. Simulated HTTP 503 exhaustion in callGemini (retries exactly 3 times)
test('callGemini retries up to 3 times on HTTP 503 with exponential backoff before throwing', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-valid-gemini-key-for-test';
  let attempts = 0;
  const delays = [];
  const fakeFetch = async () => {
    attempts++;
    return { ok: false, status: 503, json: async () => ({ error: { message: 'Overloaded' } }) };
  };

  try {
    await assert.rejects(
      () => callGemini('test prompt', {
        fetchImpl: fakeFetch,
        maxAttempts: 3,
        initialDelayMs: 50,
        sleepImpl: (ms) => { delays.push(ms); return Promise.resolve(); },
      }),
      /Gemini API returned HTTP 503/
    );
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [50, 100]);
  } finally {
    process.env.GEMINI_API_KEY = originalKey;
  }
});

// 8. Non-retryable errors stop immediately without retrying
test('callGemini does not retry client errors such as 400 or 401', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'mock-valid-gemini-key-for-test';
  let attempts = 0;
  const fakeFetch = async () => {
    attempts++;
    return { ok: false, status: 401, json: async () => ({ error: { message: 'API key not valid' } }) };
  };

  try {
    await assert.rejects(
      () => callGemini('test prompt', {
        fetchImpl: fakeFetch,
        maxAttempts: 3,
        initialDelayMs: 50,
        sleepImpl: () => Promise.resolve(),
      }),
      /Gemini API returned HTTP 401/
    );
    assert.equal(attempts, 1);
  } finally {
    process.env.GEMINI_API_KEY = originalKey;
  }
});

test('Gemini cannot override status: extra "status" field is ignored', () => {
  assert.equal(normalizeExtraction('LEAVE', { start_date: '2026-11-09', end_date: '2026-11-09', status: 'Auto-approved' }).status, undefined);
});

test('extraction failure -> empty fields -> manual review, not approval', async () => {
  const r = await processRequest(input, mk({ extract: async () => { throw new Error('Gemini returned invalid JSON'); } }));
  assert.equal(r.rule.status, 'Needs manual review');
  assert.equal(r.needsHuman, true);
  assert.equal(r.tab, 'Leave');
});

test('Sheets failure keeps the request; retry saves once; second retry is refused (no duplicate)', async () => {
  let n = 0;
  const d = mk({ save: async (tab, row) => (++n === 1 ? { ok: false, error: 'down', maybeDuplicate: false } : { ok: true, tab, row: 5, error: null, maybeDuplicate: false }) });
  const r = await processRequest(input, d);
  assert.equal(r.save.ok, false);
  assert.equal(r.description, input.description);
  await retrySave(r, d);
  assert.equal(r.save.ok, true);
  assert.equal(r.save.row, 5);
  await assert.rejects(() => retrySave(r, d), /Already saved/);
  assert.equal(n, 2);
});

test('retrySave rejects unclassified requests', async () => {
  const rec = { id: 'REQ-123', save: { ok: false }, tab: null, row: null };
  await assert.rejects(() => retrySave(rec), /Cannot save an unclassified or invalid request/);
});

test('validation: empty name, bad email, empty description', async () => {
  for (const bad of [{ ...input, name: ' ' }, { ...input, email: 'nope' }, { ...input, description: '' }]) {
    await assert.rejects(() => processRequest(bad, mk()), /Validation failed/);
  }
});

test('invalid classification JSON is rejected', () => {
  assert.throws(() => validateClassification({ type: 'MAYBE', is_unclear: false, has_multiple_categories: false }));
  assert.throws(() => validateClassification({ type: 'LEAVE' }));
});

test('formula-looking text is neutralised in sheet rows', () => {
  const row = buildRow({
    timestamp: 't',
    employee: '=HYPERLINK("x")',
    email: 'e',
    description: 'd',
    category: 'OTHER',
    extracted: {},
    classification: { classification_reason: 'r' },
    rule: { status: 'Check by hand', rule: 'r' },
  });
  assert.equal(row[1], `'=HYPERLINK("x")`);
});

// Google Sheets specific tests:
test('saveToSheets validates tab and row length for all 4 categories', async () => {
  const fakeFetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, tab: b.tab, row: 12 }),
    };
  };

  for (const tab of ['Leave', 'Expense', 'IT Support', 'Other']) {
    const validRow = new Array(EXPECTED_COLUMNS[tab]).fill('val');
    const res = await saveToSheets(tab, validRow, { url: 'https://example.com/exec', fetchImpl: fakeFetch });
    assert.equal(res.ok, true);
    assert.equal(res.tab, tab);
    assert.equal(res.row, 12);
  }

  // Invalid tab
  const badTab = await saveToSheets('InvalidTab', ['a'], { url: 'https://example.com/exec', fetchImpl: fakeFetch });
  assert.equal(badTab.ok, false);
  assert.match(badTab.error, /Invalid tab/);

  // Invalid row length
  const badLength = await saveToSheets('Leave', ['only', 'two'], { url: 'https://example.com/exec', fetchImpl: fakeFetch });
  assert.equal(badLength.ok, false);
  assert.match(badLength.error, /Invalid row length/);
});

test('saveToSheets supports object-based row format', async () => {
  const fakeFetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, tab: b.tab, row: 4 }),
    };
  };

  const objRow = {
    timestamp: '2026-11-06T10:00:00Z',
    employee: 'Test Person',
    email: 'test@example.com',
    description: 'Leave request',
    startDate: '2026-11-10',
    endDate: '2026-11-12',
    leaveType: 'Casual',
    reason: 'Family',
    workingDays: 3,
    status: 'Auto-approved',
    ruleApplied: 'Leave <= 3 days',
  };

  const res = await saveToSheets('Leave', objRow, { url: 'https://example.com/exec', fetchImpl: fakeFetch });
  assert.equal(res.ok, true);
  assert.equal(res.tab, 'Leave');
  assert.equal(res.row, 4);
});

test('saveToSheets rejects response without valid row confirmation', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, tab: 'Leave' }), // missing row number
  });

  const validRow = new Array(11).fill('x');
  const res = await saveToSheets('Leave', validRow, { url: 'https://example.com/exec', fetchImpl: fakeFetch });
  assert.equal(res.ok, false);
  assert.match(res.error, /valid saved row number/);
});

test('runSheetsDiagnostic succeeds when endpoint confirms write', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, tab: 'Leave', row: 15 }),
  });

  const diag = await runSheetsDiagnostic({ url: 'https://example.com/exec', fetchImpl: fakeFetch });
  assert.equal(diag.ok, true);
  assert.equal(diag.tab, 'Leave');
  assert.equal(diag.row, 15);
  assert.match(diag.message, /confirmed write to tab "Leave" at row 15/);
});

test('runSheetsDiagnostic returns failure when endpoint fails', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: false, error: 'Database locked' }),
  });

  const diag = await runSheetsDiagnostic({ url: 'https://example.com/exec', fetchImpl: fakeFetch });
  assert.equal(diag.ok, false);
  assert.match(diag.error, /Database locked/);
});

// EMAIL ACTION TESTS
test('buildEmail generates correct recipient, subject, and body for Expense example', () => {
  const rec = {
    employee: 'Priya',
    email: 'priya@example.com',
    description: 'Taxi from airport to client office ₹5,000',
    category: 'EXPENSE',
    extracted: {
      amount: 5000,
      category: 'Taxi',
      expense_date: '2026-11-08',
      receipt_available: true,
      business_purpose: 'Client meeting',
    },
    rule: {
      status: 'Needs finance approval',
      rule: 'Expense: amount > INR 2,000 with receipt -> finance approval',
    },
  };

  const email = buildEmail(rec);
  assert.equal(email.to, 'aswini.27196@gmail.com');
  assert.equal(email.team, 'Finance');
  assert.equal(email.subject, '[Expense] Finance review – Taxi ₹5,000 – Priya');
  assert.equal(email.nextStep, 'Waiting for finance review');

  // Verify body contains each required section
  assert.match(email.body, /^Request: Taxi from airport to client office ₹5,000/m);
  assert.match(email.body, /^From: Priya \(priya@example\.com\)/m);
  assert.match(email.body, /^Facts read by AI:\namount: 5000\ncategory: Taxi\nexpense_date: 2026-11-08\nreceipt_available: true\nbusiness_purpose: Client meeting/m);
  assert.match(email.body, /^Status: Needs finance approval/m);
  assert.match(email.body, /^Rule applied: Expense: amount > INR 2,000 with receipt -> finance approval/m);
  assert.match(email.body, /^Next step: Waiting for finance review/m);
});

test('buildEmail formats all four paths correctly', () => {
  // 1. Leave
  const leaveRec = {
    employee: 'Asha Rao',
    email: 'asha@example.com',
    description: 'Casual leave for 3 days',
    category: 'LEAVE',
    extracted: { start_date: '2026-11-09', end_date: '2026-11-11', leave_type: 'Casual Leave', reason: 'Family' },
    rule: { status: 'Auto-approved', rule: 'Leave: 3 working day(s) <= 3 -> auto-approve', workingDays: 3 },
  };
  const leaveEmail = buildEmail(leaveRec);
  assert.equal(leaveEmail.to, EMAIL_TO);
  assert.equal(leaveEmail.team, 'HR');
  assert.equal(leaveEmail.subject, '[Leave] HR auto-approved – Casual Leave 3 days – Asha Rao');
  assert.equal(leaveEmail.nextStep, 'No action needed, approved automatically');

  // 2. IT Support (Urgent)
  const itRec = {
    employee: 'Rahul',
    email: 'rahul@example.com',
    description: 'Laptop screen is completely black and cannot work',
    category: 'IT_SUPPORT',
    extracted: { issue_category: 'Hardware', severity: 'Critical', device_or_system: 'Laptop', work_impact: 'Cannot work', issue_description: 'screen broken', blocked_from_work: true },
    rule: { status: 'Urgent', rule: 'IT: blocked from work -> Urgent' },
  };
  const itEmail = buildEmail(itRec);
  assert.equal(itEmail.to, EMAIL_TO);
  assert.equal(itEmail.team, 'IT');
  assert.equal(itEmail.subject, '[IT Support] IT urgent – Laptop: screen broken – Rahul');
  assert.equal(itEmail.nextStep, 'IT to respond urgently, employee cannot work');

  // 3. Other
  const otherRec = {
    employee: 'Sarah',
    email: 'sarah@example.com',
    description: 'Ergonomic chair request for lumbar support',
    category: 'OTHER',
    extracted: {},
    classification: { classification_reason: 'Ergonomic chair evaluation' },
    rule: { status: 'Check by hand', rule: 'Other: all OTHER requests are checked by hand' },
  };
  const otherEmail = buildEmail(otherRec);
  assert.equal(otherEmail.to, EMAIL_TO);
  assert.equal(otherEmail.team, 'Admin');
  assert.equal(otherEmail.subject, '[Other] Admin review – Ergonomic chair evaluation – Sarah');
  assert.equal(otherEmail.nextStep, 'A person will check this request');
});

test('NEXT_STEPS has expected action text for all standard statuses', () => {
  assert.equal(NEXT_STEPS['Auto-approved'], 'No action needed, approved automatically');
  assert.equal(NEXT_STEPS['Needs manager approval'], 'Waiting for manager approval');
  assert.equal(NEXT_STEPS['Needs finance approval'], 'Waiting for finance review');
  assert.equal(NEXT_STEPS['Finance review'], 'Waiting for finance review');
  assert.equal(NEXT_STEPS['Needs manual verification'], 'Waiting for the employee to send the receipt or amount');
  assert.equal(NEXT_STEPS['needs receipt/amount'], 'Waiting for the employee to send the receipt or amount');
  assert.equal(NEXT_STEPS['Urgent'], 'IT to respond urgently, employee cannot work');
  assert.equal(NEXT_STEPS['Normal'], 'IT to respond in the normal queue');
  assert.equal(NEXT_STEPS['Check by hand'], 'A person will check this request');
  assert.equal(NEXT_STEPS['Needs manual review'], 'A person will check this request');
  assert.equal(NEXT_STEPS['CLASSIFICATION_FAILED'], 'A person will check this request');
});

test('saveToSheets transmits email object in POST payload and captures emailSent response', async () => {
  let capturedPayload;
  const fakeFetch = async (url, opts) => {
    capturedPayload = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, tab: capturedPayload.tab, row: 8, emailSent: true }),
    };
  };

  const emailObj = {
    to: 'aswini.27196@gmail.com',
    subject: '[Expense] Finance review – Taxi ₹5,000 – Priya',
    body: 'Request: Taxi\nFrom: Priya',
  };

  const validRow = new Array(EXPECTED_COLUMNS['Expense']).fill('x');
  const res = await saveToSheets('Expense', validRow, { email: emailObj, url: 'https://example.com/exec', fetchImpl: fakeFetch });

  assert.equal(res.ok, true);
  assert.equal(res.row, 8);
  assert.equal(res.emailSent, true);
  assert.deepEqual(capturedPayload.email, emailObj);
});

test('saveToSheets still succeeds if emailSent is false or omitted by Apps Script', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, tab: 'Leave', row: 9, emailSent: false }),
  });

  const validRow = new Array(EXPECTED_COLUMNS['Leave']).fill('x');
  const res = await saveToSheets('Leave', validRow, { email: { to: 'test@example.com' }, url: 'https://example.com/exec', fetchImpl: fakeFetch });

  assert.equal(res.ok, true);
  assert.equal(res.row, 9);
  assert.equal(res.emailSent, false);
});

test('processRequest creates email object and records emailSent in save result', async () => {
  let passedOpts;
  const d = mk({
    save: async (tab, row, opts) => {
      passedOpts = opts;
      return { ok: true, tab, row: 10, emailSent: true };
    },
  });

  const r = await processRequest(input, d);
  assert.equal(r.category, 'LEAVE');
  assert.ok(r.email);
  assert.equal(r.email.to, 'aswini.27196@gmail.com');
  assert.equal(r.email.team, 'HR');
  assert.ok(passedOpts?.email);
  assert.equal(passedOpts.email.to, 'aswini.27196@gmail.com');
  assert.equal(r.save.emailSent, true);
});

