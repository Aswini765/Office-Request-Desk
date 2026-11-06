| # | Input request | Expected category | Actual category | Expected status | Actual status | Sheets save result | Pass/Fail |
|---|---|---|---|---|---|---|---|
| 1 | I need casual leave from 9 November to 11 November 2026 for a family function. | LEAVE | LEAVE | Auto-approved | Auto-approved | OK -> Leave | PASS |
| 2 | Please approve sick leave from 16 November to 20 November 2026 because I am recovering from a minor surgery. | LEAVE | LEAVE | Needs manager approval | Needs manager approval | OK -> Leave | PASS |
| 3 | I spent ₹1,500 on office stationery on 4 November 2026 for the team workshop. I have the receipt. | EXPENSE | EXPENSE | Auto-approved | Auto-approved | OK -> Expense | PASS |
| 4 | I paid ₹3,500 for a client lunch on 3 November 2026. I have the receipt. | EXPENSE | OTHER | Needs finance approval | Check by hand | OK -> Other | FAIL |
| 5 | I bought a USB hub for ₹1,200 on 2 November 2026 for the office. I do not have the receipt. | EXPENSE | OTHER | Needs manual verification | Check by hand | OK -> Other | FAIL |
| 6 | The PDF reader on my laptop shows a small display glitch. It is a minor annoyance and I can continue working normally. | IT_SUPPORT | OTHER | Standard support ticket | Check by hand | OK -> Other | FAIL |
| 7 | My laptop will not turn on at all and I cannot do any work. This is critical, I have a client presentation today. | IT_SUPPORT | OTHER | Escalated | Check by hand | OK -> Other | FAIL |
| 8 | I need leave on 12 November 2026 and I also want to claim ₹2,500 for a taxi I took last week. | OTHER | OTHER | Check by hand | Check by hand | OK -> Other | PASS |
