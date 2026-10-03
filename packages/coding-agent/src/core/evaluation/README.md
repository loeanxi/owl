# Desktop model evaluation

The desktop title bar opens this workspace with `view=evaluation`. The browser uses `evaluation.request`; `EvaluationService` owns question snapshots, queued calls, validation, anonymous projections and local persistence.

- Each call has one fixed user prompt and optional input, with no chat history, project instructions or tools. The selected model and supported thinking level are frozen with the run. The two-call queue returns immediately from `run.start` and survives page changes and WebSocket reconnects.
- Questions, profiles, raw/partial answers, attempts, checks and ratings are stored under `<agentDir>/model-evaluations`. Question edits do not rewrite existing run snapshots. Restarted work is marked interrupted, and retries preserve earlier attempts.
- While an active run is displayed, the desktop reads the existing partial-answer projection every 500 ms. Running cards start on the full-answer tab, follow new text, and pause following when the reader scrolls up. Source text also updates during generation; artifact previews retain their completion checks. A model that has returned thinking but no answer text remains in the waiting-for-answer state.
- Group ordering is shuffled once per question/sample. Before reveal, model identity, requested/actual model metadata, thinking, timing, usage and cost are omitted from result projections. Scoring requires all three rubric values (integers 1–5) for every completed result. Skipping reveals identity but does not invent a rating.
- SVG checks cover XML nesting, resource policy, native rendering and question-specific geometry, data, repair, local edits or animation declarations. Human scoring covers shape, action and appearance. JSON relationship questions have fixed answers.
- HTML checks use an installed Chrome/Edge in a fresh context, with outbound requests blocked. The eight fixed questions receive real interaction tests. `OWL_EVALUATION_BROWSER_PATH` can select an installed browser; no browser is downloaded. Missing infrastructure is reported as unchecked, while an executed failing condition is reported as failed.
- Built-in code questions specify JavaScript functions and run independent normal/boundary/async probes in QuickJS/WASM with memory and execution limits and no host functions. TypeScript annotations can be stripped. Custom code without configured probes, including other languages, is explicitly unchecked for behavior.
- Usage is taken from the model response; missing/all-zero placeholders remain unknown. Cost uses configured USD token pricing and is an estimate. Model generation duration excludes artifact checking. Recorded forwarded settings do not prove upstream enforcement.

Targeted validation:

```powershell
# From packages/coding-agent (no paid providers)
node ../../node_modules/vitest/dist/cli.js --run test/evaluation-service.test.ts test/evaluation-model.test.ts test/desktop-evaluation-bridge.test.ts test/core/evaluation-checkers.test.ts test/core/evaluation-browser-checks.test.ts

# From the repository root
node --test apps/desktop/src/features/evaluation/evaluation-model.test.ts apps/desktop/src/features/evaluation/evaluation-preview.test.ts
node apps/desktop/scripts/evaluation.browser.mjs
```

The browser integration script uses the real App, bridge and service with fake model/check adapters and temporary local data. It does not consume configured model credits or restart existing services. Its screenshots and report are saved in `.validation/model-evaluation`.
