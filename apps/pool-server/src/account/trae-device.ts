/**
 * Trae 设备号。账号已保存 deviceId 时原样使用；否则按账号 id 派生稳定的 16 位数字。
 * 查积分和对话必须用同一个号，否则上游会把同一次登录看成两台设备。
 */
import { sha256Hex } from "owl-pool";

export function traeDeviceId(credentials: Record<string, unknown>, identity: string): string {
	const supplied = credentials.deviceId;
	if (typeof supplied === "string" && supplied.length > 0) {
		return supplied;
	}
	// sha256("trae-device:"+id) → [1e15, 1e16)（对齐 Java）
	const hash = sha256Hex(`trae-device:${identity}`);
	const value = (BigInt(`0x${hash}`) % BigInt("9000000000000000")) + BigInt("1000000000000000");
	return value.toString();
}
