# Evaluation streaming browser validation

Success: true

Actual App, WebSocket and EvaluationService; manually gated offline producer, zero paid calls. No actual user auth, data, or existing server was touched.

- PASS: waiting stage uses separate conversation streams and still hides model identity
- PASS: provider thinking grows visibly before either model produces an answer
- PASS: two cards receive growing body while their real service run is unfinished
- PASS: scrolling upward pauses only that card; continuing follows the next output
- PASS: explicitly collapsed thinking remains collapsed as the body grows
- PASS: chat navigation preserves background stream and catches up on return
- PASS: the process reports artifact checking after the producer finishes
- PASS: cancelling retains every received body paragraph and ignores late producer callbacks


