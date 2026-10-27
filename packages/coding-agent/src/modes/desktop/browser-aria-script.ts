/**
 * 页面内的 ARIA 语义助手（注入页面执行）。
 *
 * 之前的 role 与名字是启发式的：标签名靠 aria-label / label / value 猜，角色靠标签
 * 猜。这套规则按 HTML-AAM 的隐式角色映射与 accname 的可访问名计算顺序来定：
 * aria-labelledby → aria-label → 原生 label → 内容 → title → placeholder。
 * 自定义控件（只靠 aria-labelledby 命名、role 显式声明的）现在也能被正确读出。
 *
 * 刻意不在页面里取「浏览器自己的 AX 树」：CDP 的 Accessibility.getFullAXTree
 * 只给 backendDOMNodeId，页面里的 JS 拿不到它，要接回 DOM 元素得逐节点
 * resolveNode + callFunctionOn，一个大页面几百次往返。页面内计算一次拿不到，
 * 但规则同源（accname / HTML-AAM），且能和 ref 记账器直接对上——元素照样可操作。
 */

/** 隐式角色映射：显式 role 优先，其次按标签推断；认不出返回空串。 */
export const ARIA_HELPERS = `
	const ariaImplicitRole = (el) => {
		const explicit = (el.getAttribute("role") || "").trim().split(/\\s+/).filter(Boolean)[0];
		if (explicit) return explicit;
		switch (el.tagName) {
			case "A": return el.hasAttribute("href") ? "link" : "";
			case "BUTTON": return "button";
			case "INPUT": {
				const type = (el.getAttribute("type") || "text").toLowerCase();
				if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
				if (type === "checkbox") return "checkbox";
				if (type === "radio") return "radio";
				if (type === "range") return "slider";
				if (type === "number") return "spinbutton";
				if (type === "search") return "searchbox";
				if (type === "hidden") return "";
				return "textbox";
			}
			case "TEXTAREA": return "textbox";
			case "SELECT": return el.multiple || (el.size && el.size > 1) ? "listbox" : "combobox";
			case "OPTION": return "option";
			case "OPTGROUP": return "group";
			case "IMG": return el.getAttribute("alt") === "" ? "presentation" : "img";
			case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
			case "UL": case "OL": return "list";
			case "LI": return "listitem";
			case "DL": return "list";
			case "DT": return "term";
			case "DD": return "definition";
			case "TABLE": return "table";
			case "THEAD": case "TBODY": case "TFOOT": return "rowgroup";
			case "TR": return "row";
			case "TD": return "cell";
			case "TH": return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
			case "NAV": return "navigation";
			case "MAIN": return "main";
			case "HEADER": return "banner";
			case "FOOTER": return "contentinfo";
			case "ASIDE": return "complementary";
			case "FORM": return "form";
			case "SEARCH": return "search";
			case "ARTICLE": return "article";
			case "DIALOG": return "dialog";
			case "FIELDSET": return "group";
			case "DETAILS": return "group";
			case "SUMMARY": return "button";
			case "PROGRESS": return "progressbar";
			case "METER": return "meter";
			case "OUTPUT": return "status";
			default: return "";
		}
	};
	const ariaText = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
	const ariaLabelledByText = (el) => {
		const ids = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
		if (ids.length === 0) return "";
		return ids
			.map((id) => {
				const target = document.getElementById(id);
				return target ? ariaText(target) : "";
			})
			.join(" ")
			.trim();
	};
	const ariaNativeLabel = (el) => {
		if (el.labels && el.labels.length > 0) return Array.from(el.labels).map(ariaText).join(" ").trim();
		const parent = el.closest ? el.closest("label") : null;
		return parent ? ariaText(parent) : "";
	};
	const ariaNameFromContentRoles = new Set([
		"button", "link", "heading", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
		"tab", "treeitem", "cell", "columnheader", "rowheader", "listitem", "term", "definition",
		"switch", "checkbox", "radio",
	]);
	const ariaAccessibleName = (el, role) => {
		const labelled = ariaLabelledByText(el);
		if (labelled) return labelled;
		const label = el.getAttribute("aria-label");
		if (label && label.trim()) return label.trim();
		if (el.tagName === "INPUT") {
			const type = (el.getAttribute("type") || "text").toLowerCase();
			if (type === "button" || type === "submit" || type === "reset") {
				return (el.value || "").trim() || type;
			}
			if (type === "image") return (el.getAttribute("alt") || "").trim();
		}
		if (el.tagName === "IMG") {
			const alt = el.getAttribute("alt");
			if (alt !== null) return alt.trim();
			return (el.getAttribute("title") || "").trim();
		}
		const native = ariaNativeLabel(el);
		if (native) return native;
		if (ariaNameFromContentRoles.has(role)) {
			const content = ariaText(el);
			if (content) return content;
		}
		const title = el.getAttribute("title");
		if (title && title.trim()) return title.trim();
		if (role === "textbox" || role === "combobox" || role === "listbox" || role === "searchbox" || role === "spinbutton" || role === "slider") {
			const placeholder = el.getAttribute("placeholder");
			if (placeholder && placeholder.trim()) return placeholder.trim();
		}
		return "";
	};
	const ariaIsHidden = (el) => {
		if (el.getAttribute("aria-hidden") === "true") return true;
		if (el.hasAttribute("hidden")) return true;
		const style = getComputedStyle(el);
		return style.display === "none" || style.visibility === "hidden";
	};
	const ariaStates = (el, role) => {
		const states = [];
		if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") states.push("disabled");
		if (el.getAttribute("aria-readonly") === "true" || el.hasAttribute("readonly")) states.push("readonly");
		if (el.getAttribute("aria-required") === "true" || el.hasAttribute("required")) states.push("required");
		if (role === "heading") {
			const level = el.getAttribute("aria-level") || (/^H([1-6])$/.test(el.tagName) ? el.tagName[1] : "");
			if (level) states.push("level=" + level);
		}
		if (role === "checkbox" || role === "radio" || role === "switch" || role === "option" || role === "tab") {
			const checked = el.getAttribute("aria-checked");
			if (checked === "true" || checked === "mixed") states.push("checked=" + checked);
			else if (el.checked === true) states.push("checked=true");
			else if (el.checked === false) states.push("checked=false");
		}
		const expanded = el.getAttribute("aria-expanded");
		if (expanded === "true" || expanded === "false") states.push("expanded=" + expanded);
		if (el.getAttribute("aria-selected") === "true") states.push("selected");
		if (el.getAttribute("aria-current")) states.push("current");
		return states;
	};
`;
