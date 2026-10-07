/**
 * 渲染错误边界：子树抛错时只坍塌该子树， owl 壳（竖栏/标题栏/对话）永存。
 * 用于嵌入的第三方面板（号池管理台等），避免单面板故障白屏整个桌面。
 */
import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
	/** 面板显示名（错误提示里用）。 */
	label: string;
	children: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
}

export class PanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error): void {
		console.error(`[${this.props.label}] 渲染失败:`, error);
	}

	render(): ReactNode {
		if (this.state.error !== null) {
			return (
				<div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8 }}>
					<p style={{ color: "#c0392b", fontWeight: 600 }}>{this.props.label} 渲染失败</p>
					<p style={{ fontSize: 12, color: "#888", wordBreak: "break-all" }}>{this.state.error.message}</p>
					<button
						type="button"
						style={{ alignSelf: "flex-start" }}
						onClick={() => this.setState({ error: null })}
					>
						重试
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
