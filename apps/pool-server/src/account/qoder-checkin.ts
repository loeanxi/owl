import {
	type Account,
	type CheckInProvider,
	type CheckInResult,
	checkInAlready,
	checkInAuthError,
	checkInFailed,
	checkInInactive,
	checkInSuccess,
	describeUpstreamError,
	GatewayFault,
	type Platform,
	parseCredentials,
} from "owl-pool";

/** 通过既有 SDK 桥领取 Qoder CN 活动权益；仅 PAT 配置参与自动/批量签到。 */
export class QoderCheckInProvider implements CheckInProvider {
	readonly #checkIn: (account: Account) => Promise<Record<string, unknown>>;

	constructor(checkIn: (account: Account) => Promise<Record<string, unknown>>) {
		this.#checkIn = checkIn;
	}

	supports(): Platform {
		return "QODER";
	}

	isConfigured(account: Account): boolean {
		const credentials = parseCredentials(account);
		// 与 bridge/protocol.mjs 的 initialize 选择顺序一致，账号 home 登录不能替代签到 PAT。
		const chatToken =
			credentials.QODERCN_PERSONAL_ACCESS_TOKEN ??
			["accessToken", "personalAccessToken", "authToken", "apiKey", "token"]
				.map((key) => credentials[key])
				.find((value) => value !== undefined);
		if (chatToken !== undefined && (typeof chatToken !== "string" || chatToken.trim().length === 0)) {
			return false;
		}
		const token = credentials.checkinToken ?? chatToken;
		return typeof token === "string" && token.trim().length > 0;
	}

	async checkIn(account: Account): Promise<CheckInResult> {
		if (!this.isConfigured(account)) {
			return checkInInactive("未设置 Qoder CN 签到 PAT，无法领取活动权益");
		}
		try {
			const result = await this.#checkIn(account);
			const message = typeof result.message === "string" ? result.message : null;
			const credits = typeof result.credits === "number" && Number.isFinite(result.credits) ? result.credits : null;
			switch (result.status) {
				case "SUCCESS":
					return checkInSuccess(message ?? "Qoder CN 活动权益领取成功", credits);
				case "ALREADY":
					return checkInAlready(message ?? "今日活动权益已领取", credits);
				case "INACTIVE":
					return checkInInactive(message ?? "今日暂无可领取的 Qoder CN 活动权益");
				case "AUTH_ERROR":
					return checkInAuthError(message ?? "Qoder CN 签到 PAT 无效或已过期");
				default:
					return checkInFailed(message ?? "Qoder CN 未确认活动权益领取成功", null);
			}
		} catch (error) {
			return error instanceof GatewayFault && error.code === "upstream_auth_required"
				? checkInAuthError("Qoder CN 签到 PAT 无效或已过期")
				: checkInFailed(`Qoder CN 签到失败: ${describeUpstreamError(error)}`, null);
		}
	}
}
