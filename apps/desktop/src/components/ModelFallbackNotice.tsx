import type { ModelFallbackNotice as ModelFallbackNoticePayload } from "../bridge/protocol.ts";
import { useT } from "../i18n/index.ts";
import "./model-fallback.css";

export interface ModelFallbackNoticeProps {
	fallback: ModelFallbackNoticePayload;
	/** 点「换一个模型」时的去向：打开设置里的模型页。 */
	onChooseModel?: () => void;
	onDismiss: () => void;
}

/**
 * 会话没能沿用上次的模型、已自动换用其他模型时的内联说明。
 *
 * 以前这条信息只写进桥端日志，用户看到的是「模型怎么变笨了」而不是「模型被换了」。
 * 换厂商（crossProvider）时用警示色，因为跨厂商意味着上下文行为和计费都可能不同。
 */
export function ModelFallbackNotice({
	fallback,
	onChooseModel,
	onDismiss,
}: ModelFallbackNoticeProps): React.JSX.Element {
	const t = useT();
	const saved = `${fallback.saved.provider}/${fallback.saved.id}`;
	const used = `${fallback.used.provider}/${fallback.used.id}`;
	const reason = t(
		fallback.reason === "no-auth" ? "app.modelFallbackReason.no-auth" : "app.modelFallbackReason.model-missing",
	);
	return (
		<p
			className={`owl-model-fallback px-5 py-1.5 text-xs ${fallback.crossProvider ? "owl-model-fallback-warn" : "text-owl-muted"}`}
			role="status"
		>
			<span>{t("app.modelFallback", { saved, used, reason })}</span>
			{onChooseModel && (
				<button type="button" className="owl-model-fallback-action" onClick={onChooseModel}>
					{t("app.modelFallbackPick")}
				</button>
			)}
			<button type="button" className="owl-model-fallback-action" onClick={onDismiss}>
				{t("app.modelFallbackDismiss")}
			</button>
		</p>
	);
}
