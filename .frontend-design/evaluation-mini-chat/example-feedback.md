## Frontend design round-trip
Source: .frontend-design/evaluation-mini-chat/2026-10-04-evaluation-mini-chat.html
Captured at: 2026-10-03 22:24:49 (local)
Skill: frontend-design
Topic: evaluation-mini-chat

### Decisions

#### Owl 配色
- `--color-owl-accent` (light) → `#28864d`
- `--color-owl-accent` (dark)  → `#28864d`
  - rejected: owl(L:#2f9e5a/D:#2f9e5a)

### Direct edits

#### Edit 1
- Element: `[data-fd-id="evaluation-task-title"]` (evaluation-task-title)
- Kind: text
- Value: 鹈鹕骑自行车 · 会话原型

### Element comments

#### Comment 1
- Element: `[data-fd-id="evaluation-input-a"]` (evaluation-input-a)
- Scope: this
- Note: 输入框可以再高一点，让追问更容易填写。

### Apply

When applying these changes:

1. **Token decisions** — write into `apps/desktop/src/features/evaluation/evaluation.css` under `:root` (typography/radius/spacing), `.theme-light`, and `.theme-dark` blocks. Components must consume the CSS variables; do not hardcode values per component.

2. **Direct edits** — locate each edited element via its `data-fd-id` in the corresponding source. Apply value changes to components, props, fixtures, or locale keys as appropriate. Do not bypass i18n for user-facing copy when the project has i18n.

3. **Element comments** — locate each commented element via its `data-fd-id` in the corresponding source. Apply the change as instructed by the Note text. Honor the Scope:
   - `this` → modify only this specific instance
   - `all-matching` → modify the component-level CSS / source so all matching elements get the change
   - `all-like-this` → modify the shared component such that all elements sharing the data-fd-id family pick up the change
   - `global` → modify the global token / theme file

4. **Verify** — build / lint / preview as appropriate for the project. Optionally regenerate the preview HTML to confirm the new state.