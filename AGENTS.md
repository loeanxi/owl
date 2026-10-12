# Development Rules

## Repository Location (moved 2026-10-02 — read first)

- The project root moved from `D:\pire\pi-re-v1` to `D:\owl\owl-re-v1`. `D:\pire\pi-re-v1` NO LONGER EXISTS; only `D:\owl\owl-re-v1\owl-mono` is real.
- Do not trust the shell's cwd between commands (it may reset to an unrelated default such as `D:\mycode\Magiccode`). Use absolute paths under `D:\owl\owl-re-v1\owl-mono\...`, or `cd` within the same command, and `ls` to verify before writing.
- The launcher scripts now live in `D:\owl\owl-re-v1\scripts\` (`owl-dev.cmd`, `owl-dev.sh`, `owl-start.cmd`, `owl-start.ps1`, `owl-desktop.cmd`, `owl-tauri-dev.cmd`, `owl-native-dev.ps1`, plus the `make-shortcut.ps1` / `make-tauri-shortcut.ps1` builders). They no longer reference `D:\pire`: `owl-dev.cmd` sets `OWL_HOME=D:\owl\owl-re-v1` and `OWL_CODING_AGENT_DIR` to `data\owl`, then runs the built `cli.js`. `DEV-README.md` is at `D:\owl\owl-re-v1\DEV-README.md` and is current. Run these directly instead of invoking npm/npx by hand.
- The isolated agent data dir is now `D:\owl\owl-re-v1\data\owl` (auth.json, models.json). Point `OWL_CODING_AGENT_DIR` there if you set it.
- Never recreate files or directories under `D:\pire` to "fix" a missing path — fix the path reference instead.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.
- End every turn that touched TypeScript code with the affected packages still type-checking (`npm run check`, or per-package `npx tsc -p tsconfig.build.json --noEmit`). Concurrent sessions share this repo and the launcher runs full-workspace `tsc`, so one unfinished file blocks everyone's builds. If a change is intentionally incomplete, name the file and say so in your reply.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- `packages/coding-agent` has pre-existing failures listed in `test/known-failures.txt`. Check your change with `npm run test:changed` (tests related to uncommitted files) or `node scripts/test-known.mjs test/a.test.ts ...` from the package root; both fail only on failures missing from that list. Do not stash or re-run a "baseline" to tell old failures from new ones; if you truly need HEAD, use a worktree outside the repo and junction `node_modules` and `packages/ai/src/providers/data` into it (without the generated model data, test files fail to load and look green). Afterwards delete the two junctions with `cmd /c rmdir <path>` (never a recursive delete, which follows the junction into the real directory), then `git worktree remove` it.
- One full-suite run takes minutes. Run it at most once per task, after targeted tests pass; never re-run it unchanged.
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in that script; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple pi sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: follow `COMMIT_SPEC.md` in the repo root — `type(scope): subject` (Conventional Commits). Types: feat/fix/docs/refactor/perf/test/build/ci/chore/style/revert; scope = package/app directory (`coding-agent`, `desktop`, `ai`, `owl-*`, ...). Chinese subject, informative and concise. Never paste a conversational reply as the commit message; auto-commit hooks must follow the same spec.
- Every commit, by any agent or tool, must add its entry to the Owl changelog `CHANGELOG.md` in the repo root in the same commit (see "Owl Changelog" below). Stage it with your other files. Pre-commit rejects commits without it.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing pi Interactive Mode with tmux

For testing pi's interactive mode, load and follow [.owl/skills/interactive-testing.md](.owl/skills/interactive-testing.md).

## Owl Changelog

Location: `CHANGELOG.md` in the repo root. The desktop app bundles it and shows it under Settings > Changelog (更新日志). Required for every commit; `scripts/check-changelog-commit.mjs` (pre-commit) rejects commits that do not stage a new entry.

Format (Chinese, one line per logical change, same wording as the commit subject is fine):

```markdown
## 2026-10-12

### 新增

- `desktop` 设置新增「更新日志」分区
```

Rules:

- Date heading `## YYYY-MM-DD` is the commit date; newest date at the top. Reuse today's heading if it exists.
- Category heading is exactly one of `新增` (feat) / `改进` (perf, user-visible refactor) / `修复` (fix) / `移除` (removed feature) / `维护` (docs, test, build, ci, chore, style, internal refactor), in that order. Reuse an existing category under the same date; append new entries to its end.
- Entry: ``- `scope` description``; scope matches the commit header, omit it for cross-package changes. No conversational text, file paths outside the repo, or build status (same bans as commit subjects).
- One commit may add several entries; split by logical change, not by file.
- Concurrent sessions edit this file too: only add your own lines, and if another session's uncommitted lines are present, stage just your hunk (`git add -p CHANGELOG.md`).
- Bypass (`OWL_SKIP_CHANGELOG=1 git commit ...`) only when the user explicitly asks in that turn.

## Package Changelogs

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when working on a branch other than `main` or pull request

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/earendil-works/pi/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/earendil-works/pi/pull/456) by [@username](https://github.com/username))`

## Releasing

For release preparation, publishing, verification, or recovery, load and follow [.owl/skills/release.md](.owl/skills/release.md).

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
