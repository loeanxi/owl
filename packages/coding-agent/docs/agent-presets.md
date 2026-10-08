# Desktop Agent presets

The desktop preset picker includes Standard, PTC, Minimal, Pi, and Creator modes. Built-in presets are read-only; duplicate one to create an editable custom preset. Choose a preset before sending the first message, or set it as the default for new conversations in Settings.

## Pi mode

Pi mode follows the four-tool coding configuration verified against [Pi v1.1.0](https://github.com/earendil-works/pi/tree/v1.1.0). It uses Owl's existing agent core and file tools, with a short prompt assembled from their current tool snippets and guidelines:

| Tool | Purpose |
|---|---|
| `read` | Read files and images. |
| `bash` | Run commands and wait for completion. |
| `edit` | Apply precise text replacements to existing files. |
| `write` | Create files or rewrite complete files. |

The mode uses a compact coding prompt and preserves project AGENTS/CLAUDE instructions. Automatic extensions, skills, prompt templates, MCP tools, browser tools, and Owl desktop/user-impression addenda are excluded. Model selection, thinking level, and approval controls remain available.

The prompt includes the actual `edits[]` structure, exact matching against the original file, disjoint replacements, and Owl's current-turn read prerequisites for edits and overwrites. Tool guidelines that suggest capabilities outside the four-tool preset are omitted. This is a Pi-style Owl preset with Owl's file-read protections, not a separate installation of the Pi CLI.

Unlike Owl's standard shell, Pi's `bash` stays in the foreground and accepts only `command` and optional `timeout` (seconds). It waits until completion when no timeout is provided, so no separate `process` tool is needed. Cancellation and explicit timeouts still stop the command.

Preset bindings survive session restoration. Switching an empty conversation into or out of Pi rebuilds its runtime while preserving its session ID, model, thinking level, and approval choice. A duplicated Pi preset retains `runtime: "pi"` in its JSON, together with its tool selection and optional appended prompt.

Pi itself supports extensions and skills; their exclusion here implements this preset's minimal configuration.
