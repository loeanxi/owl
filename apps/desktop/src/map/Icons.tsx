import type { JSX, ReactNode } from "react";

export type MapIconName =
	| "map"
	| "chat"
	| "search"
	| "compass"
	| "bookmark"
	| "clock"
	| "plus"
	| "arrow"
	| "chevron"
	| "pin"
	| "coffee"
	| "tree"
	| "museum"
	| "sparkle"
	| "check"
	| "compare"
	| "close"
	| "target"
	| "plug"
	| "wallet"
	| "info";

const paths: Record<MapIconName, ReactNode> = {
	map: (
		<>
			<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z" />
			<path d="M9 3v15M15 6v15" />
		</>
	),
	chat: <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 0 1 12.5 3a8.5 8.5 0 0 1 8.5 8.5z" />,
	search: (
		<>
			<circle cx="10.5" cy="10.5" r="6.5" />
			<path d="m16 16 4 4" />
		</>
	),
	compass: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="m16 8-2 6-6 2 2-6z" />
		</>
	),
	bookmark: <path d="M6 3h12v18l-6-4-6 4z" />,
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	plus: <path d="M12 5v14M5 12h14" />,
	arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
	chevron: <path d="m9 6 6 6-6 6" />,
	pin: (
		<>
			<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0z" />
			<circle cx="12" cy="10" r="2.5" />
		</>
	),
	coffee: <path d="M3 8h13v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM16 9h2a3 3 0 0 1 0 6h-2M6 3v2M10 2v3M14 3v2" />,
	tree: <path d="m12 2 6 7h-3l4 6h-5v6h-4v-6H5l4-6H6z" />,
	museum: <path d="m2 7 10-5 10 5zM4 10v9M9 10v9M15 10v9M20 10v9M2 22h20" />,
	sparkle: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4" />,
	check: <path d="m5 12 4 4L19 6" />,
	compare: (
		<>
			<rect x="3" y="5" width="7" height="14" rx="1.5" />
			<rect x="14" y="5" width="7" height="14" rx="1.5" />
		</>
	),
	close: <path d="m6 6 12 12M6 18 18 6" />,
	target: (
		<>
			<circle cx="12" cy="12" r="7" />
			<circle cx="12" cy="12" r="2" />
			<path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
		</>
	),
	plug: <path d="M7 3v5M17 3v5M5 8h14v4a7 7 0 0 1-14 0zM12 19v3" />,
	wallet: <path d="M20 7H4a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h15V7M20 11h-6v6h6" />,
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v6M12 7h.01" />
		</>
	),
};

export function MapIcon({ name }: { name: MapIconName }): JSX.Element {
	return (
		<svg
			className="map-icon icon"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{paths[name]}
		</svg>
	);
}
