import { useEffect, useRef, useState } from "react";
import { useAppearanceNavigationText } from "./appearance-navigation-copy.ts";
import "./appearance-navigation.css";

export function AppearanceNavigation({ sections }: { sections: readonly { id: string; label: string }[] }): React.JSX.Element {
	const copy = useAppearanceNavigationText();
	const navigation = useRef<HTMLElement>(null);
	const [current, setCurrent] = useState<string | undefined>(sections[0]?.id);
	const sectionIds = sections.map((section) => section.id).join("\0");

	useEffect(() => {
		const nav = navigation.current;
		const container = nav?.closest<HTMLElement>(".owl-settings-content");
		if (!nav || !container) return;
		const targets = sectionIds.split("\0").flatMap((id) => {
			const target = document.getElementById(id);
			return target && container.contains(target) ? [target] : [];
		});
		let frame = 0;
		const update = (): void => {
			// Sticky offsets start at the scroll container's padding edge, while anchors use its viewport.
			const inset = window.getComputedStyle(container).paddingTop;
			if (nav.style.getPropertyValue("--owl-appearance-content-inset") !== inset) nav.style.setProperty("--owl-appearance-content-inset", inset);
			const edge = container.getBoundingClientRect().top + container.clientTop + nav.getBoundingClientRect().height + 16;
			let visible: HTMLElement | undefined = targets[0];
			for (const target of targets) {
				if (target.getBoundingClientRect().top <= edge + 1) visible = target;
			}
			if (container.scrollHeight > container.clientHeight && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
				visible = targets.at(-1);
			}
			setCurrent(visible?.id);
		};
		const scheduleUpdate = (): void => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		};
		update();
		container.addEventListener("scroll", scheduleUpdate, { passive: true });
		const observer = new ResizeObserver(scheduleUpdate);
		observer.observe(container);
		observer.observe(nav);
		for (const target of targets) observer.observe(target);
		return () => {
			cancelAnimationFrame(frame);
			container.removeEventListener("scroll", scheduleUpdate);
			observer.disconnect();
		};
	}, [sectionIds]);

	return <nav ref={navigation} className="owl-appearance-navigation" aria-label={copy("navigation")}>
		<div className="owl-appearance-navigation-links">
			{sections.map((section) => <button
				key={section.id}
				type="button"
				aria-controls={section.id}
				aria-current={current === section.id ? "location" : undefined}
				onClick={() => {
					const nav = navigation.current;
					const container = nav?.closest<HTMLElement>(".owl-settings-content");
					const target = document.getElementById(section.id);
					if (!nav || !container || !target || !container.contains(target)) return;
					const top = Math.max(0, container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop - nav.getBoundingClientRect().height - 16);
					setCurrent(section.id);
					target.focus({ preventScroll: true });
					container.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
				}}
			>{section.label}</button>)}
		</div>
	</nav>;
}
