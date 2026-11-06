import 'dotenv/config';
import express from 'express';
import { processRequest, retrySave } from './src/workflow.js';
import { validateInput } from './src/validate.js';
import { runSheetsDiagnostic } from './src/sheets.js';
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

app.all('/api/diagnostic/sheets', async (_req, res) => {
  try {
    const result = await runSheetsDiagnostic();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Office Request Desk running on http://localhost:${port}`));
