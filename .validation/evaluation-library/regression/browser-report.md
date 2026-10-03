# Model evaluation browser integration

Success: true

Actual Vite App, DesktopServer WebSocket and EvaluationService; fake offline model and check boundaries. No paid calls, user auth, user data, existing processes, or production build.

- PASS: actual top-menu entry and 24 real built-in tasks
- PASS: new-run sample selector updates 1 and 3 call counts, actual start uses one call
- PASS: anonymous wire and DOM hide metadata; scoring draft survives chat/evaluation switches
- PASS: three criteria scoring reveals real identities without changing order
- PASS: Summary keeps distinct 5/3/4 criterion means and each 1/1 denominator
- PASS: two-model comparison, extra samples, and retained failure retry
- PASS: new three-sample run performs exactly three isolated calls
- PASS: Summary never mixes G01 and G07 criteria sharing the SVG category
- PASS: custom-task required fields and actual persisted save
- PASS: run history refresh retains real records and browser reload
- PASS: real server restart restores scores, order, custom tasks, and all attempts


