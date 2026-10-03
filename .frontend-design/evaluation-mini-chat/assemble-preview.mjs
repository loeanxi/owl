import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const template = await readFile('C:/Users/李现/.codex/skills/frontend-design/assets/preview-template.html', 'utf8');
const surface = await readFile(join(directory, 'mini-chat-surface.html'), 'utf8');
const templateStyle = template.match(/<style>([\s\S]*?)<\/style>/)[1];
const scaffoldStyle = templateStyle.slice(templateStyle.indexOf('  * { box-sizing'), templateStyle.indexOf('  .wb-header {')) + templateStyle.slice(templateStyle.indexOf('  /* Direct edits */'));
const productStyle = [...surface.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
const productScript = [...surface.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const productMarkup = surface.match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1].replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const templateScript = template.match(/<script>([\s\S]*?)<\/script>/)[1];
const mechanics = templateScript.slice(templateScript.indexOf('const decisions = {}'));
let header = template.slice(template.indexOf('<div class="app">'), template.indexOf('    <section class="preview-pair"'));
header = header.replace('frontend-design preview', '模型测评 · 独立会话原型')
  .replace('Decision controls on the left · live preview on the right · click <strong>Comment Mode</strong> to annotate any element', '展开深色画面查看完整布局；可以点击元素批注、修改文字，最后导出你的调整。')
  .replace(/Export to markdown/g, '导出设计意见').replace(/>Reset</g, '>重置<').replace(/>Comment Mode</g, '>添加批注<')
  .replace(/>Show Markers</g, '>显示批注<').replace(/>Collapse</g, '>收起调参<')
  .replace(/<div class="help-banner">[\s\S]*?<\/div>/, '<div class="help-banner">这里使用 Owl 的实际主题变量。主画面中可以展开思考、追问、打开作品源码与评分。所有模型回复仅用于原型演示。</div>');
const overlays = template.slice(template.indexOf('<!-- Markers layer -->'), template.indexOf('<script>'));
const tokens = {
  appearance: [
    { key: '--owl-ui-canvas', intent: '工作区底色', kind: 'color', options: [{ id: 'neutral', light: '#fafbf9', dark: '#1c1c1c', note: 'Owl 当前中性灰 (default)' }, { id: 'owl-green', light: '#fafbf9', dark: '#202321', note: 'Owl 绿灰预设' }] },
    { key: '--owl-ui-panel', intent: '独立会话表面', kind: 'color', options: [{ id: 'neutral', light: '#ffffff', dark: '#252525', note: 'Owl 当前面板 (default)' }, { id: 'owl-green', light: '#ffffff', dark: '#282d29', note: 'Owl 绿灰面板' }] },
    { key: '--owl-ui-border', intent: '窗口边界', kind: 'color', options: [{ id: 'neutral', light: '#e0e5df', dark: '#343434', note: '当前边界 (default)' }, { id: 'owl-green', light: '#e0e5df', dark: '#343c35', note: '绿灰边界' }] },
    { key: '--color-owl-accent', intent: 'Owl 强调色', kind: 'color', options: [{ id: 'owl', light: '#2f9e5a', dark: '#2f9e5a', note: 'Owl 图标绿 (default)' }, { id: 'custom-green', light: '#28864d', dark: '#28864d', note: 'Owl 深绿' }] },
  ],
  reading: [
    { key: '--font-sans', intent: '界面与消息字体', kind: 'dropdown', options: [{ id: 'sans', value: '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif', note: 'Owl 无衬线 (default)' }, { id: 'serif', value: 'Georgia, "Microsoft YaHei", "PingFang SC", serif', note: 'Owl 回答字体' }] },
  ],
};
const meta = { source: '.frontend-design/evaluation-mini-chat/2026-10-04-evaluation-mini-chat.html', topic: 'evaluation-mini-chat', targetFile: 'apps/desktop/src/features/evaluation/evaluation.css' };
const chrome = `:root{--font-stack:"Segoe UI","Microsoft YaHei",sans-serif;--font-app-title:18px;--font-body:13px;--font-dense:12px;--font-meta:11px;--radius-default:6px;--radius-shell:10px} .preview{padding:30px 0 0;overflow:auto;background:var(--owl-ui-canvas);--surface-panel:var(--owl-ui-panel);--border-subtle:var(--owl-ui-border);--accent-primary:var(--color-owl-accent);--text-primary:var(--owl-ui-text);--text-muted:var(--owl-ui-muted)} .preview .mc-app{height:calc(100dvh - 102px);min-height:740px;min-width:1120px} .preview-grid{min-width:0} .pane-toggle-btn{top:2px} .preview-grid:not(.dark-expanded):not(.light-expanded) .preview{overflow-x:auto} .app-header h1{font-size:16px} .app-header .subtitle{font-size:11px} .help-banner{line-height:1.7} .theme-light{--owl-ui-canvas:#fafbf9;--owl-ui-panel:#fff;--owl-ui-sidebar:#f1f3ef;--owl-ui-border:#e0e5df;--owl-ui-text:#3d3a32;--owl-ui-muted:#66726a;--owl-ui-hover:#e9eeea} .theme-dark{--owl-ui-canvas:#1c1c1c;--owl-ui-panel:#252525;--owl-ui-sidebar:#161616;--owl-ui-border:#343434;--owl-ui-text:#e8e8e8;--owl-ui-muted:#9b9b9b;--owl-ui-hover:#2a2a2a}`;
const panes = ['light', 'dark'].map(theme => `<div class="preview theme-${theme}" id="preview-${theme}" data-theme="${theme}"><button class="pane-toggle-btn" type="button" data-pane="${theme}" aria-label="展开${theme === 'dark' ? '深色' : '浅色'}画面">${theme === 'dark' ? '◀' : '▶'}</button>${productMarkup}</div>`).join('\n');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owl 模型测评 · 独立小会话原型</title><style>${scaffoldStyle}\n${productStyle}\n${chrome}</style></head><body>${header}<section class="preview-pair" id="preview-pair"><div class="preview-grid">${panes}</div></section></div></div>${overlays}<script>${productScript}</script><script>const PREVIEW_META=${JSON.stringify(meta)};const TOKENS=${JSON.stringify(tokens)};const SECTION_ORDER=[['Owl 配色','appearance'],['阅读字体','reading']];${mechanics}\nif(new URLSearchParams(location.search).get('pane')==='dark')setPaneState('dark-expanded');</script></body></html>`;
const target = join(directory, '2026-10-04-evaluation-mini-chat.html');
await writeFile(target, html);
for (const [index, match] of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries()) await writeFile(join(directory, `inline-check-${index}.js`), match[1]);
console.log(target);
