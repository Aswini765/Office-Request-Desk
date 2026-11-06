// Netlify Function: serves every /api/* route of the Office Request Desk.
// It reuses the same src/ modules as server.js, so the business rules are identical.
// Netlify limits a synchronous function to 30 s, so Gemini retries are kept short here.
process.env.GEMINI_TIMEOUT_MS ||= '8000';
process.env.GEMINI_MAX_ATTEMPTS ||= '2';

import { processRequest, retrySave } from '../../src/workflow.js';
import { validateInput } from '../../src/validate.js';
import { runSheetsDiagnostic } from '../../src/sheets.js';
import * as store from '../../src/store.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const publicRec = ({ row, ...r }) => r;

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;

  if (method === 'GET' && path === '/api/health') {
    const key = process.env.GEMINI_API_KEY;
    return json({ ok: true, geminiConfigured: !!key && !key.startsWith('paste-'), sheetsConfigured: !!process.env.APPS_SCRIPT_URL });
  }
  if (method === 'GET' && path === '/api/stats') return json(store.stats());
  if (method === 'GET' && path === '/api/requests') return json(store.list().map(publicRec));

  if (method === 'POST' && path === '/api/requests') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
    const v = validateInput(body);
    if (!v.ok) return json({ error: 'Validation failed', fields: v.errors }, 400);

    // Stream progress as NDJSON, exactly like the Express server did.
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (o) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
        try {
          const rec = await processRequest(body, undefined, (e) => send({ type: 'stage', ...e }));
          store.put(rec);
          send({ type: 'result', record: publicRec(rec) });
        } catch (e) {
          send({ type: 'fatal', error: e.message });
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  }

  const retry = path.match(/^\/api\/requests\/([^/]+)\/retry$/);
  if (method === 'POST' && retry) {
    const rec = store.get(retry[1]);
    if (!rec) return json({ error: 'Unknown request id (the server may have restarted)' }, 404);
    if (rec.save.ok) return json({ error: 'Already saved; retry refused to avoid a duplicate row' }, 409);
    try { await retrySave(rec); store.put(rec); return json(publicRec(rec)); }
    catch (e) { return json({ error: e.message }, e.status || 500); }
  }

  if (path === '/api/diagnostic/sheets') {
    try { const r = await runSheetsDiagnostic(); return json(r, r.ok ? 200 : 502); }
    catch (e) { return json({ ok: false, error: e.message }, 500); }
  }

  return json({ error: 'Not found' }, 404);
};

export const config = { path: '/api/*' };
