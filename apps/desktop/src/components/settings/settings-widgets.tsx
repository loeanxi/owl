import { useEffect, useState } from "react";
import { t } from "../../i18n/index.ts";
import { normalizeHexColor } from "../../owl-appearance.ts";
import { weColorToHex, weHexToColor, type WallpaperPropDef } from "../../we-props.ts";

/** 设置侧栏导航项 */
export function NavItem({
	icon,
	label,
	active,
	onClick,
}: {
	icon: React.ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
}): React.JSX.Element {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={`owl-settings-nav-item ${active ? "is-active" : ""}`}
		>
			{icon}
			{label}
		</button>
	);
}

/** 设置分区标题 + 描述（对齐 Claude/ChatGPT 设置页的版式） */
export function SectionHeader({ title, desc }: { title: string; desc?: string }): React.JSX.Element {
	return (
		<div className="owl-settings-heading">
			<h2>{title}</h2>
			{desc && <p>{desc}</p>}
		</div>
	);
}

/** 设置行：左侧标题/说明，右侧控件；长路径类设置可传 children 全宽铺开 */
export function SettingRow({
	title,
	desc,
	control,
	children,
}: {
	title: string;
	desc?: string;
	control?: React.ReactNode;
	children?: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="owl-settings-row">
			<div className="owl-settings-row-heading">
				<div className="min-w-0">
					<div className="owl-settings-row-title">{title}</div>
					{desc && <div className="owl-settings-row-description">{desc}</div>}
				</div>
				{control && <div className="owl-settings-row-control">{control}</div>}
			</div>
			{children && <div className="owl-settings-row-body">{children}</div>}
		</div>
	);
}

/**
 * 壁纸属性面板的单行控件（移植上游 picker-props-panel 的控件映射）：
 * text/group = 分节标题；bool/ color / slider / combo / textinput / file 各按类型渲染。
 * condition 显隐已在调用方过滤；「已改」用圆点标记，改回默认值自动清除覆盖。
 */
export function WallpaperPropRow({
	prop,
	disabled,
	onInput,
	onReset,
}: {
	prop: WallpaperPropDef;
	disabled: boolean;
	onInput: (value: unknown) => void;
	onReset: () => void;
}) {
	const inputClass = "rounded-lg border border-owl-border bg-owl-sidebar px-2 py-1.5 text-xs text-owl-text outline-none focus:border-owl-accent";
	// 静态说明 / 分节标题
	if (prop.ptype === "text" || prop.ptype === "group") {
		return (
			<div className="owl-wallpaper-prop is-heading">
				<span>{prop.text}</span>
			</div>
		);
	}
	const changed = prop.overridden;
	return (
		<div className="owl-settings-row is-tight owl-wallpaper-prop">
			<div className="owl-settings-row-heading">
				<div className="min-w-0">
					<div className="owl-settings-row-title">
						{prop.text}
						{changed && <i className="owl-wallpaper-prop-dot" title={t("settings.appearance.wallpaperPropChanged")} />}
					</div>
				</div>
				{changed && (
					<div className="owl-settings-row-control">
						<button
							type="button"
							className="owl-settings-button"
							disabled={disabled}
							onClick={onReset}
						>
							{t("settings.appearance.wallpaperPropReset")}
						</button>
					</div>
				)}
			</div>
			<div className="owl-settings-row-body">
				{prop.ptype === "bool" && (
					<Switch
						title={prop.text}
						checked={prop.value === true}
						disabled={disabled}
						onChange={(checked) => onInput(checked)}
					/>
				)}
				{prop.ptype === "color" && (
					<div className="owl-settings-colorfield">
						<input
							type="color"
							aria-label={prop.text}
							className="owl-settings-colorfield-swatch"
							disabled={disabled}
							value={weColorToHex(prop.value)}
							onChange={(event) => onInput(weHexToColor(event.currentTarget.value))}
						/>
						<code className="owl-settings-accent-hex">{weColorToHex(prop.value)}</code>
					</div>
				)}
				{prop.ptype === "slider" && (
					<div>
						<div className="mb-1 text-right text-xs tabular-nums text-owl-text">
							{Number(prop.value ?? 0).toFixed(prop.precision ?? 0)}
						</div>
						<input
							type="range"
							aria-label={prop.text}
							className="w-full accent-owl-accent disabled:opacity-40"
							min={prop.min ?? 0}
							max={prop.max ?? 1}
							step={prop.step ?? (prop.max ?? 1) - (prop.min ?? 0) > 0 ? ((prop.max ?? 1) - (prop.min ?? 0)) / 100 : 0.01}
							value={Number(prop.value ?? 0)}
							disabled={disabled}
							onChange={(event) => onInput(event.currentTarget.valueAsNumber)}
						/>
					</div>
				)}
				{prop.ptype === "combo" && prop.options && (
					<select
						aria-label={prop.text}
						className={inputClass}
						value={String(prop.options.findIndex((o) => o.value === prop.value))}
						disabled={disabled}
						onChange={(event) => {
							// 用下标当 value，回写取回声明 JSON 类型（整数/字符串/布尔混用）
							const option = prop.options?.[Number(event.target.value)];
							if (option) onInput(option.value);
						}}
					>
						{prop.options.map((option, index) => (
							<option key={index} value={String(index)}>{option.label}</option>
						))}
					</select>
				)}
				{(prop.ptype === "textinput" || prop.ptype === "other" || prop.ptype === "file" || prop.ptype === "directory") && (
					<input
						type="text"
						aria-label={prop.text}
						className={`${inputClass} w-full`}
						value={typeof prop.value === "string" ? prop.value : prop.value === null ? "" : JSON.stringify(prop.value)}
						disabled={disabled}
						onChange={(event) => onInput(event.currentTarget.value)}
					/>
				)}
			</div>
		</div>
	);
}

/** 开关（DSH 设置页同款胶囊样式；用按钮自绘，不依赖原生 checkbox 外观）。 */
export function Switch({
	checked,
	onChange,
	disabled,
	title,}: {
	checked: boolean;
	onChange: (next: boolean) => void;
	disabled?: boolean;
	title?: string;
}): React.JSX.Element {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			title={title}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-default disabled:opacity-40 ${
				checked ? "bg-owl-accent" : "bg-owl-border"
			}`}
		>
			<span
				className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-150 ${
					checked ? "left-[18px]" : "left-0.5"
				}`}
			/>
		</button>
	);
}

/**
 * 颜色字段：圆形拾色器 + hex 输入 + 「默认」清除。
 * value 为空串 = 跟随主题默认（此时展示 fallback 色并隐藏清除按钮）。
 * hex 手输在不完整时不提交，合法即提交；失焦回显最后一次提交值。
 */
export function ColorField({
	value,
	fallback,
	disabled,
	ariaLabel,
	resetLabel,
	onChange,
}: {
	value: string;
	fallback: string;
	disabled?: boolean;
	ariaLabel: string;
	resetLabel: string;
	onChange: (hex: string) => void;
}): React.JSX.Element {
	const [text, setText] = useState(value);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (!editing) setText(value || fallback);
	}, [value, fallback, editing]);
	const commit = (raw: string) => {
		setText(raw);
		const hex = normalizeHexColor(raw);
		if (hex) onChange(hex);
	};
	return (
		<div className="owl-settings-colorfield">
			<input
				type="color"
				aria-label={ariaLabel}
				disabled={disabled}
				value={value || fallback}
				onChange={(event) => {
					const hex = event.currentTarget.value;
					setText(hex);
					onChange(hex);
				}}
			/>
			<input
				className="owl-settings-colorfield-hex"
				aria-label={ariaLabel}
				disabled={disabled}
				spellCheck={false}
				value={text}
				onFocus={() => setEditing(true)}
				onBlur={() => {
					setEditing(false);
					setText(value || fallback);
				}}
				onChange={(event) => commit(event.currentTarget.value)}
			/>
			{value && (
				<button type="button" className="owl-settings-colorfield-reset" disabled={disabled} onClick={() => onChange("")}>
					{resetLabel}
				</button>
			)}
		</div>
	);
}
