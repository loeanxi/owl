# Mini-chat evaluation browser validation

Success: true

Actual desktop WebSocket, EvaluationService and store; App was not started. Manually gated offline provider; checks are fake UI/RPC boundaries. Zero paid calls, no real user data/auth, and no production server was restarted.

- PASS: new requests use the full model budget and completion-first policy
- PASS: retry of a legacy capped run adopts current policy and retains the original record
- PASS: new content keeps streams alive while identical callbacks still hit the idle watchdog


