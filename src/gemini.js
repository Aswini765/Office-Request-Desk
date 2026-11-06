// AI MODULE - Gemini classifies and extracts. It never decides approval status.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TYPES = ['LEAVE', 'EXPENSE', 'IT_SUPPORT', 'OTHER'];

export async function callGemini(prompt, {
  fetchImpl = fetch,
  maxAttempts = 3,
  initialDelayMs = 1000,
  timeoutMs = 20000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key.startsWith('paste-')) throw new Error('GEMINI_API_KEY is not configured on the server');
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(`${BASE}/${model}:generateContent`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      });
      if (!res.ok) {
        let errorDetails = '';
        try {
          const errData = await res.json();
          if (errData?.error?.message) errorDetails = `: ${errData.error.message}`;
        } catch {
          /* ignore */
        }
        const err = new Error(`Gemini API returned HTTP ${res.status}${errorDetails}`);
        err.status = res.status;
        const isTransient = [429, 500, 502, 503, 504].includes(res.status);
        if (!isTransient) {
          // Do not retry invalid API keys (400, 401, 403), not found (404), or client errors
          throw err;
        }
        throw err;
      }
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new Error('Gemini returned an empty response');
      try {
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        throw new Error('Gemini returned invalid JSON');
      }
    } catch (e) {
      lastError = e;
      // Do not retry permanent client errors (e.g. 400, 401, 403, 404)
      if (e.status && [400, 401, 403, 404].includes(e.status)) {
        throw e;
      }
      if (attempt < maxAttempts) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        if (delay > 0) {
          await sleepImpl(delay);
        }
      }
    }
  }
  throw lastError;
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
    device_or_system: str(r.device_or_system),
    blocked_from_work: bool(r.blocked_from_work) ?? (r.work_impact === 'Cannot work'),
    work_impact: pick(r.work_impact, ['Cannot work', 'Partially blocked', 'No impact']) || (r.blocked_from_work === true ? 'Cannot work' : 'No impact'),
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
  IT_SUPPORT: `{"issue_category":"Hardware|Software|Network|Access|Other or null","severity":"Low|Medium|High, only if stated or clearly implied by the description, else null","device_or_system":"e.g. Laptop or null","blocked_from_work":true if the employee cannot continue working or is blocked from work else false,"work_impact":"Cannot work|Partially blocked|No impact, only if the request shows it, else null","issue_description":"short text or null"}`,
};

export async function extract(type, text, today, call = callGemini) {
  if (type === 'OTHER') return {};
  const raw = await call(`Extract fields for a ${type} request. Return JSON in exactly this shape:\n${SCHEMAS[type]}\n${COMMON(today, text)}`);
  return normalizeExtraction(type, raw);
}
