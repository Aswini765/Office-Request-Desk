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

  // 1) AI classifies. If it fails after retries, we do NOT guess and do NOT label as OTHER.
  emit({ stage: 'classify', actor: 'AI', state: 'running' });
  let classificationFailed = false;
  try {
    rec.classification = await deps.classify(description, today);
    emit({ stage: 'classify', actor: 'AI', state: 'done', detail: `${rec.classification.type}: ${rec.classification.classification_reason}` });
  } catch (e) {
    classificationFailed = true;
    rec.classification = null;
    rec.category = null;
    rec.classificationFailed = true;
    rec.aiNotes.push(`Classification failed: ${e.message}`);
    emit({
      stage: 'classify',
      actor: 'AI',
      state: 'error',
      detail: 'AI classification is temporarily unavailable. Please retry or send this request for manual review.',
    });
  }

  if (classificationFailed) {
    // Classification failed: do NOT label as OTHER, do NOT apply automatic approval rules, do NOT save to Sheets
    rec.extracted = {};
    rec.missing = [];
    rec.rule = {
      status: 'CLASSIFICATION_FAILED',
      rule: 'AI classification is temporarily unavailable. Please retry or send this request for manual review.',
    };
    rec.needsHuman = true;
    emit({ stage: 'rules', actor: 'Code', state: 'done', detail: 'CLASSIFICATION_FAILED: manual review required' });
    rec.tab = null;
    rec.row = null;
    rec.save = {
      ok: false,
      error: 'AI classification is temporarily unavailable. Please retry or send this request for manual review.',
      maybeDuplicate: false,
      attempts: 0,
      skipped: true,
    };
    emit({ stage: 'save', actor: 'Code', state: 'error', detail: 'Skipped: cannot save unclassified request to Google Sheets' });
    return rec;
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
  rec.save = {
    ...rec.save,
    ok: r.ok,
    tab: r.tab || rec.tab,
    row: r.row ?? null,
    error: r.error,
    maybeDuplicate: r.maybeDuplicate,
  };
  emit({
    stage: 'save',
    actor: 'Code',
    state: r.ok ? 'done' : 'error',
    detail: r.ok
      ? `Saved to "${r.tab || rec.tab}" tab at row ${r.row} (Apps Script confirmed ok:true)`
      : r.error,
  });
}

// Retry only if the save was never confirmed. The same row (same timestamp) is re-sent.
export async function retrySave(rec, deps = defaultDeps(), emit = () => {}) {
  if (!rec.tab || !rec.row) {
    const e = new Error('Cannot save an unclassified or invalid request to Google Sheets');
    e.status = 400;
    throw e;
  }
  if (rec.save.ok) { const e = new Error('Already saved; retry refused to avoid a duplicate row'); e.status = 409; throw e; }
  await saveStep(rec, deps, emit);
  return rec;
}
