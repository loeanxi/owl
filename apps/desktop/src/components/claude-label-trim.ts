/**
 * Claude 的标签尾部修剪。
 *
 * 规格来源：Claude Desktop 打包渲染层 `c05b96c7f-DklIyA-P.js` 的 `Qp()`。
 * 逐字还原如下：
 *
 *   function Qp(e) {
 *     let t = e.length;
 *     for (; t > 0 && /[\s\p{Cf}]/u.test(e[t - 1]);) t--;   // 尾部空白/格式符
 *     let n = t;
 *     for (; n > 0;) {
 *       let t = e[n - 1];
 *       if (t === "\u2026") { n--; continue; }               // 省略号
 *       if (t === ".") {                                    // 句点串
 *         let t = n;
 *         for (; t > 0 && e[t - 1] === ".";) t--;
 *         if (n - t >= 3) { n = t; continue; }              // 三个以上句点整段去掉
 *         break;
 *       }
 *       break;
 *     }
 *     let r = n === t ? e : e.slice(0, n);
 *     return r.trim() === "" ? e : r;                       // 剪空了就原样返回
 *   }
 *
 * 为什么要剪：工具行标题和组标题都是**模型写的**，模型很爱在末尾加
 * 「…」「...」「.」。这些尾巴在单行标题里既占地方又显得没写完，
 * Claude 在渲染前统一剪掉。
 */

/** 尾部要剪掉的字符：空白 + Unicode 格式符（\p{Cf}，零宽连接符/BOM 之类）。 */
const TRAILING_NOISE = /[\s\p{Cf}]/u;

/**
 * 剪掉标签末尾的省略号与句点串。
 *
 * 规则（严格照抄 Claude 的 `Qp`）：
 *  1. 去掉尾部空白与格式符；
 *  2. 末尾是「…」（U+2026）就去掉，继续看新的末尾；
 *  3. 末尾是「.」：连续三个以上的句点整段去掉并继续；一两个句点保留（那是正常句子结尾）。
 *  4. 剪完只剩空白时返回原串（不把标签剪成空）。
 */
export function trimClaudeLabel(text: string): string {
	let end = text.length;
	while (end > 0 && TRAILING_NOISE.test(text[end - 1]!)) end -= 1;

	let cut = end;
	for (; cut > 0; ) {
		const ch = text[cut - 1]!;
		if (ch === "\u2026") {
			cut -= 1;
			continue;
		}
		if (ch === ".") {
			let start = cut;
			while (start > 0 && text[start - 1] === ".") start -= 1;
			// 三个以上句点才算「省略号」，一两个是正常句号。
			if (cut - start >= 3) {
				cut = start;
				continue;
			}
		}
		break;
	}

	const result = text.slice(0, cut);
	return result.trim() === "" ? text : result;
}
