# U5 accessibility and browser evidence sheet

Record the OS, browser, browser version, screen reader version, date, operator, and pass/fail for each run. This sheet is a procedure; unchecked rows are not evidence of execution.

| Environment                 | Version | Keyboard create / join / play / review / retention | 200% zoom | Forced colors / reduced motion | Screen reader announcements | Result |
| --------------------------- | ------- | -------------------------------------------------- | --------- | ------------------------------ | --------------------------- | ------ |
| Windows + NVDA + Chrome     |         |                                                    |           |                                |                             | 未実施 |
| macOS + VoiceOver + Safari  |         |                                                    |           |                                |                             | 未実施 |
| Chrome latest and previous  |         |                                                    |           |                                |                             | 未実施 |
| Edge latest and previous    |         |                                                    |           |                                |                             | 未実施 |
| Firefox latest and previous |         |                                                    |           |                                |                             | 未実施 |
| Safari latest and previous  |         |                                                    |           |                                |                             | 未実施 |

For each flow, use Tab and Shift+Tab without a pointer. Confirm the skip link, visible focus, form errors on both summary and field, dialog focus containment and return, and polite update announcements without duplicate messages. At 200% zoom check that every action remains available with no horizontal page scroll; data tables may scroll within their own container. In forced colors confirm labels and borders remain distinct. With reduced motion enabled confirm all actions remain available.

Run `npm --prefix apps/beer-game run e2e:u5:matrix` after installing the matrix browsers. Record the installed browser versions and attach the Playwright report. The latest and previous release checks require separate installed browser versions; the Playwright matrix alone does not establish those two release generations.
