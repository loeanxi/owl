/**
 * 每日定时签到 —— 移植自 manager `schedule/CheckInScheduler`。
 * 业务日（Asia/Shanghai）到达指定时刻后逐号签到，账号间 stagger 隔开，
 * 避免同一时刻集中打上游；到点后自动排下一天。
 */
import { type CheckInService, msUntilBusinessTime, sleep } from "owl-pool";

export interface CheckInSchedulerOptions {
	hour: number;
	minute: number;
	/** 账号间间隔毫秒（manager 默认 3000）。 */
	staggerMs: number;
	logger?: (line: string) => void;
}

export class CheckInScheduler {
	readonly #service: CheckInService;
	readonly #options: CheckInSchedulerOptions;
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;

	constructor(service: CheckInService, options: CheckInSchedulerOptions) {
		this.#service = service;
		this.#options = options;
	}

	start(): void {
		this.#stopped = false;
		this.#scheduleNext();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	#scheduleNext(): void {
		if (this.#stopped) {
			return;
		}
		const delay = msUntilBusinessTime(this.#options.hour, this.#options.minute);
		this.#timer = setTimeout(() => {
			void this.runOnce().finally(() => this.#scheduleNext());
		}, delay);
		this.#timer.unref();
	}

	/** 立即执行一轮全量签到（账号间 stagger）；单号失败不阻断其他号。 */
	async runOnce(): Promise<void> {
		const log = this.#options.logger ?? ((line: string) => console.log(`[checkin-scheduler] ${line}`));
		const accounts = this.#service.listCheckable();
		if (accounts.length === 0) {
			log("没有可签到的账号，跳过本轮");
			return;
		}
		log(`开始定时签到：${accounts.length} 个账号，间隔 ${this.#options.staggerMs}ms`);
		let first = true;
		for (const account of accounts) {
			if (!first) {
				await sleep(this.#options.staggerMs);
			}
			first = false;
			try {
				const outcome = await this.#service.checkInOne(account.id);
				log(`${account.name}: ${outcome.result.status} ${outcome.result.message ?? ""}`);
			} catch (error) {
				log(`${account.name}: 签到失败（${error instanceof Error ? error.message : String(error)}）`);
			}
		}
	}
}
