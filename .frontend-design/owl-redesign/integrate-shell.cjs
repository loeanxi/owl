const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../..');
const appPath = path.join(root, 'apps/desktop/src/App.tsx');
const original = fs.readFileSync(appPath, 'utf8');
let source = original.replace(/\r\n/g, '\n');
const protectedNodes = source.match(/<(?:ChatStream|Composer|TodoPin)\b[^]*?\/>/g);
if (protectedNodes?.length !== 3) throw new Error('Expected three protected component invocations');
const baseline = { appNodes: protectedNodes, files: {} };
for (const name of ['components/ChatStream.tsx', 'components/Composer.tsx', 'components/TodoPin.tsx', 'hooks/transcript.ts', 'chat-appearance.ts']) {
 baseline.files[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'apps/desktop/src',name))).digest('hex');
}
fs.writeFileSync(path.join(__dirname,'implementation-protected-baseline.json'),JSON.stringify(baseline,null,2));
function replaceOnce(before, after) { if(source.split(before).length !== 2) throw new Error('Ambiguous or missing anchor: '+before.slice(0,85)); source=source.replace(before,after); }
replaceOnce('import { IconCompose, IconList, IconPanelLeft } from "./components/icons.tsx";', 'import { IconList } from "./components/icons.tsx";\nimport { DesktopTitlebar } from "./components/DesktopTitlebar.tsx";\nimport { NewProjectDialog } from "./components/NewProjectDialog.tsx";');
replaceOnce('import { WindowControls } from "./components/WindowControls.tsx";\n','');
replaceOnce('import { notifyAgentStatus } from "./utils/notification.ts";', 'import { notifyAgentStatus } from "./utils/notification.ts";\nimport "./desktop-shell.css";');
replaceOnce('const [showSettings, setShowSettings] = useState(false);','const [showSettings, setShowSettings] = useState(false);\n\tconst [settingsInitialTab, setSettingsInitialTab] = useState<"general" | "about">("general");\n\tconst [showProjectDialog, setShowProjectDialog] = useState(false);');
const opening = String.raw`<div className="owl-desktop-shell font-sans text-owl-text">
			<DesktopTitlebar
				connected={connected}
				sidebarCollapsed={sidebarMinimized || showSettings}
				sidebarToggleRef={sidebarToggleRef}
				onToggleSidebar={() => {
					if (showSettings) setShowSettings(false);
					else toggleSessionSidebar();
				}}
				onNewChat={() => {
					setShowSettings(false);
					setRailView("chat");
					newChat();
				}}
				onOpenProject={() => setShowProjectDialog(true)}
				onOpenSettings={() => {
					setSettingsInitialTab("general");
					setShowSettings(true);
				}}
				onOpenAbout={() => {
					setSettingsInitialTab("about");
					setShowSettings(true);
				}}
				onDockRight={() => togglePanelAt("right")}
				onDockBottom={() => togglePanelAt("bottom")}
			/>
			<div className="owl-desktop-body">`;
replaceOnce('<div className="flex h-screen bg-owl-bg font-sans text-owl-text">',opening);
replaceOnce('onSelect={(view) => setRailView(view)}','settingsOpen={showSettings}\n\t\t\t\tonSelect={(view) => { setShowSettings(false); setRailView(view); }}');
replaceOnce('onOpenSettings={() => setShowSettings(true)}','onOpenSettings={() => { setSettingsInitialTab("general"); setShowSettings(true); }}');
replaceOnce('minimized={sidebarMinimized}','minimized={sidebarMinimized || showSettings}');
replaceOnce('onOpenSession={(id) => void openSession(id)}','onOpenSession={(id) => void openSession(id)}\n\t\t\t\tonOpenSettings={() => { setSettingsInitialTab("general"); setShowSettings(true); }}');
replaceOnce('<div className="flex min-w-0 flex-1 flex-col">','<div className="owl-main-frame">');
const oldHeader=source.match(/\t{4}<header\n[^]*?\t{4}<\/header>/)?.[0];
if(!oldHeader)throw new Error('Session header not found');
const questionDirectory=oldHeader.match(/\{questionCount > 0 && <button[^]*?<\/button>\}/)?.[0];
if(!questionDirectory)throw new Error('Preserve current colleague question-directory trigger');
const header=String.raw`				<header className="owl-chat-header flex shrink-0 select-none items-center" data-tauri-drag-region="deep">
					<h1 className="owl-shell-session-title text-sm font-semibold text-owl-text" title={sessionTitle}>{sessionTitle}</h1>
					<span className="owl-shell-project" title={workspaceDir}>
						<IconFolder size={12} /><span className="owl-shell-project-label">{projectBasename}</span>
					</span>
					<div className="owl-shell-header-actions" data-tauri-drag-region="false">
						<span className={"owl-shell-connection" + (connected ? "" : " is-offline")} role="status" title={connected ? "已连接" : "本地连接不可用"}>
							<span className="owl-shell-connection-dot" />
							{connected ? "本地" : everConnected ? "连接已断开，正在重连…" : "正在连接…"}
						</span>
						__QUESTION_DIRECTORY__
						<button type="button" title="底部工作台" aria-label="底部工作台" aria-pressed={workbenchOpen && workbenchDock === "bottom"} className={headerButtonClass(workbenchOpen && workbenchDock === "bottom")} onClick={() => togglePanelAt("bottom")}><IconPanelBottom size={16} /></button>
						<button type="button" title="右列工作台" aria-label="右列工作台" aria-pressed={workbenchOpen && workbenchDock === "right"} className={headerButtonClass(workbenchOpen && workbenchDock === "right")} onClick={() => togglePanelAt("right")}><IconPanelRight size={16} /></button>
					</div>
				</header>`.replace('__QUESTION_DIRECTORY__',questionDirectory);
replaceOnce(oldHeader,header);
replaceOnce('<div className={`flex min-h-0 flex-1 ${workbenchDock === "right" ? "flex-row" : "flex-col"}`}>','<div className={"owl-shell-content" + (workbenchDock === "bottom" ? " is-bottom" : "")}>');
replaceOnce('<div className="flex min-h-0 min-w-0 flex-1 flex-col">','<div className="owl-shell-conversation">');
const oldSettings=source.match(/\t{3}\{showSettings && \([^]*?\t{3}\)\}/)?.[0];
if(!oldSettings)throw new Error('Settings invocation missing');
replaceOnce(oldSettings+'\n','');
const newSettings=oldSettings.replace('workspaceDir={workspaceDir}','workspaceDir={workspaceDir}\n\t\t\t\t\tinitialTab={settingsInitialTab}');
const project=String.raw`			{showProjectDialog && (
				<NewProjectDialog client={client} onClose={() => setShowProjectDialog(false)} onCreated={(path) => {
					setShowProjectDialog(false);
					setShowSettings(false);
					switchProject(path);
				}} />
			)}
`;
replaceOnce('\t\t\t</div>\n\t\t\t{permission && (',newSettings+'\n\t\t\t</div>\n\t\t\t</div>\n'+project+'\t\t\t{permission && (');
const afterNodes=source.match(/<(?:ChatStream|Composer|TodoPin)\b[^]*?\/>/g);
if(JSON.stringify(protectedNodes)!==JSON.stringify(afterNodes))throw new Error('Protected invocations changed');
if(fs.readFileSync(appPath,'utf8')!==original)throw new Error('Concurrent App change; re-read before applying');
fs.writeFileSync(appPath,source);
console.log('Integrated shell while preserving all three current protected component invocations.');
