# Desktop browser regressions

Run the Workbench drag regression from the repository root:

```sh
node apps/desktop/scripts/workbench-resize.browser.mjs /absolute/output/directory
```

The script uses the installed `playwright-core`, `esbuild`, Tailwind dependencies and a local Chromium browser. Set `OWL_BROWSER_TEST_EXECUTABLE` when the browser is not at a standard location. No browser download, real bridge, Office worker, model request or provider key is used.

It compiles the actual `Workbench.tsx`, `PluginViewerTab.tsx` and their registration/store code into a production minified React fixture and compiles the current source CSS. Two local HTTP origins exercise the plugin iframe boundary while fake tool updates, `fs_changed` and parent renders continue every 45 milliseconds. The iframe renders a plain HTML document; the test checks Workbench interaction and does not validate the Office document engine.

Assertions cover width/height convergence across the iframe, fast mouse movement, release, repeated drags, iframe clicks after release, localStorage and refresh, blur, cancel, lost capture, zero buttons, hide, dock change, unmount, a real internal split divider and dragging a tab to split a panel. It also checks immediate cleanup after an intentional callback error, tab activation and dragging when pointer capture is unavailable, close buttons and middle click. Output contains source hashes, browser results and screenshots. Any failed assertion exits with status 1; this is a specific browser regression, not the full suite or a production build.

Run the conversation artifact regression from the repository root:

```sh
node apps/desktop/scripts/artifacts-turn.browser.mjs /absolute/output/directory
```

The output directory is optional and defaults to `owl-artifacts-turn-results` inside the system temporary directory. The script resolves its source paths relative to itself, uses an installed Chromium browser and does not download one. `OWL_BROWSER_TEST_EXECUTABLE` supports a custom browser location.

This regression bundles the actual `App.tsx`, `ChatStream.tsx`, `Artifacts.tsx`, artifact collection, transcript processing and `BridgeClient` into a production minified React page with the current Tailwind and component CSS. A local fake WebSocket bridge supplies an existing Office artifact, receives prompts from the actual composer and emits controlled agent events. A second local HTTP origin verifies the historical artifact's real App file-opening callback. No running bridge, existing user session, document file, Office engine, LLM, paid API or provider key is accessed; News requests are explicitly disabled by the fixture. If the unrelated Mail component references a missing `mail.css` during parallel development, the test alone supplies empty CSS and records that fallback. An existing stylesheet is always bundled normally.

The same 14 assertions run against either buggy or fixed source, with no red/green mode or expected failures. They check that a new prompt immediately clears the current footer, previous artifacts remain clickable beside their original answer, pure question-and-answer streaming and snapshot restoration do not bring old artifacts into the footer, pending/failed tools produce no cards, new outputs survive authoritative snapshots, repeated edits deduplicate within a turn, the same file can appear in separate turns, and switching to a session without outputs clears the footer. Results include source hashes, browser errors, fake bridge requests and screenshots. Any failed assertion exits with status 1.

Run the composer question-card regression from the repository root:

```sh
node apps/desktop/scripts/question-card.browser.mjs /absolute/output/directory
```

The script bundles the actual App, QuestionDock, QuestionDialog, Composer, Workbench and BridgeClient with production minification and current styles. It uses an installed Chromium browser, a local fake WebSocket bridge and an isolated Office iframe; it accesses no real sessions, document files, providers or paid APIs. Formal runs use the current source without module fallbacks. The optional output directory defaults to `owl-question-card-results` inside the system temporary directory.

The 43 assertions preserve the previous 34 answer-control and layout checks, and add a one-question fixture matching the reported four-option card with mixed-length descriptions. This fixture checks equal heights within each option row, a readable label/description hierarchy, complete descriptions without truncation or horizontal overflow, no ordinary-body scrolling at wide width, a height at most 280 pixels, and no full-width progress bar for a single question. Optional custom input and notes start hidden, open through their real buttons, preserve their contents after collapse and submit the exact answer payload. Dark/light and narrow screenshots record the result.

Environment controls are absent from the composer while the current session has a question or is running, and return after an answer, cancellation, completion or lost connection. Tests keep the task input, model/mode controls and actual stop action available, retain its draft, preserve selected question answers through reconnection, and confirm that background questions or running sessions do not hide the active session's environment controls.

The original assertions cover alignment above the composer at 1920/1280/960/760 pixels, both workbench docks, resizing and a short window with the bottom pane dragged to its maximum. A four-option, two-question fixture checks compact height, two columns in wide cards, one column in narrow cards and real space above the composer without overlapping the message viewport. Long descriptions remain readable by scrolling while the footer stays visible. Collapsing restores chat space, preserves latest-message scrolling or the user's historical position, hides inactive controls from keyboard focus and retains the current question, selected choices, custom text, notes and previews after expansion. Original wire-payload checks include validation, scoped shortcuts, preview-button keyboard behavior, queued requests and session-switch drafts. Results contain source hashes, requests and screenshots. A failure exits with status 1. The isolated iframe proves visibility and interaction across the pane boundary; this does not validate native Tauri or the Univer document engine.

For diagnosis against saved source, `--baseline` loads `App.before.tsx`, `Composer.before.tsx`, `QuestionDialog.before.tsx`, `QuestionDock.before.tsx`, `question-card.before.css` and `question-dock.before.css` from the output directory. This mode runs the same placement, compact-height, viewport-overlap, wide-column, screenshot-row, optional-field and environment assertions against those snapshots and records failures normally. Formal runs always use current source.
