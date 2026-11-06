# Office Request Desk: complete project in one file
**Instructions for the AI coding assistant:** Recreate this project exactly. Each section below is a file: the heading is the file path and the code block is the full file content. Create the folders `src`, `public`, `tests`, `scripts` and `data` (leave `data` empty). Do not change the code. After creating the files, run `npm install`, then `npm test` (expect 29 passing tests). Do not invent a Gemini key: the user will copy `.env.example` to `.env` and add their own `GEMINI_API_KEY`. Do not replace the Apps Script URL.
File list: `package.json`, `.env.example`, `.gitignore`, `server.js`, `src/rules.js`, `src/validate.js`, `src/gemini.js`, `src/sheets.js`, `src/store.js`, `src/workflow.js`, `public/index.html`, `tests/rules.test.js`, `tests/workflow.test.js`, `scripts/run-scenarios.js`, `README.md`

---

## FILE: `package.json`

````json
{
  "name": "office-request-desk",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test",
    "scenarios": "node scripts/run-scenarios.js"
  },
  "dependencies": { "dotenv": "^16.4.5", "express": "^4.19.2" }
}
````

---

## FILE: `.env.example`

````
# Copy this file to ".env" and fill in GEMINI_API_KEY. Never commit ".env".
GEMINI_API_KEY=paste-your-key-here
GEMINI_MODEL=gemini-2.5-flash
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbzX5LUmDLCfqj7JaQ_17ZBIu4j3EUjacccNNrzwRnFuZVfhn5WFmaLP548rbpXxO7JE/exec
PORT=3000
````

---

## FILE: `.gitignore`

````
.env
node_modules
data/requests.json
````

---

## FILE: `server.js`

````javascript
import 'dotenv/config';
import express from 'express';
import { processRequest, retrySave } from './src/workflow.js';
import { validateInput } from './src/validate.js';
import * as store from './src/store.js';

const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(express.static(new URL('./public', import.meta.url).pathname));

const inflight = new Set();
const ndjson = (res) => { res.setHeader('Content-Type', 'application/x-ndjson'); res.flushHeaders(); return (o) => res.write(JSON.stringify(o) + '\n'); };
const publicRec = ({ row, ...r }) => r;

app.get('/api/health', (_q, res) => res.json({ ok: true, geminiConfigured: !!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('paste-'), sheetsConfigured: !!process.env.APPS_SCRIPT_URL }));
app.get('/api/stats', (_q, res) => res.json(store.stats()));
app.get('/api/requests', (_q, res) => res.json(store.list().map(publicRec)));

app.post('/api/requests', async (req, res) => {
  const v = validateInput(req.body);
  if (!v.ok) return res.status(400).json({ error: 'Validation failed', fields: v.errors });
  const send = ndjson(res);
  try {
    const rec = await processRequest(req.body, undefined, (e) => send({ type: 'stage', ...e }));
    store.put(rec);
    send({ type: 'result', record: publicRec(rec) });
  } catch (e) { send({ type: 'fatal', error: e.message }); }
  res.end();
});

app.post('/api/requests/:id/retry', async (req, res) => {
  const rec = store.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Unknown request id' });
  if (rec.save.ok) return res.status(409).json({ error: 'Already saved; retry refused to avoid a duplicate row' });
  if (inflight.has(rec.id)) return res.status(409).json({ error: 'A save for this request is already running' });
  inflight.add(rec.id);
  try { await retrySave(rec); store.put(rec); res.json(publicRec(rec)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  finally { inflight.delete(rec.id); }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Office Request Desk running on http://localhost:${port}`));
````

---

## FILE: `src/rules.js`

````javascript
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
};
// Statuses where a person must still act.
const HUMAN = new Set([STATUS.MANAGER, STATUS.FINANCE, STATUS.REVIEW, STATUS.VERIFY, STATUS.ESCALATED, STATUS.HAND]);
export const needsHuman = (status) => HUMAN.has(status);

export function parseISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

export function countWorkingDays(start, end) {
  let n = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++; // skip Sunday(0) and Saturday(6)
  }
  return n;
}

export function evaluateLeave(f) {
  const s = parseISODate(f.start_date), e = parseISODate(f.end_date);
  if (!s || !e) return { status: STATUS.REVIEW, rule: 'Leave: start or end date missing/invalid', workingDays: null };
  if (e < s) return { status: STATUS.REVIEW, rule: 'Leave: end date is before start date', workingDays: null };
  const wd = countWorkingDays(s, e);
  if (wd <= 3) return { status: STATUS.AUTO, rule: `Leave: ${wd} working day(s) <= 3 -> auto-approve`, workingDays: wd };
  return { status: STATUS.MANAGER, rule: `Leave: ${wd} working days > 3 -> manager approval`, workingDays: wd };
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
  // "Essential" = a description of the problem and a severity. Severity is never guessed.
  if (!f.issue_description || !f.severity)
    return { status: STATUS.REVIEW, rule: 'IT: essential info missing (description or severity)' };
  if (f.severity === 'High') return { status: STATUS.ESCALATED, rule: 'IT: severity High -> escalate' };
  if (f.work_impact === 'Cannot work') return { status: STATUS.ESCALATED, rule: 'IT: employee cannot continue working -> escalate' };
  return { status: STATUS.STANDARD, rule: 'IT: no escalation trigger -> standard ticket' };
}

export function evaluate(type, fields) {
  switch (type) {
    case 'LEAVE': return evaluateLeave(fields);
    case 'EXPENSE': return evaluateExpense(fields);
    case 'IT_SUPPORT': return evaluateIT(fields);
    default: return { status: STATUS.HAND, rule: 'Other: all OTHER requests are checked by hand' };
  }
}
````

---

## FILE: `src/validate.js`

````javascript
export function validateInput(input = {}) {
  const name = String(input.name ?? '').trim();
  const email = String(input.email ?? '').trim();
  const description = String(input.description ?? '').trim();
  const errors = {};
  if (name.length < 2) errors.name = 'Enter the employee name (at least 2 characters).';
  if (name.length > 100) errors.name = 'Name is too long (max 100).';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address.';
  if (description.length < 5) errors.description = 'Describe the request (at least 5 characters).';
  if (description.length > 2000) errors.description = 'Request is too long (max 2000 characters).';
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, clean: { name, email, description } };
}
````

---

## FILE: `src/gemini.js`

````javascript
// AI MODULE - Gemini classifies and extracts. It never decides approval status.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TYPES = ['LEAVE', 'EXPENSE', 'IT_SUPPORT', 'OTHER'];

export async function callGemini(prompt, { fetchImpl = fetch } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('paste-')) throw new Error('GEMINI_API_KEY is not configured on the server');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(`${BASE}/${model}:generateContent`, {
        method: 'POST', body, signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      });
      if (!res.ok) throw new Error(`Gemini API returned HTTP ${res.status}`);
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new Error('Gemini returned an empty response');
      try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
      catch { throw new Error('Gemini returned invalid JSON'); }
    } catch (e) { last = e; }
  }
  throw last;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v.replace(/[₹,\s]|INR|Rs\.?/gi, ''));
  return Number.isFinite(n) ? n : null;
};
const pick = (v, list) => list.find((x) => typeof v === 'string' && x.toLowerCase() === v.trim().toLowerCase()) ?? null;

export function validateClassification(r) {
  if (!r || typeof r !== 'object') throw new Error('Classification is not a JSON object');
  const type = pick(r.type, TYPES);
  if (!type) throw new Error(`Classification type invalid: ${JSON.stringify(r.type)}`);
  if (typeof r.is_unclear !== 'boolean' || typeof r.has_multiple_categories !== 'boolean')
    throw new Error('Classification flags must be booleans');
  return { type, classification_reason: str(r.classification_reason) ?? 'No reason given', is_unclear: r.is_unclear, has_multiple_categories: r.has_multiple_categories };
}

export function normalizeExtraction(type, r) {
  if (!r || typeof r !== 'object') throw new Error('Extraction is not a JSON object');
  if (type === 'LEAVE') return { start_date: str(r.start_date), end_date: str(r.end_date), leave_type: str(r.leave_type), reason: str(r.reason) };
  if (type === 'EXPENSE') return { amount: num(r.amount), category: str(r.category), expense_date: str(r.expense_date), receipt_available: bool(r.receipt_available), business_purpose: str(r.business_purpose) };
  if (type === 'IT_SUPPORT') return {
    issue_category: str(r.issue_category), severity: pick(r.severity, ['Low', 'Medium', 'High']),
    device_or_system: str(r.device_or_system), work_impact: pick(r.work_impact, ['Cannot work', 'Partially blocked', 'No impact']),
    issue_description: str(r.issue_description),
  };
  return {};
}

const COMMON = (today, text) => `Today's date is ${today}. If a year is not stated in the request, assume the year of today's date.
Return ONLY a JSON object, no prose. Never invent facts: use null for anything not stated or clearly implied.
You do NOT decide approval or status.
Employee request:
"""${text}"""`;

export async function classify(text, today, call = callGemini) {
  const raw = await call(`You classify office requests into exactly one of: LEAVE, EXPENSE, IT_SUPPORT, OTHER.
- LEAVE: time off. EXPENSE: reimbursement of money spent. IT_SUPPORT: broken or malfunctioning device/software/access.
- OTHER: anything else. If the request is unclear, use OTHER and set is_unclear true.
- If it mixes unrelated categories (e.g. leave AND an expense), use OTHER and set has_multiple_categories true.
Return JSON: {"type":"LEAVE|EXPENSE|IT_SUPPORT|OTHER","classification_reason":"short reason","is_unclear":false,"has_multiple_categories":false}
${COMMON(today, text)}`);
  return validateClassification(raw);
}

const SCHEMAS = {
  LEAVE: `{"start_date":"YYYY-MM-DD or null","end_date":"YYYY-MM-DD or null (same as start for a single day)","leave_type":"e.g. Casual Leave, Sick Leave, Annual Leave, only if stated, else null","reason":"short reason or null"}`,
  EXPENSE: `{"amount":number in INR or null,"category":"e.g. Stationery, Travel, Meals or null","expense_date":"YYYY-MM-DD or null","receipt_available":true only if the employee says they have a receipt/bill, false only if they say they do not, otherwise null,"business_purpose":"short text or null"}`,
  IT_SUPPORT: `{"issue_category":"Hardware|Software|Network|Access|Other or null","severity":"Low|Medium|High, only if stated or clearly implied by the description, else null","device_or_system":"e.g. Laptop or null","work_impact":"Cannot work|Partially blocked|No impact, only if the request shows it, else null","issue_description":"short text or null"}`,
};

export async function extract(type, text, today, call = callGemini) {
  if (type === 'OTHER') return {};
  const raw = await call(`Extract fields for a ${type} request. Return JSON in exactly this shape:\n${SCHEMAS[type]}\n${COMMON(today, text)}`);
  return normalizeExtraction(type, raw);
}
````

---

## FILE: `src/sheets.js`

````javascript
// GOOGLE SHEETS MODULE - talks to the existing Apps Script Web App ({tab, row} -> {ok:true}).
export const TAB_FOR = { LEAVE: 'Leave', EXPENSE: 'Expense', IT_SUPPORT: 'IT Support', OTHER: 'Other' };
// Stop text like "=HYPERLINK(...)" from being run as a spreadsheet formula.
const safe = (v) => (v == null ? '' : typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');

export function buildRow(r) {
  const f = r.extracted, head = [r.timestamp, r.employee, r.email, r.description];
  const tail = [r.rule.status, r.rule.rule];
  let body;
  if (r.category === 'LEAVE') body = [f.start_date, f.end_date, f.leave_type, f.reason, r.rule.workingDays];
  else if (r.category === 'EXPENSE') body = [f.amount, f.category, f.expense_date, yn(f.receipt_available), f.business_purpose];
  else if (r.category === 'IT_SUPPORT') body = [f.issue_category, f.severity, f.device_or_system, f.work_impact, f.issue_description];
  else body = [r.classification.classification_reason];
  return [...head, ...body, ...tail].map(safe);
}

export async function saveToSheets(tab, row, { url = process.env.APPS_SCRIPT_URL, fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, error: 'APPS_SCRIPT_URL is not configured', maybeDuplicate: false };
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ tab, row }),
    });
  } catch (e) {
    // The request may or may not have reached Google, so a retry could duplicate the row.
    return { ok: false, error: `Could not reach Apps Script: ${e.message}`, maybeDuplicate: true };
  }
  let data;
  try { data = JSON.parse(await res.text()); }
  catch { return { ok: false, error: `Apps Script did not return JSON (HTTP ${res.status}). Check the deployment is set to "Anyone" access.`, maybeDuplicate: false }; }
  if (data && data.ok === true) return { ok: true, error: null, maybeDuplicate: false };
  return { ok: false, error: `Apps Script did not confirm the save${data?.error ? `: ${data.error}` : ''}`, maybeDuplicate: false };
}
````

---

## FILE: `src/store.js`

````javascript
// Simple request log (memory + data/requests.json). This is the ONLY source for dashboard counts.
import fs from 'node:fs';
const FILE = new URL('../data/requests.json', import.meta.url);
const map = new Map();
try { for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) map.set(r.id, r); } catch { /* first run */ }
const persist = () => { try { fs.writeFileSync(FILE, JSON.stringify([...map.values()], null, 1)); } catch { /* read-only disk */ } };
export const put = (r) => { map.set(r.id, r); persist(); return r; };
export const get = (id) => map.get(id);
export const list = () => [...map.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
export function stats() {
  const all = list(), by = (c) => all.filter((r) => r.category === c).length;
  return { total: all.length, leave: by('LEAVE'), expense: by('EXPENSE'), it: by('IT_SUPPORT'), other: by('OTHER'),
    humanReview: all.filter((r) => r.needsHuman).length, saveFailed: all.filter((r) => !r.save.ok).length };
}
````

---

## FILE: `src/workflow.js`

````javascript
// WORKFLOW CONTROLLER - runs the fixed pipeline. Not a chatbot.
import { classify, extract } from './gemini.js';
import { evaluate, needsHuman } from './rules.js';
import { buildRow, saveToSheets, TAB_FOR } from './sheets.js';
import { validateInput } from './validate.js';

export const defaultDeps = () => ({ classify, extract, save: saveToSheets, now: () => new Date() });
const ist = (d) => d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' });
const KEYS = {
  LEAVE: ['start_date', 'end_date', 'leave_type', 'reason'],
  EXPENSE: ['amount', 'category', 'expense_date', 'receipt_available', 'business_purpose'],
  IT_SUPPORT: ['issue_category', 'severity', 'device_or_system', 'work_impact', 'issue_description'],
};
const emptyFields = (t) => Object.fromEntries((KEYS[t] ?? []).map((k) => [k, null]));

export async function processRequest(input, deps = defaultDeps(), emit = () => {}) {
  const v = validateInput(input);
  if (!v.ok) { const e = new Error('Validation failed'); e.fields = v.errors; throw e; }
  const { name, email, description } = v.clean;
  const now = deps.now(), today = ist(now).slice(0, 10);
  const rec = {
    id: 'REQ-' + now.getTime().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
    timestamp: ist(now), employee: name, email, description, aiNotes: [],
  };
  emit({ stage: 'receive', actor: 'Code', state: 'done', detail: 'Form data validated' });

  // 1) AI classifies. If it fails we do NOT guess: the request goes to a human.
  emit({ stage: 'classify', actor: 'AI', state: 'running' });
  try {
    rec.classification = await deps.classify(description, today);
    emit({ stage: 'classify', actor: 'AI', state: 'done', detail: `${rec.classification.type}: ${rec.classification.classification_reason}` });
  } catch (e) {
    rec.classification = { type: 'OTHER', classification_reason: `AI classification failed (${e.message}); needs a human`, is_unclear: true, has_multiple_categories: false };
    rec.aiNotes.push(`Classification failed: ${e.message}`);
    emit({ stage: 'classify', actor: 'AI', state: 'error', detail: `${e.message} - routing to human review` });
  }
  // CODE enforces the ambiguity rule, even if Gemini said otherwise.
  const c = rec.classification;
  rec.category = c.is_unclear || c.has_multiple_categories ? 'OTHER' : c.type;

  // 2) AI extracts fields (OTHER needs no extra call; the classification reason is reused).
  rec.extracted = {};
  if (rec.category === 'OTHER') {
    emit({ stage: 'extract', actor: 'AI', state: 'done', detail: 'Not needed for OTHER (classification reason is saved)' });
  } else {
    emit({ stage: 'extract', actor: 'AI', state: 'running' });
    try {
      rec.extracted = await deps.extract(rec.category, description, today);
      emit({ stage: 'extract', actor: 'AI', state: 'done', detail: Object.entries(rec.extracted).map(([k, x]) => `${k}=${x ?? 'null'}`).join(', ') });
    } catch (e) {
      rec.aiNotes.push(`Extraction failed: ${e.message}`);
      rec.extracted = emptyFields(rec.category); // all null -> rules send it to a human
      emit({ stage: 'extract', actor: 'AI', state: 'error', detail: `${e.message} - fields left empty` });
    }
  }
  rec.missing = Object.entries(rec.extracted).filter(([, x]) => x === null).map(([k]) => k);

  // 3) CODE decides the status.
  rec.rule = evaluate(rec.category, rec.extracted);
  rec.needsHuman = needsHuman(rec.rule.status);
  emit({ stage: 'rules', actor: 'Code', state: 'done', detail: `${rec.rule.status} (${rec.rule.rule})` });

  // 4) CODE saves to the right tab.
  rec.tab = TAB_FOR[rec.category];
  rec.row = buildRow(rec);
  rec.save = { ok: false, error: null, maybeDuplicate: false, attempts: 0 };
  await saveStep(rec, deps, emit);
  return rec;
}

async function saveStep(rec, deps, emit) {
  emit({ stage: 'save', actor: 'Code', state: 'running' });
  rec.save.attempts++;
  const r = await deps.save(rec.tab, rec.row);
  rec.save = { ...rec.save, ok: r.ok, error: r.error, maybeDuplicate: r.maybeDuplicate };
  emit({ stage: 'save', actor: 'Code', state: r.ok ? 'done' : 'error', detail: r.ok ? `Saved to "${rec.tab}" tab (Apps Script confirmed ok:true)` : r.error });
}

// Retry only if the save was never confirmed. The same row (same timestamp) is re-sent.
export async function retrySave(rec, deps = defaultDeps(), emit = () => {}) {
  if (rec.save.ok) { const e = new Error('Already saved; retry refused to avoid a duplicate row'); e.status = 409; throw e; }
  await saveStep(rec, deps, emit);
  return rec;
}
````

---

## FILE: `public/index.html`

````html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Office Request Desk</title>
<style>
:root{--bg:#f6f7f4;--card:#fff;--ink:#1c2420;--mute:#5d6a63;--line:#dfe4de;--pri:#0f5c4d;--ai:#5b3fb5;--code:#0b6bcb;--hum:#b3541e;--ok:#17803d;--bad:#b42318}
@media(prefers-color-scheme:dark){:root{--bg:#121714;--card:#1a211d;--ink:#e8eee9;--mute:#9aa8a0;--line:#2b352f;--pri:#4fc3a8;--ai:#a58cf0;--code:#6aaef2;--hum:#f0a070;--ok:#5cd68a;--bad:#ff8a7e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{margin:0;font-size:26px;letter-spacing:-.3px}p.sub{margin:2px 0 20px;color:var(--mute)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.stat b{display:block;font-size:22px}.stat span{color:var(--mute);font-size:13px}
.grid{display:grid;grid-template-columns:minmax(0,380px) minmax(0,1fr);gap:16px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px}.panel h2{margin:0 0 12px;font-size:17px}
label{display:block;font-weight:600;margin:10px 0 4px;font-size:14px}input,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit}
input:focus,textarea:focus,button:focus-visible{outline:2px solid var(--pri);outline-offset:1px}textarea{min-height:130px;resize:vertical}
.err{color:var(--bad);font-size:13px;min-height:1em}.row{display:flex;gap:8px;margin-top:14px}
button{font:inherit;font-weight:600;padding:9px 14px;border-radius:6px;border:1px solid var(--pri);background:var(--pri);color:#fff;cursor:pointer}button.sec{background:transparent;color:var(--pri)}button:disabled{opacity:.5;cursor:wait}
@media(prefers-color-scheme:dark){button{color:#0b1410}button.sec{color:var(--pri)}}
ol.stages{list-style:none;margin:0;padding:0}ol.stages li{display:grid;grid-template-columns:22px 1fr auto;gap:8px;padding:8px 0;border-bottom:1px solid var(--line);align-items:start}
.dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);margin-top:4px}.running .dot{border-color:var(--pri);border-top-color:transparent;animation:s 0.8s linear infinite}.done .dot{background:var(--ok);border-color:var(--ok)}.error .dot{background:var(--bad);border-color:var(--bad)}
@keyframes s{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.running .dot{animation:none}}
.detail{display:block;color:var(--mute);font-size:13px;word-break:break-word}.badge{font-size:12px;font-weight:700;padding:1px 8px;border-radius:10px;border:1px solid currentColor}.AI{color:var(--ai)}.Code{color:var(--code)}.Human{color:var(--hum)}
dl{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;margin:12px 0}dt{color:var(--mute)}dd{margin:0;word-break:break-word}.null{color:var(--bad);font-style:italic}
.banner{padding:10px 12px;border-radius:6px;margin-top:10px;border:1px solid}.banner.hum{border-color:var(--hum);color:var(--hum)}.banner.ok{border-color:var(--ok);color:var(--ok)}.banner.bad{border-color:var(--bad);color:var(--bad)}
.status{font-size:18px;font-weight:700}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}.wrap{overflow-x:auto}
details{margin-top:16px}summary{cursor:pointer;font-weight:600}details p{max-width:75ch}
</style></head><body><main>
<h1>Office Request Desk</h1><p class="sub">One place to submit and track office requests.</p>
<div class="cards" id="cards" aria-live="polite"></div>
<div class="grid">
<section class="panel"><h2>New request</h2>
<form id="f" novalidate>
<label for="name">Employee name</label><input id="name" autocomplete="off"><div class="err" id="e-name"></div>
<label for="email">Employee email</label><input id="email" type="email" autocomplete="off"><div class="err" id="e-email"></div>
<label for="description">Request description</label><textarea id="description" maxlength="2000" placeholder="e.g. I need casual leave from 9 November to 11 November for a family function."></textarea><div class="err" id="e-description"></div>
<div class="row"><button id="go" type="submit">Submit request</button><button class="sec" type="button" id="clear">Clear form</button></div>
</form></section>
<section class="panel" id="right"><h2>Workflow</h2><p class="sub" style="margin:0">Submit a request to see each stage run. Stages are tagged by who does the work: <span class="badge AI">AI</span> <span class="badge Code">Code</span> <span class="badge Human">Human</span></p></section>
</div>
<section class="panel" style="margin-top:16px"><h2>Request history <small style="font-weight:400;color:var(--mute)">(requests processed by this server)</small></h2><div class="wrap"><table id="hist"></table></div></section>
<details class="panel"><summary>How this works (for the demo)</summary>
<p><b>Trigger:</b> clicking Submit starts a fixed pipeline; it is not a chat.</p>
<p><b>Gemini (AI)</b> only reads the text: it picks LEAVE / EXPENSE / IT_SUPPORT / OTHER and pulls out fields such as dates and amounts. Missing facts stay null.</p>
<p><b>JavaScript (code)</b> in <code>src/rules.js</code> applies the IF/THEN rules and sets the status. Rules are in code, not in the AI, because an AI can give different answers to the same input and can be talked into approving things; code is repeatable and auditable.</p>
<p><b>Human reviewer</b> is needed for every status except Auto-approved and Standard support ticket: manager/finance approval, manual review/verification, escalations, and anything classified OTHER.</p>
<p><b>Google Sheets:</b> the server POSTs <code>{"tab","row"}</code> to your Apps Script. Success is shown only if the reply contains <code>ok: true</code>.</p></details>
</main>
<script>
const $=id=>document.getElementById(id);
const STAGES=[['receive','Receiving request','Code'],['classify','Classifying request using AI','AI'],['extract','Extracting information','AI'],['rules','Applying business rules','Code'],['save','Saving to Google Sheets','Code']];
const el=(t,a={},...k)=>{const e=document.createElement(t);for(const[x,v]of Object.entries(a))x==='class'?e.className=v:e.setAttribute(x,v);for(const c of k.flat())e.append(c instanceof Node?c:document.createTextNode(c));return e};
const CAT={LEAVE:'Leave',EXPENSE:'Expense',IT_SUPPORT:'IT Support',OTHER:'Other'};

async function loadStats(){try{const s=await (await fetch('/api/stats')).json();
 const items=[['Total requests',s.total],['Leave',s.leave],['Expense',s.expense],['IT Support',s.it],['Other',s.other],['Needs human review',s.humanReview]];
 $('cards').replaceChildren(...items.map(([l,v])=>el('div',{class:'stat'},el('b',{},String(v)),el('span',{},l))));}catch{$('cards').replaceChildren(el('div',{class:'stat'},el('span',{},'Counts unavailable: server not reachable')))}}
async function loadHistory(){try{const r=await (await fetch('/api/requests')).json();const t=$('hist');
 const head=el('tr',{},...['Time','Employee','Category','Status','Saved'].map(h=>el('th',{},h)));
 const rows=r.slice(0,25).map(x=>el('tr',{},el('td',{},x.timestamp),el('td',{},x.employee),el('td',{},CAT[x.category]),el('td',{},x.rule.status),el('td',{},x.save.ok?'Yes':'NO')));
 t.replaceChildren(head,...(rows.length?rows:[el('tr',{},el('td',{colspan:5},'No requests yet.'))]));}catch{}}

function stageList(){const ol=el('ol',{class:'stages'});for(const[k,l,a]of STAGES)ol.append(el('li',{id:'st-'+k},el('span',{class:'dot'}),el('span',{},l,el('span',{class:'detail'})),el('span',{class:'badge '+a},a)));return ol}
function setStage(m){const li=$('st-'+m.stage);if(!li)return;li.className=m.state;li.querySelector('.detail').textContent=m.detail||''}

function showResult(r){
 const right=$('right');const sec=document.querySelector('#right .results');if(sec)sec.remove();
 const dl=el('dl');const add=(k,v)=>{dl.append(el('dt',{},k),el('dd',{},v===null||v===undefined?el('span',{class:'null'},'not provided'):String(v)))};
 add('Request ID',r.id);add('Employee',r.employee);add('Category',CAT[r.category]);add('Classification reason',r.classification.classification_reason);
 for(const[k,v]of Object.entries(r.extracted))add(k.replace(/_/g,' '),v);
 if(r.category==='LEAVE')add('working days',r.rule.workingDays);
 add('Business rule applied',r.rule.rule);
 const box=el('div',{class:'results'},el('div',{class:'status'},r.rule.status),dl);
 if(r.aiNotes.length)box.append(el('div',{class:'banner bad'},'AI problem: '+r.aiNotes.join('; ')+'. Not approved automatically.'));
 if(r.needsHuman)box.append(el('div',{class:'banner hum'},el('span',{class:'badge Human'},'Human'),' Human review required: a person must act on this request before it is final.'));
 if(r.save.ok)box.append(el('div',{class:'banner ok'},`Saved to the "${r.tab}" tab in Google Sheets (confirmed by Apps Script).`));
 else{const b=el('div',{class:'banner bad'},'Not saved to Google Sheets: '+r.save.error+' Your request is kept. ');
  if(r.save.maybeDuplicate)b.append(el('div',{},'The connection failed mid-request, so a row may already exist. Check the sheet before retrying.'));
  const rb=el('button',{type:'button'},'Retry save');rb.onclick=async()=>{rb.disabled=true;const res=await fetch(`/api/requests/${r.id}/retry`,{method:'POST'});const j=await res.json();if(j.id)showResult(j);else{alert(j.error);rb.disabled=false}loadStats();loadHistory()};b.append(el('div',{},rb));box.append(b)}
 right.append(box);
}

$('f').addEventListener('submit',async ev=>{ev.preventDefault();
 for(const k of['name','email','description'])$('e-'+k).textContent='';
 const body={name:$('name').value,email:$('email').value,description:$('description').value};
 $('go').disabled=true;const right=$('right');right.replaceChildren(el('h2',{},'Processing'),stageList());
 try{const res=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(res.status===400){const j=await res.json();for(const[k,v]of Object.entries(j.fields))$('e-'+k).textContent=v;right.replaceChildren(el('h2',{},'Workflow'),el('p',{class:'sub'},'Fix the highlighted fields and submit again.'));return}
  const rd=res.body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
   while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;const m=JSON.parse(line);
    if(m.type==='stage')setStage(m);else if(m.type==='result'){right.querySelector('h2').textContent='Result';showResult(m.record)}else if(m.type==='fatal')right.append(el('div',{class:'banner bad'},'Workflow failed: '+m.error))}}
 }catch(e){right.append(el('div',{class:'banner bad'},'Could not reach the server: '+e.message))}
 finally{$('go').disabled=false;loadStats();loadHistory()}});
$('clear').onclick=()=>{$('f').reset();for(const k of['name','email','description'])$('e-'+k).textContent=''};
loadStats();loadHistory();
</script></body></html>
````

---

## FILE: `tests/rules.test.js`

````javascript
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
const base = { issue_description: 'x', severity: 'Low', work_impact: 'No impact' };
test('IT routine -> standard', () => assert.equal(T(base), S.STANDARD));
test('IT high severity -> escalated', () => assert.equal(T({ ...base, severity: 'High' }), S.ESCALATED));
test('IT cannot work -> escalated', () => assert.equal(T({ ...base, work_impact: 'Cannot work' }), S.ESCALATED));
test('IT severity missing is not assumed Low -> review', () => assert.equal(T({ ...base, severity: null }), S.REVIEW));
test('IT description missing -> review', () => assert.equal(T({ ...base, issue_description: null }), S.REVIEW));

test('OTHER -> Check by hand', () => assert.equal(evaluate('OTHER', {}).status, S.HAND));
````

---

## FILE: `tests/workflow.test.js`

````javascript
// These use STUB Gemini and STUB Sheets. They prove the controller wiring, not the live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { processRequest, retrySave } from '../src/workflow.js';
import { buildRow } from '../src/sheets.js';
import { validateClassification, normalizeExtraction } from '../src/gemini.js';

const input = { name: 'Asha Rao', email: 'asha@example.com', description: 'test request' };
const mk = (over = {}) => {
  const saved = [];
  return { saved, classify: async () => ({ type: 'LEAVE', classification_reason: 'leave', is_unclear: false, has_multiple_categories: false }),
    extract: async () => ({ start_date: '2026-11-09', end_date: '2026-11-11', leave_type: 'Casual Leave', reason: 'Family' }),
    save: async (tab, row) => { saved.push({ tab, row }); return { ok: true, error: null, maybeDuplicate: false }; },
    now: () => new Date('2026-11-05T09:00:00Z'), ...over };
};

test('leave happy path: code decides status, row goes to Leave in exact column order', async () => {
  const d = mk(); const r = await processRequest(input, d);
  assert.equal(r.rule.status, 'Auto-approved'); assert.equal(d.saved[0].tab, 'Leave');
  assert.equal(d.saved[0].row.length, 11); assert.deepEqual(d.saved[0].row.slice(4, 9), ['2026-11-09', '2026-11-11', 'Casual Leave', 'Family', 3]);
});
test('Gemini cannot override status: extra "status" field is ignored', () => {
  assert.equal(normalizeExtraction('LEAVE', { start_date: '2026-11-09', end_date: '2026-11-09', status: 'Auto-approved' }).status, undefined);
});
test('classification failure -> OTHER, Check by hand, never approved', async () => {
  const d = mk({ classify: async () => { throw new Error('Gemini API returned HTTP 503'); } }); const r = await processRequest(input, d);
  assert.equal(r.category, 'OTHER'); assert.equal(r.rule.status, 'Check by hand'); assert.equal(d.saved[0].tab, 'Other'); assert.equal(d.saved[0].row.length, 7);
});
test('extraction failure -> empty fields -> manual review, not approval', async () => {
  const r = await processRequest(input, mk({ extract: async () => { throw new Error('Gemini returned invalid JSON'); } }));
  assert.equal(r.rule.status, 'Needs manual review'); assert.equal(r.needsHuman, true);
});
test('multiple categories flag forces OTHER even if type says LEAVE', async () => {
  const r = await processRequest(input, mk({ classify: async () => ({ type: 'LEAVE', classification_reason: 'mixed', is_unclear: false, has_multiple_categories: true }) }));
  assert.equal(r.category, 'OTHER'); assert.equal(r.rule.status, 'Check by hand');
});
test('Sheets failure keeps the request; retry saves once; second retry is refused (no duplicate)', async () => {
  let n = 0; const d = mk({ save: async () => (++n === 1 ? { ok: false, error: 'down', maybeDuplicate: false } : { ok: true, error: null, maybeDuplicate: false }) });
  const r = await processRequest(input, d); assert.equal(r.save.ok, false); assert.equal(r.description, input.description);
  await retrySave(r, d); assert.equal(r.save.ok, true);
  await assert.rejects(() => retrySave(r, d), /Already saved/); assert.equal(n, 2);
});
test('validation: empty name, bad email, empty description', async () => {
  for (const bad of [{ ...input, name: ' ' }, { ...input, email: 'nope' }, { ...input, description: '' }]) await assert.rejects(() => processRequest(bad, mk()), /Validation failed/);
});
test('invalid classification JSON is rejected', () => {
  assert.throws(() => validateClassification({ type: 'MAYBE', is_unclear: false, has_multiple_categories: false }));
  assert.throws(() => validateClassification({ type: 'LEAVE' }));
});
test('formula-looking text is neutralised in sheet rows', () => {
  const row = buildRow({ timestamp: 't', employee: '=HYPERLINK("x")', email: 'e', description: 'd', category: 'OTHER', extracted: {}, classification: { classification_reason: 'r' }, rule: { status: 'Check by hand', rule: 'r' } });
  assert.equal(row[1], `'=HYPERLINK("x")`);
});
````

---

## FILE: `scripts/run-scenarios.js`

````javascript
// Runs the 8 assignment scenarios against the REAL running server (real Gemini + real Sheets).
// Usage: start the server (npm start), then in a second terminal: npm run scenarios
import fs from 'node:fs';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const CASES = [
  ['Leave, 3 working days', 'I need casual leave from 9 November to 11 November 2026 for a family function.', 'LEAVE', 'Auto-approved'],
  ['Leave, more than 3 days', 'Please approve sick leave from 16 November to 20 November 2026 because I am recovering from a minor surgery.', 'LEAVE', 'Needs manager approval'],
  ['Expense 1,500 with receipt', 'I spent ₹1,500 on office stationery on 4 November 2026 for the team workshop. I have the receipt.', 'EXPENSE', 'Auto-approved'],
  ['Expense 3,500 with receipt', 'I paid ₹3,500 for a client lunch on 3 November 2026. I have the receipt.', 'EXPENSE', 'Needs finance approval'],
  ['Expense 1,200 no receipt', 'I bought a USB hub for ₹1,200 on 2 November 2026 for the office. I do not have the receipt.', 'EXPENSE', 'Needs manual verification'],
  ['Routine laptop software issue', 'The PDF reader on my laptop shows a small display glitch. It is a minor annoyance and I can continue working normally.', 'IT_SUPPORT', 'Standard support ticket'],
  ['Critical laptop failure', 'My laptop will not turn on at all and I cannot do any work. This is critical, I have a client presentation today.', 'IT_SUPPORT', 'Escalated'],
  ['Ambiguous leave + expense', 'I need leave on 12 November 2026 and I also want to claim ₹2,500 for a taxi I took last week.', 'OTHER', 'Check by hand'],
];
const rows = [];
for (const [i, [label, text, expCat, expStatus]] of CASES.entries()) {
  let rec = null, err = '';
  try {
    const res = await fetch(`${BASE}/api/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Test User ${i + 1}`, email: `test${i + 1}@example.com`, description: text }) });
    for (const line of (await res.text()).split('\n').filter(Boolean)) { const m = JSON.parse(line); if (m.type === 'result') rec = m.record; if (m.type === 'fatal') err = m.error; }
  } catch (e) { err = e.message; }
  const cat = rec?.category ?? 'ERROR', st = rec?.rule.status ?? err, saved = rec ? (rec.save.ok ? `OK -> ${rec.tab}` : `FAILED: ${rec.save.error}`) : 'not saved';
  const pass = rec && cat === expCat && st === expStatus && rec.save.ok;
  rows.push({ n: i + 1, label, expCat, cat, expStatus, st, saved, pass: pass ? 'PASS' : 'FAIL', extracted: rec?.extracted });
  console.log(`#${i + 1} ${label}: ${pass ? 'PASS' : 'FAIL'}  [${cat} / ${st} / ${saved}]\n   extracted: ${JSON.stringify(rec?.extracted)}  <- check this by eye against the request`);
}
const md = ['| # | Input request | Expected category | Actual category | Expected status | Actual status | Sheets save result | Pass/Fail |', '|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.n} | ${CASES[r.n - 1][1]} | ${r.expCat} | ${r.cat} | ${r.expStatus} | ${r.st} | ${r.saved} | ${r.pass} |`)].join('\n');
fs.writeFileSync('tests/results.md', md + '\n'); console.log('\nWrote tests/results.md');
````

---

## FILE: `README.md`

````markdown
# Office Request Desk

A working automation workflow: **form submit -> Gemini classifies -> branch -> Gemini extracts -> JavaScript rules decide -> save to Google Sheets -> show result**, with a human-review path.

## Architecture
```
Browser (public/index.html)  --POST-->  Node/Express server (server.js)
                                           |- src/workflow.js  controller (runs stages in order)
                                           |- src/gemini.js    AI: classify + extract (API key lives here, server-side)
                                           |- src/rules.js     CODE: IF/THEN business rules (no AI)
                                           |- src/sheets.js    CODE: builds rows, POSTs to your Apps Script
                                           |- src/store.js     request log used for dashboard counts
```
Why a server? A Gemini key placed in browser code is public. The server keeps it in an environment variable.

## Run it (beginner steps)
1. Install Node.js 20+ from nodejs.org.
2. Get a Gemini API key at https://aistudio.google.com/apikey.
3. In this folder: `npm install`
4. Copy `.env.example` to `.env` (Mac/Linux: `cp .env.example .env`; Windows: `copy .env.example .env`). Open `.env`, replace `paste-your-key-here` with your key. **This is the only place to put the key.** `APPS_SCRIPT_URL` is already set to your `/exec` URL.
5. `npm start`, then open http://localhost:3000. The page works only through this server (not by double-clicking the HTML file).
6. Run the code-only tests any time: `npm test`.
7. With the server running, open a second terminal and run `npm run scenarios`. It sends the 8 assignment requests through real Gemini and your real Sheet and writes `tests/results.md`. Open the Sheet and confirm each row is in the right tab.

## Deploy (Render, free tier)
1. Put this folder on GitHub (`.env` is git-ignored, so your key is not uploaded).
2. render.com -> New -> Web Service -> pick the repo. Build command `npm install`, start command `npm start`.
3. Environment tab: add `GEMINI_API_KEY`, `APPS_SCRIPT_URL` (and optionally `GEMINI_MODEL`).
4. Deploy; Render gives you a public URL. Note: free-tier disk is wiped on restart, so the history/dashboard resets (the Google Sheet does not).

## Who does what
| Stage | Done by |
|---|---|
| Validate form | Code |
| Classify into LEAVE / EXPENSE / IT_SUPPORT / OTHER | **Gemini** |
| Enforce "unclear or mixed => OTHER" | Code |
| Extract fields (null if unknown) | **Gemini** |
| Apply rules, set status, count working days | **JavaScript** |
| Save row, confirm `ok:true` | Code + Apps Script |
| Approve manager/finance items, verify, escalate, check OTHER | **Human** |

**Why rules are not decided by AI:** the same request can get different AI answers, an AI can be talked into approving something, and you cannot audit its reasoning. Code gives the same answer every time and the "Rule Applied" column records why.

**Human review is required** for: Needs manager approval, Needs finance approval, Needs manual review, Needs manual verification, Escalated, Check by hand. Not required: Auto-approved, Standard support ticket. If Gemini fails or returns bad JSON, the request is never approved: classification failure -> OTHER / Check by hand; extraction failure -> empty fields -> Needs manual review/verification.

## Design decisions to be ready to defend
- "Essential IT info" = issue description + severity. Severity is never guessed (null => manual review). A null *work impact* just means the escalation trigger isn't met.
- Receipt `null` (not stated) is treated like no receipt: Needs manual verification.
- OTHER requests reuse the classification reason, so no second Gemini call.
- Retry safety: a request already confirmed saved cannot be retried. If the network dies mid-save the app warns a row *may* exist, because Apps Script gives no way to check.
- Text starting with `= + - @` is prefixed with `'` so it can't run as a spreadsheet formula.
- Dashboard counts come only from this server's log, since the Apps Script contract has no read endpoint. Request IDs are not stored in the Sheet (column layout is fixed).

## Status of testing (be honest in your report)
- **Executed:** `npm test` (29 tests): rules and workflow logic with *stubbed* Gemini/Sheets.
- **Not yet executed by me:** real Gemini calls, real Apps Script writes, the 8 scenarios, and the Gemini-failure / endpoint-down edge cases. Run `npm run scenarios` and paste `tests/results.md` into your report. For failure cases, set a wrong `GEMINI_API_KEY` or `APPS_SCRIPT_URL`, submit, and screenshot the result.
````
