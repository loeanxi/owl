const fs = require('node:fs');
const vm = require('node:vm');
const sandbox = {
  window: {},
  icon: () => '<svg></svg>',
  button: (text, action, cls) => `<button data-action="${action}" class="${cls}">${text}</button>`,
  input: (value, placeholder) => `<input value="${value}" placeholder="${placeholder}">`,
  select: (items) => `<select>${items.map((v) => `<option>${v}</option>`).join('')}</select>`,
  toggle: (on) => `<input type="checkbox" ${on ? 'checked' : ''}>`,
  tag: (text, tone) => `<span class="tag ${tone}">${text}</span>`,
  field: (label, description, control) => `<label>${label}<span>${description}</span>${control}</label>`,
  row: (title, description, control) => `<div>${title}${description}${control}</div>`,
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('D:/owl/owl-re-v1/owl-mono/.frontend-design/owl-redesign/dialog-views.js', 'utf8'), sandbox);
const globalIds = new Set();
let count = 0;
for (const [key, dialog] of Object.entries(sandbox.window.OWL_DIALOGS)) {
  const html = dialog.html();
  const ids = [...html.matchAll(/data-fd-id="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate IDs in ${key}`);
  for (const id of ids) {
    if (globalIds.has(id)) throw new Error(`Cross-dialog duplicate ID: ${id}`);
    globalIds.add(id);
  }
  for (const tag of html.match(/<[^>]+data-fd-editable=[^>]+>/g) ?? []) {
    if (!tag.includes('data-fd-editable="text"') || !tag.includes('data-fd-id="')) {
      throw new Error(`Editable annotation missing in ${key}: ${tag}`);
    }
  }
  if (key === 'context' && /autoCompact|自动压缩|19%/.test(html)) throw new Error('Context contains old data');
  count++;
}
console.log(`Rendered ${count} dialogs; ${globalIds.size} IDs are unique; all editable text annotations are complete.`);
