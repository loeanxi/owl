import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./theme-roles.css";
import { playStartupSplash } from "./startup-splash.ts";

// 启动动画先挂载，盖在 App 之上；窗口显示后才开始计时，播完自动移除。
playStartupSplash();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
