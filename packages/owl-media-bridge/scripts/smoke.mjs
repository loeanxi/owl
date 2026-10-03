/**
 * node half 冒烟脚本：用 jiti 加载扩展入口（owl 扩展加载器的真实路径），验证
 *  1. TS 扩展可被 jiti 加载，工厂正常跑完；
 *  2. 4 个模型工具注册成功；
 *  3. 同源 HTTP 处理器注入核心通道单例（@owl/owl-coding-agent 别名共享实例）；
 *  4. 处理器对非媒体路径返回 false、对 status 路径走完整信封。
 * 用法：node scripts/smoke.mjs
 */
import { createJiti } from "jiti";
import { getMediaBridgeHttpHandler, setMediaBridgeHttpHandler } from "@owl/owl-coding-agent";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("../index.ts");

const registered = [];
const pi = {
	registerTool: (tool) => registered.push(tool.name),
	on: () => {},
};
await mod.default(pi);

console.log("registered tools:", registered.join(", "));
if (registered.join(",") !== "media_bridge_status,media_bridge_control,media_bridge_memory,media_bridge_explain_status") {
	console.error("FAIL: unexpected tool set");
	process.exit(1);
}

const handler = getMediaBridgeHttpHandler();
if (handler === undefined) {
	console.error("FAIL: media bridge http handler not injected into the channel singleton");
	process.exit(1);
}

// 非媒体路径必须放行（返回 false），媒体路径必须有应答。
const passthrough = await handler({ url: "/", method: "GET", headers: {} }, stubResponse(), {});
if (passthrough !== false) {
	console.error("FAIL: handler claimed a non-media path");
	process.exit(1);
}

const res = stubResponse();
const answered = await handler(
	{
		url: "/media-bridge/api/status",
		method: "POST",
		headers: { host: "127.0.0.1:18901", origin: "http://127.0.0.1:18901" },
		async *[Symbol.asyncIterator]() {
			yield "{}";
		},
	},
	res,
	{ authorizeOrigin: () => true },
);
if (!answered || res.statusCode !== 200) {
	console.error(`FAIL: status route answered=${answered} status=${res.statusCode}`);
	process.exit(1);
}
const payload = JSON.parse(res.body);
console.log("status route ok:", payload.ok, "| state:", payload.value.state);
console.log("SMOKE PASS");

function stubResponse() {
	return {
		statusCode: 0,
		writeHead(status) {
			this.statusCode = status;
		},
		end(body = "") {
			this.body = body;
		},
	};
}

// 收尾：把处理器摘掉，避免污染同进程的其他用例。
setMediaBridgeHttpHandler(undefined);
