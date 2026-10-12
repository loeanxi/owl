/** 核心写进用户消息、只给模型看的包装：开头的附件清单与结尾的图片处理提示。 */
export type ParsedUserMessage = {
	/** 用户实际输入的正文。 */
	body: string;
	/** `@` 文件芯片随本轮附带的路径。 */
	attachedPaths: string[];
	/** 附图没能送达模型的提示（转换/压缩失败）。 */
	omittedImages: number;
};

const ATTACHMENTS_HEADER = /^\[Attached files for this turn\]\n((?:- [^\n]*\n)*)\n/;
const IMAGE_HINT = /^\[Image(?::| converted | omitted:)[^\n]*\]$/;

export function parseUserMessage(text: string): ParsedUserMessage {
	let rest = text;
	const attachedPaths: string[] = [];
	const header = ATTACHMENTS_HEADER.exec(rest);
	if (header) {
		for (const line of header[1]!.split("\n")) {
			if (line.startsWith("- ")) attachedPaths.push(line.slice(2));
		}
		rest = rest.slice(header[0].length);
	}
	let omittedImages = 0;
	const lines = rest.split("\n");
	let end = lines.length;
	while (end > 0 && IMAGE_HINT.test(lines[end - 1]!)) end--;
	// 提示与正文之间固定隔一个空行；没有空行的同形文字是用户自己写的。
	if (end < lines.length && (end === 0 || lines[end - 1] === "")) {
		omittedImages = lines.slice(end).filter((line) => line.startsWith("[Image omitted:")).length;
		rest = lines.slice(0, Math.max(0, end - 1)).join("\n");
	}
	return { body: rest, attachedPaths, omittedImages };
}
