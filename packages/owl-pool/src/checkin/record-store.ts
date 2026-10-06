/**
 * 签到记录存储 SPI + 内存实现 —— 对齐 manager `CheckInRecordRepository`。
 */
import type { CheckInRecord } from "./types.ts";

export interface CheckInRecordStore {
	save(record: CheckInRecord): void;
	/** 按时间倒序取最近 N 条（对齐 findTop50ByOrderByOccurredAtDesc）。 */
	recent(limit: number): CheckInRecord[];
	findById(id: string): CheckInRecord | undefined;
	delete(id: string): void;
	clear(): void;
}

export class InMemoryCheckInRecordStore implements CheckInRecordStore {
	readonly #records = new Map<string, CheckInRecord>();

	save(record: CheckInRecord): void {
		this.#records.set(record.id, { ...record });
	}

	recent(limit: number): CheckInRecord[] {
		return [...this.#records.values()].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limit);
	}

	findById(id: string): CheckInRecord | undefined {
		const found = this.#records.get(id);
		return found ? { ...found } : undefined;
	}

	delete(id: string): void {
		this.#records.delete(id);
	}

	clear(): void {
		this.#records.clear();
	}
}
