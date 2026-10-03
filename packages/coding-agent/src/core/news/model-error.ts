/** Classify provider diagnostics without returning URLs, headers, keys or response bodies. */
export function newsModelFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	if (/no api key|missing.*(?:key|credential)|未配置|未选择/i.test(message))
		return "模型或凭据尚未配置，请先在 Owl 模型设置中添加可用模型。";
	if (/\b40[13]\b|unauthorized|forbidden|authentication|invalid.*(?:key|credential)|认证/i.test(message))
		return "模型认证失败，请检查 API Key 和服务权限。";
	if (/\b429\b|quota|rate.?limit|insufficient|余额|额度|限流/i.test(message))
		return "模型额度不足或请求过于频繁，请检查余额和服务限额。";
	if (/\b404\b|model.*(?:not found|does not exist)|模型不存在|not_found/i.test(message))
		return "模型或服务地址不存在，请检查模型 ID 和 API 地址。";
	if (/timeout|timed out|abort|超时|取消/i.test(message)) return "模型请求超时或已取消，请检查网络和服务状态。";
	if (/empty|truncat|invalid.*output|未完成有效回答|输出.*无效/i.test(message))
		return "模型没有返回完整有效的回答，请检查模型配置。";
	return "模型请求未完成，请检查 API 地址、网络和服务状态。";
}
