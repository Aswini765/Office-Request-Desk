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
