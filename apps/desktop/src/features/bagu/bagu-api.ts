/**
 * bagu 题库客户端：直连 localhost:8080 的 bagu-system（Spring Boot + H2）。
 * bagu 未启动或跨域失败时降级为内置种子题（与 bagu seed-data.sql 同源），
 * 保证视图始终可用；题头标注连接状态，恢复后可点「重新同步」。
 */
export const BAGU_API_BASE = "http://localhost:8080";

export type BaguCategory = { key: string; name: string; baguId?: number };
export type BaguQuestion = {
	baguId?: number;
	categoryKey: string;
	category?: string;
	title: string;
	content?: string;
	difficulty?: number;
	/** 标准答案：bagu 在线时评分后随 evaluate 返回，离线种子题自带。 */
	answer?: string;
	hint?: string;
	/** 来源标注：bagu 评分（bagu）或本地 agent 评分（agent）。 */
};
export type BaguFeedback = { score: number; prose: string; source: "bagu" | "agent" };

async function baguFetch<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${BAGU_API_BASE}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...init?.headers },
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`bagu HTTP ${response.status}`);
	return await response.json() as T;
}

export async function fetchBaguCategories(): Promise<BaguCategory[]> {
	const raw = await baguFetch<{ id?: number; name?: string }[]>("/api/categories");
	return (raw ?? [])
		.filter((category) => typeof category?.id === "number")
		.map((category) => ({ key: `bagu:${category.id}`, name: category.name || `#${category.id}`, baguId: category.id }));
}

export async function fetchBaguQuestions(categoryId: number): Promise<BaguQuestion[]> {
	const raw = await baguFetch<{ id?: number; title?: string; content?: string; difficulty?: number }[]>(`/api/questions?categoryId=${categoryId}`);
	return (raw ?? [])
		.filter((question) => typeof question?.title === "string" && question.title.trim())
		.map((question) => ({
			baguId: question.id,
			categoryKey: `bagu:${categoryId}`,
			title: question.title!,
			content: question.content,
			difficulty: question.difficulty,
		}));
}

export async function evaluateBagu(questionId: number, userAnswer: string): Promise<{ score?: number; feedback: string; standardAnswer?: string }> {
	const raw = await baguFetch<{ score?: number | null; feedback?: string; standardAnswer?: string }>("/api/quiz/evaluate", {
		method: "POST",
		body: JSON.stringify({ questionId, userAnswer }),
	});
	return {
		score: typeof raw?.score === "number" ? raw.score : undefined,
		feedback: raw?.feedback ?? "",
		standardAnswer: raw?.standardAnswer,
	};
}

/** 题目标准答案（bagu 出题接口不带回答案，展开「参考答案」时按需拉取）。 */
export async function fetchBaguAnswer(questionId: number): Promise<{ standardAnswer?: string }> {
	return await baguFetch<{ standardAnswer?: string }>(`/api/quiz/answer/${questionId}`);
}

/** 从一段评语文案里解析「分数：N」（bagu 离线时 agent 按同样格式作答）。 */
export function extractScore(text: string): number | undefined {
	const match = /(?:分数|得分|score)\s*[:：]?\s*(\d{1,3})/i.exec(text);
	if (!match) return undefined;
	const value = Number(match[1]);
	return value >= 0 && value <= 100 ? value : undefined;
}

/** 去掉评分文案里的「分数：N」行（分数已单独成徽章，不重复上屏）。 */
export function stripScoreLine(text: string): string {
	return text.replace(/^[ \t]*(?:[-*][ \t]*)?(?:\*\*)?(?:分数|得分|score)(?:\*\*)?\s*[:：]?\s*\d{1,3}\s*分?\s*(?:\*\*)?[ \t]*$/im, "").trim();
}

const SEEDS: BaguQuestion[] = [
	{
		categoryKey: "Java基础", category: "Java基础", title: "HashMap 的底层原理是什么？", difficulty: 3,
		answer: "JDK8 采用数组+链表+红黑树：默认容量 16、负载因子 0.75；链表长度 ≥8 且数组容量 ≥64 时转红黑树，≤6 退化链表；扩容为 2 倍并重新散列。",
		hint: "从「数组 + 链表/红黑树、hash 定位、扩容」三条线说，别漏树化的容量前置条件。",
	},
	{
		categoryKey: "MySQL", category: "MySQL", title: "MySQL 为什么用 B+ 树做索引？", difficulty: 3,
		answer: "非叶子节点不存数据、扇出大、树高更低（3 层可存千万级），减少磁盘 IO；叶子节点成有序链表，范围查询友好。",
		hint: "对比 B 树 / 红黑树：扇出、树高、磁盘 IO、范围查询四个角度。",
	},
	{
		categoryKey: "Redis", category: "Redis", title: "Redis 有哪些持久化方式？各有什么优劣？", difficulty: 2,
		answer: "RDB：定时快照，文件小恢复快，可能丢数据；AOF：追加写命令，丢失少，文件大恢复慢；4.x 起混合持久化兼顾两者。",
		hint: "RDB vs AOF：触发方式、数据安全、恢复速度，最后带一句 4.x 混合持久化。",
	},
	{
		categoryKey: "Spring", category: "Spring", title: "Spring Bean 的生命周期是怎样的？", difficulty: 4,
		answer: "实例化 → 属性填充 → Aware 回调 → BeanPostProcessor 前置 → 初始化（@PostConstruct / InitializingBean）→ 后置处理（AOP 代理在这）→ 使用 → 销毁回调。",
		hint: "记主线「实例化 → 属性 → 初始化 → 销毁」，再把 Aware、BeanPostProcessor、AOP 挂上去。",
	},
	{
		categoryKey: "JVM", category: "JVM", title: "JVM 有哪些垃圾回收算法？分别解决什么问题？", difficulty: 3,
		answer: "标记-清除（简单但有碎片）、标记-复制（新生代，空间换时间）、标记-整理（老年代，无碎片）；分代收集按对象生命周期组合使用。",
		hint: "三种基础算法各自的问题，再讲分代为什么有效。",
	},
	{
		categoryKey: "Java基础", category: "Java基础", title: "== 和 equals 的区别？为什么重写 equals 必须重写 hashCode？", difficulty: 2,
		answer: "== 比较引用（基本类型比值）；equals 默认同 ==，重写后比内容；不重写 hashCode 会导致等值对象散列到不同桶，HashMap 中查不到。",
		hint: "先分场景，再讲 hashCode 的约定与 HashMap 的行为。",
	},
];

export function seedCategories(): BaguCategory[] {
	const seen = new Map<string, BaguCategory>();
	for (const question of SEEDS) if (!seen.has(question.categoryKey)) seen.set(question.categoryKey, { key: question.categoryKey, name: question.category ?? question.categoryKey });
	return [...seen.values()];
}

export function seedQuestions(): BaguQuestion[] {
	return SEEDS;
}

/** bagu 离线时的评分兜底提示词（同一格式，方便前端统一解析「分数：N」）。 */
export function baguScorePrompt(scene: string, question: BaguQuestion, answer: string): string {
	return [
		`请以严格但友好的 Java 面试官身份，给下面这道${scene}题目的候选人回答评分。`,
		`题目：${question.title}`,
		`参考答案：${question.answer ?? "（按你的专业判断）"}`,
		"候选人的回答：",
		answer,
		"",
		"第一行必须写「分数：N」（0-100）；之后给出命中点、遗漏点和改进建议，每行一条，不要客套。",
	].join("\n");
}
