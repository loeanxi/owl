# Evaluation streaming browser validation

Success: true

Actual App, WebSocket and EvaluationService; manually gated offline producer, zero paid calls. No actual user auth, data, or existing server was touched.

- PASS: thinking-only stage stays running and shows waiting hint without revealing identity
- PASS: two cards receive growing body while their real service run is unfinished
- PASS: scrolling upward pauses only that card; continuing follows the next output
- PASS: explicit source tab is not overridden by later streamed paragraphs
- PASS: chat navigation preserves background stream and catches up on return
- PASS: cancelling retains every received body paragraph and ignores late producer callbacks


