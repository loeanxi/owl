# Mini-chat evaluation browser validation

Success: true

Actual App, desktop WebSocket, EvaluationService and store. Manually gated offline provider; checks are fake UI/RPC boundaries. Zero paid calls, no real user data/auth, and no production server was restarted.

- PASS: each anonymous model has its own original prompt, stream and composer
- PASS: provider thinking and Markdown reply appear while the original run is unfinished
- PASS: one reader can pause scrolling without affecting the other conversation
- PASS: completed inline artifacts and drawers grade only the first answer
- PASS: A sends a real follow-up request, streams in its chat, and leaves B unchanged
- PASS: follow-up cancellation retains text and the next request forwards completed history only
- PASS: sample and chat navigation preserve the unsent message and first-answer summary
- PASS: a failed attempt keeps its partial answer and retry appends a separate attempt
- PASS: at 1280 by 860 both mini-chat composers stay inside the visible viewport
- PASS: isolated server restart restores followups, original scores, samples and attempt order


