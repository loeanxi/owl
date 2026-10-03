/* Prototype-only OWL workspace views. Synthetic data; no bridge or filesystem calls. */
(() => {
  const glyph = (name, size = 16) => {
    const paths = {
      folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>',
      file: '<path d="M5 3h9l5 5v13H5Z"/><path d="M14 3v6h5"/>',
      search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
      refresh: '<path d="M20 7a9 9 0 1 0 1 9M20 3v5h-5"/>',
      branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10M18 8v3c0 4-12 1-12 6"/>',
      chevron: '<path d="m9 5 7 7-7 7"/>',
      chevronDown: '<path d="m5 9 7 7 7-7"/>',
      save: '<path d="M4 3h14l3 3v15H3V3Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
      external: '<path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7"/>',
      left: '<path d="m15 5-7 7 7 7"/>',
      right: '<path d="m9 5 7 7-7 7"/>',
      check: '<path d="m4 12 5 5L20 6"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
      terminal: '<path d="m4 5 7 7-7 7M13 19h7"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-6 5 8"/>',
      send: '<path d="M12 21V3M5 10l7-7 7 7"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
      minus: '<path d="M5 12h14"/>',
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;vertical-align:middle" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  };
  const b = (label, action, id, cls = '', iconName = '') => `<button type="button" class="btn ${cls}" data-action="${action}" data-fd-id="${id}">${iconName ? glyph(iconName) : ''}<span data-fd-editable="text">${label}</span></button>`;
  const ib = (label, action, id, iconName) => `<button type="button" class="btn ghost" title="${label}" aria-label="${label}" data-action="${action}" data-fd-id="${id}" style="padding:7px">${glyph(iconName)}</button>`;
  const text = (value, id, cls = '') => `<span class="${cls}" data-fd-id="${id}" data-fd-editable="text">${value}</span>`;
  const edit = (value, placeholder, id) => `<input class="input" value="${value}" placeholder="${placeholder}" data-fd-id="${id}" data-fd-editable="value">`;
  const badge = (value, tone = '', id = '') => `<span class="tag ${tone}" ${id ? `data-fd-id="${id}"` : ''}>${value}</span>`;
  const toolbar = (html, id) => `<div class="pane-toolbar" data-fd-id="${id}" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${html}</div>`;
  const label = (t, desc = '', id = '') => `<div style="padding:16px 0 12px" ${id ? `data-fd-id="${id}"` : ''}><strong data-fd-editable="text">${t}</strong>${desc ? `<div class="muted small" style="margin-top:5px" data-fd-editable="text">${desc}</div>` : ''}</div>`;

  const fileRow = (name, path, depth = 0, type = 'file', status = '', selected = false) => `<button type="button" class="file-row" data-action="${type === 'folder' ? 'file-folder' : path.endsWith('.svg') ? 'pane-image' : 'pane-editor'}" data-fd-id="file-row-${name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}" data-path="${path}" style="width:100%;display:flex;align-items:center;gap:9px;padding:8px 10px 8px ${12 + depth * 18}px;text-align:left;border:0;${selected ? 'background:rgba(47,158,90,.13);color:inherit;border-radius:7px;' : 'background:transparent;color:inherit;'}">${type === 'folder' ? glyph('chevronDown', 12) : '<span style="width:12px"></span>'}<span style="color:${type === 'folder' ? '#d3a35e' : path.endsWith('.tsx') || path.endsWith('.ts') ? '#79a9df' : 'inherit'}">${glyph(type)}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" data-fd-editable="text">${name}</span>${status ? `<span class="small" style="color:${status === 'M' ? '#c8a15c' : '#2f9e5a'};font-weight:600">${status}</span>` : ''}</button>`;

  window.OWL_PANES = {
    files: {
      title: '文件',
      html: () => `<div class="pane-body" data-fd-id="pane-files">
        ${toolbar(`<div style="flex:1;min-width:150px;position:relative">${edit('', '搜索文件名…', 'files-search')}</div>${ib('新建文件夹', 'file-new', 'files-new-folder', 'plus')}${ib('刷新文件', 'files-refresh', 'files-refresh', 'refresh')}`, 'files-toolbar')}
        <div class="small muted" style="display:flex;justify-content:space-between;align-items:center;margin:15px 0 7px" data-fd-id="files-project-heading"><span data-fd-editable="text">OWL-MONO</span>${ib('文件操作', 'file-context', 'files-context-menu', 'more')}</div>
        <div class="file-tree" data-fd-id="files-tree">
          ${fileRow('apps', 'apps', 0, 'folder')}
          ${fileRow('desktop', 'apps/desktop', 1, 'folder')}
          ${fileRow('src', 'apps/desktop/src', 2, 'folder')}
          ${fileRow('App.tsx', 'apps/desktop/src/App.tsx', 3, 'file', 'M', true)}
          ${fileRow('index.css', 'apps/desktop/src/index.css', 3, 'file', 'M')}
          ${fileRow('components', 'apps/desktop/src/components', 3, 'folder')}
          ${fileRow('Composer.tsx', 'apps/desktop/src/components/Composer.tsx', 4)}
          ${fileRow('StartPage.tsx', 'apps/desktop/src/components/StartPage.tsx', 4)}
          ${fileRow('sidebar', 'apps/desktop/src/sidebar', 3, 'folder')}
          ${fileRow('Workbench.tsx', 'apps/desktop/src/sidebar/Workbench.tsx', 4, 'file', 'M')}
          ${fileRow('assets', 'apps/desktop/src/assets', 3, 'folder')}
          ${fileRow('owl-preview.svg', 'apps/desktop/src/assets/owl-preview.svg', 4, 'file', 'U')}
          ${fileRow('packages', 'packages', 0, 'folder')}
          ${fileRow('README.md', 'README.md')}
          ${fileRow('package.json', 'package.json')}
        </div>
        <div class="divider" style="margin:14px 0"></div><div class="small muted" style="display:flex;align-items:center;gap:6px" data-fd-id="files-footer">${glyph('branch', 13)} main <span style="margin-left:auto">4 个变更</span></div>
        <div class="small muted" style="margin-top:12px" data-fd-id="files-actions-hint" data-fd-editable="text">点击文件打开预览，右键可管理文件。</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:12px" data-fd-id="files-context-sample">${b('重命名', 'file-rename', 'file-rename', 'ghost')}${b('复制路径', 'file-copy-path', 'file-copy-path', 'ghost')}${b('在外部打开', 'file-external', 'file-external', 'ghost', 'external')}${b('删除', 'file-delete', 'file-delete', 'ghost danger')}</div>
      </div>`,
    },
    changes: {
      title: '文件变动',
      html: () => `<div class="pane-body" data-fd-id="pane-changes">
        ${toolbar(`<span style="display:flex;gap:7px;align-items:center;flex:1">${glyph('branch')} ${text('main', 'changes-branch')} <span class="small muted">origin/main</span></span>${ib('刷新变更', 'changes-refresh', 'changes-refresh', 'refresh')}`, 'changes-toolbar')}
        <div class="small muted" style="display:flex;justify-content:space-between;align-items:center;margin:16px 0 7px" data-fd-id="changes-staged-heading"><span>已暂存 ${badge('1')}</span>${b('取消暂存', 'unstage', 'changes-unstage-all', 'ghost')}</div>
        <div class="file-row" style="display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:7px;background:rgba(47,158,90,.1)" data-fd-id="changes-staged-row"><span style="color:#2f9e5a;font-weight:600">M</span><span style="flex:1;font-size:12px" data-fd-editable="text">apps/desktop/src/index.css</span>${ib('取消暂存此文件', 'unstage', 'changes-unstage-css', 'minus')}</div>
        <div class="small muted" style="display:flex;justify-content:space-between;align-items:center;margin:15px 0 7px" data-fd-id="changes-working-heading"><span>更改 ${badge('2')}</span>${b('全部暂存', 'stage', 'changes-stage-all', 'ghost')}</div>
        <div class="file-row" style="display:flex;align-items:center;gap:9px;padding:8px 10px" data-fd-id="changes-working-row"><span style="color:#c8a15c;font-weight:600">M</span><button class="btn ghost" data-action="change-diff" style="flex:1;justify-content:flex-start;padding:0;font-size:12px" data-fd-id="changes-app-file">apps/desktop/src/App.tsx</button>${ib('暂存此文件', 'stage', 'changes-stage-app', 'plus')}${ib('丢弃此文件修改', 'discard', 'changes-discard-app', 'refresh')}</div>
        <div class="file-row" style="display:flex;align-items:center;gap:9px;padding:8px 10px" data-fd-id="changes-workbench-row"><span style="color:#c8a15c;font-weight:600">M</span><span class="small" style="flex:1" data-fd-editable="text">sidebar/Workbench.tsx</span>${ib('暂存此文件', 'stage', 'changes-stage-workbench', 'plus')}</div>
        <div class="small muted" style="margin:15px 0 7px" data-fd-id="changes-untracked-heading">未跟踪 ${badge('1')}</div>
        <div class="file-row" style="display:flex;align-items:center;gap:9px;padding:8px 10px" data-fd-id="changes-untracked-row"><span style="color:#2f9e5a;font-weight:600">U</span><span class="small" style="flex:1" data-fd-editable="text">assets/owl-preview.svg</span>${ib('暂存此文件', 'stage', 'changes-stage-image', 'plus')}</div>
        <div class="card" style="margin-top:17px;padding:0;overflow:hidden" data-fd-id="changes-diff-preview">
          <div style="display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid rgba(127,127,127,.17)"><strong class="small">App.tsx</strong>${badge('+3 / −1', 'green')}<span style="flex:1"></span>${ib('展开差异', 'diff-expand', 'changes-expand-diff', 'external')}</div>
          <div class="diff" style="font-size:12px;line-height:1.8;padding:9px 0;font-family:Consolas,monospace" data-fd-id="changes-diff-code">
            <div class="diff-line muted" style="padding:0 11px">38  38  const workspace = useWorkspace();</div>
            <div class="diff-line remove" style="padding:0 11px">39      − &lt;Workbench width={380} /&gt;</div>
            <div class="diff-line add" style="padding:0 11px">    39  + &lt;Workbench</div>
            <div class="diff-line add" style="padding:0 11px">    40  +   dock={workspace.dock}</div>
            <div class="diff-line add" style="padding:0 11px">    41  + /&gt;</div>
            <div class="diff-line muted" style="padding:0 11px">40  42  &lt;/main&gt;</div>
          </div>
        </div>
        <div style="margin-top:18px" data-fd-id="changes-commit-area"><label class="small" style="display:block;margin-bottom:7px" data-fd-id="changes-commit-label" data-fd-editable="text">提交信息</label><textarea class="textarea" rows="2" data-fd-id="changes-commit-message" data-fd-editable="value" placeholder="概括这次改动">feat(desktop): improve workspace layout</textarea><div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:9px"><span class="muted small" data-fd-id="changes-commit-key">Ctrl + Enter</span>${b('提交 1 个已暂存文件', 'commit', 'changes-commit', 'primary', 'check')}</div></div>
      </div>`,
    },
    editor: {
      title: '编辑器',
      html: () => `<div class="pane-body" data-fd-id="pane-editor">
        ${toolbar(`<span class="small muted" style="flex:1;min-width:150px" data-fd-id="editor-path">apps / desktop / src / <strong>App.tsx</strong></span>${badge('未保存', '', 'editor-dirty')}${ib('重新加载', 'editor-reload', 'editor-reload', 'refresh')}${b('保存', 'save', 'editor-save', 'primary', 'save')}`, 'editor-toolbar')}
        <div class="notice" style="display:flex;align-items:flex-start;gap:12px;margin:14px 0;padding:12px;border:1px solid rgba(201,158,82,.3);background:rgba(201,158,82,.08)" data-fd-id="editor-external-change"><div style="flex:1"><strong class="small" data-fd-editable="text">文件在外部被修改</strong><p class="small muted" style="margin:4px 0 0" data-fd-editable="text">重新加载磁盘版本会替换当前未保存的内容。</p></div>${b('重新加载', 'editor-reload', 'editor-stale-reload', 'ghost')}</div>
        <div class="code" style="overflow:auto;min-height:365px;padding:17px 13px;line-height:1.95;font-size:12px;font-family:Consolas,monospace;background:rgba(127,127,127,.035);border-radius:9px" data-fd-id="editor-code-sample">
          <div><span class="muted" style="display:inline-block;width:26px">1</span><span style="color:#af8cc9">import</span> { useState } <span style="color:#af8cc9">from</span> <span style="color:#85b790">"react"</span>;</div>
          <div><span class="muted" style="display:inline-block;width:26px">2</span><span style="color:#af8cc9">import</span> { Workbench } <span style="color:#af8cc9">from</span> <span style="color:#85b790">"./sidebar/Workbench"</span>;</div>
          <div><span class="muted" style="display:inline-block;width:26px">3</span></div>
          <div><span class="muted" style="display:inline-block;width:26px">4</span><span style="color:#af8cc9">export function</span> <span style="color:#79a9df">App</span>() {</div>
          <div><span class="muted" style="display:inline-block;width:26px">5</span>&nbsp; <span style="color:#af8cc9">const</span> [dock, setDock] = <span style="color:#79a9df">useState</span>(<span style="color:#85b790">"right"</span>);</div>
          <div><span class="muted" style="display:inline-block;width:26px">6</span>&nbsp; <span style="color:#af8cc9">const</span> [open, setOpen] = <span style="color:#79a9df">useState</span>(<span style="color:#d3a35e">true</span>);</div>
          <div><span class="muted" style="display:inline-block;width:26px">7</span></div>
          <div><span class="muted" style="display:inline-block;width:26px">8</span>&nbsp; <span style="color:#af8cc9">return</span> (</div>
          <div><span class="muted" style="display:inline-block;width:26px">9</span>&nbsp;&nbsp;&nbsp; &lt;<span style="color:#d3a35e">main</span> className=<span style="color:#85b790">"owl-workspace"</span>&gt;</div>
          <div><span class="muted" style="display:inline-block;width:26px">10</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &lt;<span style="color:#d3a35e">ChatStream</span> entries={entries} /&gt;</div>
          <div style="background:rgba(47,158,90,.08);border-radius:3px"><span class="muted" style="display:inline-block;width:26px">11</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; &lt;<span style="color:#d3a35e">Workbench</span></div>
          <div><span class="muted" style="display:inline-block;width:26px">12</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; dock={dock}</div>
          <div><span class="muted" style="display:inline-block;width:26px">13</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; open={open}</div>
          <div><span class="muted" style="display:inline-block;width:26px">14</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; onSetDock={setDock}</div>
          <div><span class="muted" style="display:inline-block;width:26px">15</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; onSetOpen={setOpen}</div>
          <div><span class="muted" style="display:inline-block;width:26px">16</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; /&gt;</div>
          <div><span class="muted" style="display:inline-block;width:26px">17</span>&nbsp;&nbsp;&nbsp; &lt;/<span style="color:#d3a35e">main</span>&gt;</div>
          <div><span class="muted" style="display:inline-block;width:26px">18</span>&nbsp; );</div>
          <div><span class="muted" style="display:inline-block;width:26px">19</span>}</div>
        </div>
        <div class="small muted" style="display:flex;justify-content:space-between;margin-top:11px" data-fd-id="editor-status"><span>TypeScript React · UTF-8</span><span>第 11 行，第 7 列</span></div>
        <div class="small muted" style="margin-top:15px" data-fd-id="editor-large-file-note" data-fd-editable="text">大于 1 MB 的文件将显示前 1 MB，可在 VS Code 中查看全文。</div>
        <div style="margin-top:8px">${b('在 VS Code 打开', 'file-external', 'editor-open-external', 'ghost', 'external')}</div>
      </div>`,
    },
    terminal: {
      title: '终端',
      html: () => `<div class="pane-body" data-fd-id="pane-terminal">
        ${toolbar(`<span style="flex:1;display:flex;align-items:center;gap:8px">${glyph('terminal')} ${text('PowerShell', 'terminal-shell')} ${badge('运行中', 'green', 'terminal-status')}</span>${ib('新建终端', 'terminal-new', 'terminal-new', 'plus')}`, 'terminal-toolbar')}
        <div class="small muted" style="margin:12px 0" data-fd-id="terminal-directory">D:\\owl\\owl-re-v1\\owl-mono</div>
        <div class="terminal" style="border-radius:10px;background:#161616;color:#dfdfdc;padding:18px 16px;font-family:Consolas,'Cascadia Mono',monospace;font-size:12px;line-height:1.9;min-height:325px;overflow:auto" data-fd-id="terminal-output">
          <div class="terminal-line" style="color:#8c948d">PowerShell 7.5.2</div><div class="terminal-line" style="margin-top:13px"><span style="color:#75b78a">PS D:\\owl\\owl-re-v1\\owl-mono&gt;</span> npm run check</div><div class="terminal-line" style="margin-top:12px;color:#b5b5af">&gt; owl-monorepo@ check</div><div class="terminal-line" style="color:#b5b5af">&gt; biome check . &amp;&amp; tsc --noEmit</div><div class="terminal-line" style="margin-top:13px;color:#75b78a">Checked 812 files in 2.4s.</div><div class="terminal-line" style="color:#b5b5af">No fixes applied.</div><div class="terminal-line" style="margin-top:13px;color:#75b78a">PS D:\\owl\\owl-re-v1\\owl-mono&gt; <span style="display:inline-block;width:7px;height:15px;background:#75b78a;vertical-align:-3px"></span></div>
        </div>
        <div class="small muted" style="margin-top:12px" data-fd-id="terminal-note" data-fd-editable="text">命令在当前项目目录运行。每个终端使用独立的会话。</div>
        <div class="card" style="margin-top:18px;padding:13px;display:flex;justify-content:space-between;align-items:center;gap:12px" data-fd-id="terminal-exited-example"><div><strong class="small">进程已退出</strong><div class="muted small" style="margin-top:4px">退出代码 0</div></div>${b('重新启动', 'terminal-restart', 'terminal-restart', 'ghost', 'refresh')}</div>
      </div>`,
    },
    browser: {
      title: '浏览器',
      html: () => `<div class="pane-body" data-fd-id="pane-browser">
        ${toolbar(`${ib('后退', 'browser-back', 'browser-back', 'left')}${ib('前进', 'browser-forward', 'browser-forward', 'right')}${ib('刷新页面', 'browser-refresh', 'browser-refresh', 'refresh')}<div style="flex:1;min-width:135px">${edit('http://localhost:5188', '输入网址，回车打开', 'browser-url')}</div>${ib('在系统浏览器打开', 'browser-external', 'browser-external', 'external')}`, 'browser-toolbar')}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0" data-fd-id="browser-viewport-toolbar"><span class="muted small">视口</span><select class="select" style="width:auto;font-size:12px" data-fd-id="browser-viewport" data-fd-editable="value"><option>1280 × 860</option><option>1920 × 1080</option><option>768 × 1024</option><option>390 × 844</option></select>${badge('已连接', 'green', 'browser-connected')}<span class="muted small" style="margin-left:auto" data-fd-id="browser-shared-page" data-fd-editable="text">与你的助手同步</span></div>
        <div class="browser-page" style="background:#fafaf7;color:#252725;min-height:310px;border-radius:9px;overflow:hidden;border:1px solid rgba(127,127,127,.24)" data-fd-id="browser-preview-canvas">
          <div style="padding:15px 19px;border-bottom:1px solid #e4e5de;display:flex;align-items:center;gap:8px;font-size:12px"><span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:7px;background:#2f9e5a;color:#fff;font-weight:700">O</span><strong>OWL</strong><span style="margin-left:auto;color:#787b72">文档 &nbsp; 更新 &nbsp; GitHub</span></div>
          <div style="padding:35px 28px 24px"><div style="font-size:10px;letter-spacing:2px;color:#2f9e5a;font-weight:700">YOUR LOCAL AI WORKSPACE</div><h2 style="font-size:25px;letter-spacing:-.7px;line-height:1.4;margin:12px 0 10px;max-width:300px">把想法，<br>推进到可运行的代码。</h2><p style="font-size:12px;line-height:1.8;color:#777b70;max-width:330px;margin:0">在同一个工作区中讨论、编写代码、检查改动，并预览你的项目。</p><div style="display:inline-block;background:#2f9e5a;color:#fff;padding:9px 13px;font-size:11px;border-radius:6px;margin-top:17px">打开你的第一个项目 →</div></div>
          <div style="display:flex;gap:18px;padding:0 28px 23px;font-size:10px;color:#71776a"><span>本地优先</span><span>完整工作台</span><span>开放模型</span></div>
        </div>
        <div class="small muted" style="display:flex;justify-content:space-between;margin-top:9px" data-fd-id="browser-scale"><span>1280 × 860</span><span>适应窗口 · 32%</span></div>
        <div class="notice" style="margin-top:17px;padding:13px;border:1px solid rgba(47,158,90,.28);background:rgba(47,158,90,.06)" data-fd-id="browser-file-picker"><strong class="small" data-fd-editable="text">网页请求选择文件</strong><div class="small muted" style="margin:5px 0 9px" data-fd-id="browser-file-picker-help" data-fd-editable="text">可选择多个文件，用 | 分隔本机文件的完整路径。</div>${edit('D:\\owl\\preview\\screen.png', '本机文件完整路径', 'browser-file-path')}<div style="display:flex;gap:7px;justify-content:flex-end;margin-top:9px">${b('忽略', 'browser-file-dismiss', 'browser-file-dismiss', 'ghost')}${b('提交文件', 'browser-file-submit', 'browser-file-submit', 'primary')}</div></div>
        <div style="margin-top:12px">${b('查看浏览器起始页', 'browser-start', 'browser-start', 'ghost')}</div>
      </div>`,
    },
    tasks: {
      title: '任务管理',
      html: () => `<div class="pane-body" data-fd-id="pane-tasks">
        ${toolbar(`<strong data-fd-id="task-view-title" data-fd-editable="text">执行记录</strong><span style="flex:1"></span>${badge('运行中', 'green', 'tasks-running')}`, 'tasks-toolbar')}
        <div style="display:flex;gap:9px;margin:17px 0" data-fd-id="tasks-summary"><div class="card" style="flex:1;padding:13px"><div class="small muted">对话轮次</div><strong style="display:block;font-size:24px;margin-top:6px">3</strong></div><div class="card" style="flex:1;padding:13px"><div class="small muted">工具调用</div><strong style="display:block;font-size:24px;margin-top:6px">12</strong></div><div class="card" style="flex:1;padding:13px"><div class="small muted">当前状态</div><strong style="display:block;font-size:13px;margin-top:13px;color:#2f9e5a">执行中</strong></div></div>
        <div class="muted small" style="margin-bottom:17px" data-fd-id="tasks-explanation" data-fd-editable="text">查看当前会话的操作与结果，及时了解助手的进展。</div>
        <div class="task-list" data-fd-id="tasks-timeline">
          <div style="display:flex;gap:9px;align-items:center;margin:10px 0 12px" data-fd-id="task-round-3">${badge('第 3 轮')}<span class="small" data-fd-editable="text">调整工作台布局，让文件和终端更好找</span></div>
          <div class="task-item card" style="padding:13px;margin-bottom:8px" data-fd-id="task-read-app"><div style="display:flex;gap:9px;align-items:center"><span style="color:#2f9e5a">${glyph('check', 14)}</span><strong class="small" style="flex:1" data-fd-editable="text">读取 App.tsx 和 Workbench.tsx</strong><span class="small muted">已完成</span></div><div class="muted small" style="margin:7px 0 0 23px">2 个文件 · 已获取页面结构</div></div>
          <div class="task-item card" style="padding:13px;margin-bottom:8px" data-fd-id="task-read-styles"><div style="display:flex;gap:9px;align-items:center"><span style="color:#2f9e5a">${glyph('check', 14)}</span><strong class="small" style="flex:1" data-fd-editable="text">检查样式与主题变量</strong><span class="small muted">已完成</span></div><div class="muted small" style="margin:7px 0 0 23px">index.css · 颜色、字号、间距</div></div>
          <div class="task-item card" style="padding:13px;margin-bottom:8px;border-color:rgba(47,158,90,.4);background:rgba(47,158,90,.05)" data-fd-id="task-check-running"><div style="display:flex;gap:9px;align-items:center"><span style="color:#2f9e5a">${glyph('clock', 14)}</span><strong class="small" style="flex:1" data-fd-editable="text">运行代码检查</strong>${badge('运行中', 'green')}</div><div class="muted small" style="margin:7px 0 0 23px">npm run check</div><div style="margin:9px 0 0 23px">${b('查看输出', 'task-expand', 'tasks-view-output', 'ghost')}</div></div>
          <div class="task-item card" style="padding:13px;margin-bottom:8px" data-fd-id="task-failed-example"><div style="display:flex;gap:9px;align-items:center"><span style="color:#cd7b71">×</span><strong class="small" style="flex:1" data-fd-editable="text">读取不存在的配置文件</strong><span class="small" style="color:#cd7b71">失败</span></div><div class="muted small" style="margin:7px 0 0 23px">ENOENT · 已改为读取项目默认配置</div></div>
          <div class="divider" style="margin:18px 0"></div><div style="display:flex;gap:9px;align-items:center;margin:10px 0 12px" data-fd-id="task-round-2">${badge('第 2 轮')}<span class="small muted" data-fd-editable="text">先了解当前项目的页面构成</span></div><div class="small muted" style="padding-left:5px;line-height:1.8" data-fd-id="task-round-2-summary">已读取 9 个工作台面板，完成页面清单。</div>
        </div>
      </div>`,
    },
    impression: {
      title: '用户印象',
      html: () => `<div class="pane-body" data-fd-id="pane-impression">
        ${toolbar(`<strong data-fd-id="impression-title" data-fd-editable="text">长期记忆</strong><span style="flex:1"></span>${b('保存', 'save', 'impression-save', 'primary', 'save')}`, 'impression-toolbar')}
        ${label('更了解你的工作方式', 'Owl 会记录值得长期记住的偏好。你也可以直接修改。', 'impression-introduction')}
        <textarea class="textarea" style="min-height:345px;line-height:1.85;padding:15px;resize:vertical" data-fd-id="impression-content" data-fd-editable="value" spellcheck="false">## 工作环境
主要使用 Windows 和 PowerShell，日常开发 Java 与 TypeScript 项目。

## 沟通偏好
先说结论，再说明原因。涉及页面改动时，先看原型并确认方向。

## 开发习惯
定位问题后再修复；保留与当前任务无关的改动；完成后提供验证结果。

## 当前项目
OWL 是本地 AI 编程工作区，包含对话、文件、终端与浏览器。</textarea>
        <div class="small muted" style="display:flex;align-items:center;gap:8px;margin-top:13px" data-fd-id="impression-effect">${glyph('clock', 13)}<span data-fd-editable="text">保存后的内容将在新会话中生效。</span></div>
        <div class="notice" style="margin-top:19px;padding:13px;line-height:1.7" data-fd-id="impression-tip"><strong class="small" data-fd-editable="text">把偏好留在这里</strong><p class="small muted" style="margin:5px 0 0" data-fd-editable="text">适合保存工作习惯、技术偏好和长期背景。具体任务的临时要求，可以直接写在对话里。</p></div>
      </div>`,
    },
    sidechat: {
      title: '侧边对话',
      html: () => `<div class="pane-body" data-fd-id="pane-sidechat" style="display:flex;flex-direction:column;min-height:100%">
        ${toolbar(`<strong data-fd-id="sidechat-title" data-fd-editable="text">侧边对话</strong>${badge('Beta')}<span style="flex:1"></span>${b('新对话', 'sidechat-new', 'sidechat-new', 'ghost', 'plus')}`, 'sidechat-toolbar')}
        <div class="small muted" style="padding:12px 0;border-bottom:1px solid rgba(127,127,127,.18)" data-fd-id="sidechat-introduction" data-fd-editable="text">顺手讨论一个小问题，与主对话分别保存。</div>
        <div style="flex:1;display:flex;flex-direction:column;gap:22px;padding:22px 0;min-height:290px" data-fd-id="sidechat-transcript"><div class="chat-message" style="align-self:flex-end;max-width:88%;padding:12px 14px;background:rgba(127,127,127,.12);border-radius:13px 13px 4px 13px;line-height:1.7;font-size:13px" data-fd-id="sidechat-user" data-fd-editable="text">这里的 Workbench 为什么要保留挂载？</div><div class="chat-message" style="font-size:13px;line-height:1.85" data-fd-id="sidechat-assistant"><div class="small muted" style="display:flex;gap:6px;align-items:center;margin-bottom:11px">${glyph('check', 12)} 已读取 Workbench.tsx</div><p style="margin:0 0 10px" data-fd-editable="text">因为每个标签里可能有正在进行的工作，例如未保存的编辑内容和运行中的终端。</p><p style="margin:0" data-fd-editable="text">切换标签时只隐藏面板，就能保留这些状态。回到原标签时，你可以接着刚才的位置继续。</p><div class="code" style="font-size:12px;padding:12px;margin-top:13px;border-radius:7px;background:rgba(127,127,127,.07);font-family:Consolas,monospace">className={isActive ? "" : "hidden"}</div></div></div>
        <div data-fd-id="sidechat-composer" style="margin-top:auto;border-top:1px solid rgba(127,127,127,.18);padding-top:14px"><textarea class="textarea" rows="2" data-fd-id="sidechat-draft" data-fd-editable="value" placeholder="问一个小问题…"></textarea><div style="display:flex;align-items:center;gap:10px;margin-top:9px"><span class="muted small" style="flex:1" data-fd-id="sidechat-shortcut">Enter 发送 · Shift + Enter 换行</span>${ib('停止回复', 'sidechat-stop', 'sidechat-stop', 'stop')}${b('发送', 'sidechat-send', 'sidechat-send', 'primary', 'send')}</div></div>
      </div>`,
    },
    image: {
      title: '图片',
      html: () => `<div class="pane-body" data-fd-id="pane-image">
        ${toolbar(`<span class="small muted" style="flex:1;min-width:180px" data-fd-id="image-path">assets / <strong>owl-preview.svg</strong></span>${badge('SVG')}`, 'image-toolbar')}
        <div style="display:flex;align-items:center;justify-content:center;min-height:380px;margin:16px 0;border-radius:10px;background:repeating-conic-gradient(rgba(127,127,127,.10) 0% 25%,rgba(127,127,127,.025) 0% 50%) 50% / 16px 16px;overflow:hidden;padding:22px" data-fd-id="image-preview-canvas">
          <svg viewBox="0 0 360 300" role="img" aria-label="示例 OWL 品牌插图" style="max-width:100%;max-height:320px;display:block" data-fd-id="image-preview-illustration"><rect x="16" y="13" width="328" height="274" rx="24" fill="#e9f0e7"/><circle cx="264" cy="80" r="29" fill="#d0dfcc"/><path d="M16 219C88 170 117 225 181 205S277 145 344 195V263a24 24 0 0 1-24 24H40a24 24 0 0 1-24-24Z" fill="#c1d5bc"/><path d="M104 115 111 70l44 23h50l44-23 7 45v69c0 42-32 68-76 68s-76-26-76-68Z" fill="#2f9e5a"/><path d="M113 132c0-25 29-36 48-19l19 18 19-18c19-17 48-6 48 19v29c0 23-17 39-39 39-14 0-24-5-28-15-4 10-14 15-28 15-22 0-39-16-39-39Z" fill="#edf2e6"/><circle cx="149" cy="150" r="14" fill="#313b30"/><circle cx="211" cy="150" r="14" fill="#313b30"/><circle cx="153" cy="146" r="4" fill="#fff"/><circle cx="215" cy="146" r="4" fill="#fff"/><path d="m171 166 9 13 9-13Z" fill="#d3a35e"/><path d="M150 225h60M160 235h40" stroke="#79b489" stroke-width="5" stroke-linecap="round"/><text x="42" y="53" fill="#3d503a" font-family="Segoe UI, sans-serif" font-size="12" letter-spacing="3">OWL WORKSPACE</text></svg>
        </div>
        <div style="display:flex;align-items:center;justify-content:center;gap:10px" data-fd-id="image-zoom-controls">${ib('缩小', 'image-zoom-out', 'image-zoom-out', 'minus')}<span class="small" style="min-width:45px;text-align:center" data-fd-id="image-zoom-value">100%</span>${ib('放大', 'image-zoom', 'image-zoom-in', 'plus')}${b('适应窗口', 'image-fit', 'image-fit', 'ghost')}</div>
        <div class="small muted" style="text-align:center;margin-top:17px" data-fd-id="image-footer" data-fd-editable="text">360 × 300 · 透明背景</div>
      </div>`,
    },
  };
})();
