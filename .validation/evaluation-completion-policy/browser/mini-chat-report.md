# Mini-chat evaluation browser validation

Success: true

Actual App, desktop WebSocket, EvaluationService and store. Manually gated offline provider; checks are fake UI/RPC boundaries. Zero paid calls, no real user data/auth, and no production server was restarted.

- PASS: each anonymous model has its own original prompt, stream and composer
- PASS: queued requests show queue status without a fabricated runtime
- PASS: provider thinking and Markdown reply appear while the original run is unfinished
- PASS: anonymous thinking timers advance without revealing identity or usage
- PASS: one reader can pause scrolling without affecting the other conversation
- PASS: completed inline artifacts and drawers grade only the first answer
- PASS: completed anonymous timers freeze at their own server runtime
- PASS: A sends a real follow-up request, streams in its chat, and leaves B unchanged
- PASS: a follow-up has its own advancing clock while the first answer stays frozen
- PASS: follow-up cancellation retains text and the next request forwards completed history only
- PASS: cancelled follow-up timers freeze without changing the original rating
- PASS: sample and chat navigation preserve the unsent message and first-answer summary
- PASS: a failed attempt keeps its partial answer and retry appends a separate attempt
- PASS: switching retained attempts selects the runtime of that exact answer
- PASS: at 1280 by 860 both mini-chat composers stay inside the visible viewport
- PASS: isolated server restart restores followups, original scores, samples and attempt order
- PASS: legacy results with unknown timestamps display unknown runtime honestly
- PASS: new requests use the full model budget and completion-first policy
- PASS: retry of a legacy capped run adopts current policy and retains the original record
- PASS: new content keeps streams alive while identical callbacks still hit the idle watchdog


