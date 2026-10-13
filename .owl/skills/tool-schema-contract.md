---
name: tool-schema-contract
description: Rules for publishing tool parameter schemas that weak models can call, and validation errors they can recover from. Enforced by scripts/check-tool-contract.mjs (npm run check:tool-contract). Load when adding or changing a tool's parameters schema or its validation errors.
---

# Tool Schema Contract

Production evidence (Owl 会话记录, 2026-10): `glm-5.3-flash` calling `research_checkpoint` (published as a top-level `Type.Union` of three object branches, rendered as JSON Schema `anyOf`) emitted six consecutive bare calls with `arguments: {}` and only 6 output tokens each. The framework-level validation error only listed missing properties, which the model could not turn into a valid call. After flattening the published schema to one `Type.Object` and appending a copyable JSON template to the execute-level error, the same tool became callable and self-healing.

## Rule 1 - One flat `Type.Object` per tool

A tool's published `parameters` must be a single `Type.Object`. A top-level `Type.Union` whose branches include objects (JSON Schema `anyOf` of objects) is banned. Unions of scalars inside a field (`action`, `engine`, `status`) are fine.

Why:

- `anyOf`-of-objects is the shape weak models emit bare calls against.
- The framework validator (`packages/ai/src/utils/validation.ts`) cannot describe which branch of an `anyOf` to pick; its error is generic and not customizable.
- A flat schema lets a bare/partial call reach your `execute`, where your own error can carry a template (Rule 2).

Rules:

- Flatten branch fields into top-level fields; make every field `Type.Optional` that a weak model may omit on a still-meaningful call.
- Move branch requirements into `execute` (or the exported `run*` function) and reject them there: `decompile` requires `path`, `engine: "native"` refuses `names`, `inventory` accepts nothing else. Keep the strict re-validation private (see `checkpoint.ts` `saveSchema`/`readSchema`, `decompile-tools.ts` `runResearchDecompile`).
- Keep per-field constraints (lengths, patterns, enum literals) in the schema; those render as actionable field-level messages.

## Rule 2 - Validation errors carry a copyable JSON template

Every schema-level fallback error your code throws must contain a ready-to-fill JSON template. A field list ("必须提供 goal、status、...") does not let a weak model recover; a template does.

```ts
const DECOMPILE_TEMPLATE =
	'标准格式：{"action":"decompile","path":"<用户选中的本地 EXE、DLL、ASAR、JSC 或 JS>","engine":"auto","timeoutMs":60000}；只探测工具链用 {"action":"inventory"}；engine=native 时省略 names。';
throw new Error(`反编译参数无效，不接受其它字段。${DECOMPILE_TEMPLATE}`);
```

Template rules:

- One line, `标准格式：` prefix, double-quoted JSON with `<>` placeholders.
- Covers the common actions minimally, not every field.
- Field-specific messages that already name the fix ("移除 names 后重试") do not need a template; schema-fallback messages (`参数无效` / `invalid arguments` / `必须提供` / `不接受其它字段`) do.

Reference implementations: `checkpoint.ts` (`SAVE_TEMPLATE`), `decompile-tools.ts` (`DECOMPILE_TEMPLATE`).

## Checker

`npm run check:tool-contract` scans `packages/*/src` and `apps/*/src` (skips `.d.ts`, `.test.ts`, and `test`/`tests`/`examples` directories):

- error (exit 1): published `parameters` is a top-level union containing object branches.
- warning (does not fail): a schema-fallback error without a copyable template.
- `--json` for machine output, `--root <dir>` for fixtures.

## Checklist for a new tool

1. `parameters: Type.Object({...})`; fields `Type.Optional` unless omitting them can never be a meaningful call.
2. Enforce branch requirements in `execute` / the exported `run*` function; re-validate strictly with a private schema.
3. Every schema-fallback rejection: append a `标准格式：{...}` template with real field names.
4. Run `npm run check:tool-contract` and keep it clean.
