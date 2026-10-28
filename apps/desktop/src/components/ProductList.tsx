/**
 * 产物列表。
 *
 * 形态对着 Claude Desktop 的 artifact 列表：一张表，文件与可视化产物混排，
 * 每条一个类型徽标 + 标题 + 副标题 + 打开动作。
 *
 *   产物 (3)
 *   ▢ 费用明细.xlsx   表格 · 新建   ›
 *   ▢ 月度趋势         图表         ›
 *   ▢ src/report.ts   代码 · 修改   ›
 */

import type { BridgeClient } from "../bridge/client.ts";
import type { ArtifactKind } from "../hooks/artifacts.ts";
import type { Product, ProductKind } from "../hooks/products.ts";
import { type TextKey, useT } from "../i18n/index.ts";
import { ArtifactActions } from "./ArtifactActions.tsx";
import { IconChevron } from "./icons.tsx";
import "./products.css";

const FILE_KIND_LABEL: Record<ArtifactKind, TextKey> = {
	document: "artifacts.kindDocument",
	sheet: "artifacts.kindSheet",
	presentation: "artifacts.kindPresentation",
	image: "artifacts.kindImage",
	code: "artifacts.kindCode",
	file: "artifacts.kindFile",
};

const VISUAL_KIND_LABEL: Record<Exclude<ProductKind, "file">, TextKey> = {
	chart: "products.kindChart",
	table: "products.kindTable",
	code: "products.kindCode",
	view: "products.kindView",
};

const ACTION_LABEL: Record<NonNullable<Product["action"]>, TextKey> = {
	written: "artifacts.written",
	edited: "artifacts.edited",
	opened: "artifacts.opened",
};

/**
 * 定位可视化产物在对话流里的位置。
 *
 * 可视化产物就渲染在那次工具调用下面（`data-tool-id`），清单的作用是
 * 让你不用滚回去找 —— 点一下就滚过去并闪一下。
 */
function locateToolCard(toolId: string): void {
	const selector = `[data-tool-id="${CSS.escape(toolId)}"]`;
	const node = document.querySelector(selector);
	if (!(node instanceof HTMLElement)) return;
	node.scrollIntoView({ behavior: "smooth", block: "center" });
	node.classList.add("is-product-located");
	window.setTimeout(() => node.classList.remove("is-product-located"), 1400);
}

export interface ProductListProps {
	products: readonly Product[];
	/** 打开文件产物（走侧栏工作台）。 */
	onOpenFile?: (path: string) => void | Promise<void>;
	/**
	 * 在工作台里打开产物页（产物页内可以接着聊这件产物）。
	 *
	 * 传了就以它为准 —— Claude 点产物是开产物页，不是直接跳到文件预览。
	 */
	onOpenProduct?: (product: Product) => void;
	/** 定位可视化产物在对话流里的位置（缺省：滚过去并闪一下）。 */
	onLocate?: (toolId: string) => void;
	client?: BridgeClient;
	cwd?: string;
	title?: string;
}

/** 一条产物的类型徽标文案。 */
export function productKindText(product: Product, t: (key: TextKey) => string): string {
	if (product.kind === "file") {
		return product.fileKind === undefined ? t("artifacts.kindFile") : t(FILE_KIND_LABEL[product.fileKind]);
	}
	return t(VISUAL_KIND_LABEL[product.kind]);
}

/** 一条产物的副标题：文件是工作区路径，可视化没有副标题（类型徽标已经说了形态）。 */
function productSubtitle(product: Product): string {
	return product.kind === "file" ? (product.subtitle ?? "") : "";
}

/**
 * 产物清单。
 *
 * 传了 `onOpenProduct` 就点开产物页（侧栏工作台里那一页，页内还能接着聊）；
 * 不传时退回旧行为：文件产物点开进工作台的文件预览，可视化产物点开定位回
 * 对话流里那张卡（它本来就渲染在那儿，清单的作用是让你不用滚回去找）。
 */
export function ProductList({
	products,
	onOpenFile,
	onOpenProduct,
	onLocate,
	client,
	cwd,
	title,
}: ProductListProps): React.JSX.Element | null {
	const t = useT();
	if (products.length === 0) return null;
	const heading = title ?? t("products.title");
	const locate = onLocate ?? locateToolCard;
	return (
		<section className="owl-products" aria-label={heading}>
			<header className="owl-products-heading">
				<strong>{heading}</strong>
				<span>{t("products.count", { n: products.length })}</span>
			</header>
			<ul className="owl-products-list">
				{products.map((product) => {
					const label = productKindText(product, t);
					const subtitle = productSubtitle(product);
					const action = product.action === undefined ? undefined : t(ACTION_LABEL[product.action]);
					const body = (
						<>
							<span className="owl-product-kind" data-kind={product.kind}>
								{label}
							</span>
							<span className="owl-product-description">
								<strong>{product.title}</strong>
								{subtitle !== "" && <span>{subtitle}</span>}
							</span>
							{action !== undefined && <span className="owl-product-action">{action}</span>}
							<IconChevron className="owl-product-chevron" />
						</>
					);
					// 产物页优先：点产物就是打开它并在页内追问，不是跳去文件预览。
					if (onOpenProduct !== undefined) {
						const openPage = (): void => onOpenProduct(product);
						return (
							<li key={product.id} className="owl-product-row" data-kind={product.kind}>
								{product.kind === "file" && product.path !== undefined ? (
									// 文件产物仍挂着次级动作（在文件夹中显示 / 复制绝对路径）。
									<ArtifactActions
										path={product.path}
										title={product.title}
										client={client}
										cwd={cwd}
										onOpenFile={onOpenFile}
									>
										{() => (
											<button
												type="button"
												className="owl-product-button"
												aria-label={t("products.openAria", { name: product.title })}
												title={t("products.openPage")}
												onClick={openPage}
											>
												{body}
											</button>
										)}
									</ArtifactActions>
								) : (
									<button
										type="button"
										className="owl-product-button"
										aria-label={t("products.openAria", { name: product.title })}
										title={t("products.openPage")}
										onClick={openPage}
									>
										{body}
									</button>
								)}
							</li>
						);
					}
					if (product.kind !== "file" || product.path === undefined) {
						return (
							<li key={product.id} className="owl-product-row" data-kind={product.kind}>
								<button
									type="button"
									className="owl-product-button"
									aria-label={t("products.locateAria", { name: product.title })}
									title={t("products.locate")}
									onClick={() => locate(product.toolId)}
								>
									{body}
								</button>
							</li>
						);
					}
					return (
						<li key={product.id} className="owl-product-row" data-kind={product.kind}>
							{onOpenFile === undefined ? (
								<span className="owl-product-button owl-product-button-static">{body}</span>
							) : (
								<ArtifactActions
									path={product.path}
									title={product.title}
									client={client}
									cwd={cwd}
									onOpenFile={onOpenFile}
								>
									{(open, disabled) => (
										<button
											type="button"
											className="owl-product-button"
											aria-label={t("artifacts.openAria", { name: product.title })}
											title={product.path}
											disabled={disabled}
											onClick={open}
										>
											{body}
										</button>
									)}
								</ArtifactActions>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
