/**
 * Key 来源 IP 策略 —— 移植自 manager `apikey/KeyIpPolicy`。
 * 仅接受字面量 IPv4/IPv6 与 CIDR 网段（不做 DNS 解析，杜绝客户端域名借道）。
 * `*` 或空表示不限；`!deny-all` 表示交集为空的哨兵。
 */
import { BusinessError } from "../common/error.ts";

export const DENY_ALL = "!deny-all";

interface Network {
	address: number[];
	bits: number;
	/** 原始规则文本（交集结果保留原文，对齐 Java Network.text）。 */
	text: string;
}

export function unrestricted(value: string | null | undefined): boolean {
	if (value === null || value === undefined || value.trim().length === 0) {
		return true;
	}
	return value
		.trim()
		.split(/[,;\s]+/)
		.includes("*");
}

function parse(raw: string): Network | null {
	if (raw === null || raw.trim().length === 0) {
		return null;
	}
	const parts = raw.trim().split("/");
	if (parts.length > 2) {
		return null;
	}
	const bytes = parseIp(parts[0]!);
	if (bytes === null) {
		return null;
	}
	const bits = parts.length === 2 ? Number.parseInt(parts[1]!, 10) : bytes.length * 8;
	if (Number.isNaN(bits) || bits < 0 || bits > bytes.length * 8) {
		return null;
	}
	return { address: bytes, bits, text: raw.trim() };
}

/** 解析字面量 IP 为字节数组；不支持 DNS 主机名。 */
function parseIp(literal: string): number[] | null {
	if (literal.includes(":")) {
		if (!/^[0-9a-fA-F:.]+$/.test(literal)) {
			return null;
		}
		// IPv6：处理 :: 压缩
		const halves = literal.split("::");
		if (halves.length > 2) {
			return null;
		}
		const head = halves[0] === "" ? [] : halves[0]!.split(":");
		const tail = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
		const missing = 8 - head.length - tail.length;
		if (halves.length === 2 ? missing < 0 : head.length !== 8) {
			return null;
		}
		const groups = [...head, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...tail];
		if (groups.length !== 8) {
			return null;
		}
		const bytes: number[] = [];
		for (const group of groups) {
			if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
				return null;
			}
			const value = Number.parseInt(group, 16);
			bytes.push(Math.floor(value / 256), value % 256);
		}
		return bytes;
	}
	const octets = literal.split(".");
	if (octets.length !== 4) {
		return null;
	}
	const bytes: number[] = [];
	for (const octet of octets) {
		if (!/^[0-9]{1,3}$/.test(octet)) {
			return null;
		}
		const value = Number.parseInt(octet, 10);
		if (value > 255) {
			return null;
		}
		bytes.push(value);
	}
	return bytes;
}

function contains(network: Network, other: Network): boolean {
	if (network.address.length !== other.address.length || network.bits > other.bits) {
		return false;
	}
	for (let index = 0; index < network.address.length; index++) {
		const remaining = network.bits - index * 8;
		if (remaining <= 0) {
			return true;
		}
		const mask = 0xff << (8 - Math.min(8, remaining));
		if ((network.address[index]! & mask) !== (other.address[index]! & mask)) {
			return false;
		}
	}
	return true;
}

function networks(rules: string | null | undefined): Network[] {
	if (rules === null || rules === undefined) {
		return [];
	}
	return rules
		.trim()
		.split(/[,;\s]+/)
		.map((rule) => parse(rule))
		.filter((network): network is Network => network !== null);
}

/** 该来源 IP 是否被规则放行。 */
export function ipAllowed(rules: string | null | undefined, ip: string): boolean {
	if (unrestricted(rules)) {
		return true;
	}
	if (rules === DENY_ALL) {
		return false;
	}
	const address = parse(ip);
	if (address === null) {
		return false;
	}
	return networks(rules).some((rule) => contains(rule, address));
}

/** 校验并规范化规则串；非法抛 member.keyInvalidIps。 */
export function validateIpRules(rules: string | null | undefined): string | null {
	if (rules === null || rules === undefined || rules.trim().length === 0) {
		return null;
	}
	if (rules.length > 500) {
		throw invalidIps();
	}
	const normalized = rules
		.trim()
		.split(/[,;\s]+/)
		.map((rule) => {
			if (rule !== "*" && parse(rule) === null) {
				throw invalidIps();
			}
			return rule;
		});
	return [...new Set(normalized)].join(",");
}

/** 子 Key 请求的规则是否是父规则（天花板）的子集。 */
export function isIpSubset(requested: string | null | undefined, ceiling: string | null | undefined): boolean {
	if (requested === null || requested === undefined || requested.trim().length === 0 || unrestricted(ceiling)) {
		return true;
	}
	if (unrestricted(requested)) {
		return false;
	}
	const parent = networks(ceiling);
	const child = networks(requested);
	return child.length > 0 && child.every((network) => parent.some((rule) => contains(rule, network)));
}

/** 交集；空集返回 DENY_ALL 哨兵。 */
export function intersectIps(child: string | null | undefined, parent: string | null | undefined): string | null {
	if (unrestricted(parent)) {
		return child ?? null;
	}
	if (unrestricted(child)) {
		return parent ?? null;
	}
	const result: string[] = [];
	for (const left of networks(child)) {
		for (const right of networks(parent)) {
			if (contains(left, right)) {
				result.push(right.text);
			} else if (contains(right, left)) {
				result.push(left.text);
			}
		}
	}
	return result.length === 0 ? DENY_ALL : [...new Set(result)].join(",");
}

function invalidIps(): BusinessError {
	return BusinessError.of("member.keyInvalidIps", "来源限制只能填写 IP 地址、CIDR 网段或 *");
}
