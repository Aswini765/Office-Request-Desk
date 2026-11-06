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
  ['Routine laptop software issue', 'The PDF reader on my laptop shows a small display glitch. It is a minor annoyance and I can continue working normally.', 'IT_SUPPORT', 'Normal'],
  ['Critical laptop failure', 'My laptop will not turn on at all and I cannot do any work. This is critical, I have a client presentation today.', 'IT_SUPPORT', 'Urgent'],
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
