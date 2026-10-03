# Desktop browser regressions

Run the Workbench drag regression from the repository root:

```sh
node apps/desktop/scripts/workbench-resize.browser.mjs /absolute/output/directory
```

The script uses the installed `playwright-core`, `esbuild`, Tailwind dependencies and a local Chromium browser. Set `OWL_BROWSER_TEST_EXECUTABLE` when the browser is not at a standard location. No browser download, real bridge, Office worker, model request or provider key is used.

It compiles the actual `Workbench.tsx`, `PluginViewerTab.tsx` and their registration/store code into a production minified React fixture and compiles the current source CSS. Two local HTTP origins exercise the plugin iframe boundary while fake tool updates, `fs_changed` and parent renders continue every 45 milliseconds. The iframe renders a plain HTML document; the test checks Workbench interaction and does not validate the Office document engine.

Assertions cover width/height convergence across the iframe, fast mouse movement, release, repeated drags, iframe clicks after release, localStorage and refresh, blur, cancel, lost capture, zero buttons, hide, dock change, unmount, a real internal split divider and dragging a tab to split a panel. It also checks immediate cleanup after an intentional callback error, tab activation and dragging when pointer capture is unavailable, close buttons and middle click. Output contains source hashes, browser results and screenshots. Any failed assertion exits with status 1; this is a specific browser regression, not the full suite or a production build.
