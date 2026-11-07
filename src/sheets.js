import 'dotenv/config';

// GOOGLE SHEETS MODULE - talks to the existing Apps Script Web App ({tab, row} -> {ok:true}).
export const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzX5LUmDLCfqj7JaQ_17ZBIu4j3EUjacccNNrzwRnFuZVfhn5WFmaLP548rbpXxO7JE/exec';
export const TAB_FOR = { LEAVE: 'Leave', EXPENSE: 'Expense', IT_SUPPORT: 'IT Support', OTHER: 'Other' };
export const VALID_TABS = ['Leave', 'Expense', 'IT Support', 'Other'];
export const EXPECTED_COLUMNS = {
  'Leave': 11,
  'Expense': 11,
  'IT Support': 11,
  'Other': 7,
};

// Stop text like "=HYPERLINK(...)" from being run as a spreadsheet formula.
const safe = (v) => (v == null ? '' : typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');

export function objectToRow(tab, obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object') return null;
  const head = [obj.timestamp || '', obj.employee || obj.name || obj.employeeName || '', obj.email || '', obj.description || obj.request || ''];
  const tail = [obj.status || '', obj.rule || obj.ruleApplied || ''];
  let body = [];
  if (tab === 'Leave') {
    body = [obj.start_date || obj.startDate || '', obj.end_date || obj.endDate || '', obj.leave_type || obj.leaveType || '', obj.reason || '', obj.workingDays ?? ''];
  } else if (tab === 'Expense') {
    body = [obj.amount ?? '', obj.category || '', obj.expense_date || obj.expenseDate || '', yn(obj.receipt_available ?? obj.receiptAvailable), obj.business_purpose || obj.businessPurpose || ''];
  } else if (tab === 'IT Support') {
    body = [obj.issue_category || obj.issueCategory || '', obj.severity || '', obj.device_or_system || obj.deviceOrSystem || '', obj.work_impact || obj.workImpact || '', obj.issue_description || obj.issueDescription || ''];
  } else {
    body = [obj.classification_reason || obj.classificationReason || obj.reason || ''];
  }
  return [...head, ...body, ...tail].map(safe);
}

export function buildRow(r) {
  if (!r || !r.category || !TAB_FOR[r.category]) {
    throw new Error(`Cannot build sheet row: invalid or unclassified category (${r?.category})`);
  }
  const f = r.extracted || {}, head = [r.timestamp, r.employee, r.email, r.description];
  const tail = [r.rule?.status || '', r.rule?.rule || ''];
  let body;
  if (r.category === 'LEAVE') body = [f.start_date, f.end_date, f.leave_type, f.reason, r.rule?.workingDays];
  else if (r.category === 'EXPENSE') body = [f.amount, f.category, f.expense_date, yn(f.receipt_available), f.business_purpose];
  else if (r.category === 'IT_SUPPORT') body = [f.issue_category, f.severity, f.device_or_system, f.work_impact, f.issue_description];
  else body = [r.classification?.classification_reason || ''];
  return [...head, ...body, ...tail].map(safe);
}

export async function saveToSheets(tab, rowInput, { url = process.env.APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL, fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, error: 'APPS_SCRIPT_URL is not configured', maybeDuplicate: false };

  // Validate tab
  if (!tab || !VALID_TABS.includes(tab)) {
    return { ok: false, error: `Invalid tab: "${tab}". Must be one of: ${VALID_TABS.join(', ')}`, maybeDuplicate: false };
  }

  // Support array row or convert object row
  let row = rowInput;
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    row = objectToRow(tab, row);
  }

  if (!Array.isArray(row) || row.length === 0) {
    return { ok: false, error: 'Invalid row format: row must be a non-empty array', maybeDuplicate: false };
  }

  const expectedCount = EXPECTED_COLUMNS[tab];
  if (expectedCount && row.length !== expectedCount) {
    return {
      ok: false,
      error: `Invalid row length for tab "${tab}": expected ${expectedCount} columns, got ${row.length}`,
      maybeDuplicate: false,
    };
  }

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ tab, row }),
    });
  } catch (e) {
    // The request may or may not have reached Google, so a retry could duplicate the row.
    return { ok: false, error: `Could not reach Apps Script: ${e.message}`, maybeDuplicate: true };
  }

  if (!res.ok) {
    return { ok: false, error: `Apps Script HTTP error: ${res.status} ${res.statusText}`, maybeDuplicate: false };
  }

  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    return {
      ok: false,
      error: `Apps Script did not return JSON (HTTP ${res.status}). Check deployment is set to "Anyone" access.`,
      maybeDuplicate: false,
    };
  }

  if (!data || data.ok !== true) {
    return {
      ok: false,
      error: data?.error ? `Apps Script rejected save: ${data.error}` : 'Apps Script did not confirm the save (ok !== true)',
      maybeDuplicate: false,
    };
  }

  if (data.tab && data.tab !== tab) {
    return {
      ok: false,
      error: `Apps Script reported save to unexpected tab "${data.tab}" (expected "${tab}")`,
      maybeDuplicate: false,
    };
  }

  if (typeof data.row !== 'number' || data.row < 1) {
    return {
      ok: false,
      error: `Apps Script did not return a valid saved row number (got: ${JSON.stringify(data.row)})`,
      maybeDuplicate: false,
    };
  }

  return {
    ok: true,
    tab: data.tab || tab,
    row: data.row,
    error: null,
    maybeDuplicate: false,
  };
}

export async function runSheetsDiagnostic({ url = process.env.APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL, fetchImpl = fetch } = {}) {
  const timestamp = new Date().toISOString();
  const testRow = [
    timestamp,
    'Diagnostic Test Runner',
    'diagnostic@example.com',
    'Independent Google Sheets connection diagnostic check',
    '2026-11-10',
    '2026-11-12',
    'Diagnostic',
    'Verifying Apps Script destination and row append',
    3,
    'Auto-approved',
    'Leave: diagnostic check',
  ];

  const result = await saveToSheets('Leave', testRow, { url, fetchImpl });
  if (!result.ok) {
    return {
      ok: false,
      tab: 'Leave',
      row: null,
      error: result.error,
      message: `Diagnostic test failed: ${result.error}`,
      endpoint: url,
      testedAt: timestamp,
    };
  }

  return {
    ok: true,
    tab: result.tab,
    row: result.row,
    message: `Diagnostic test succeeded: confirmed write to tab "${result.tab}" at row ${result.row}`,
    endpoint: url,
    testedAt: timestamp,
  };
}

// Read the public holidays from the "Holidays" tab (Apps Script doGet?action=holidays).
// Returns ['YYYY-MM-DD', ...]. Code uses them to count working days; Gemini never sees them.
export async function fetchHolidays({ url = process.env.APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL, fetchImpl = fetch } = {}) {
  if (!url) throw new Error('APPS_SCRIPT_URL is not configured');
  const res = await fetchImpl(url + (url.includes('?') ? '&' : '?') + 'action=holidays', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Holidays lookup returned HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.ok !== true || !Array.isArray(data.holidays)) throw new Error('Holidays lookup returned an unexpected response');
  return data.holidays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
}
