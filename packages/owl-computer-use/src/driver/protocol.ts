/** Shared, model-independent Windows computer-use driver protocol. */
export interface ScreenshotMeta {
	imageWidth: number;
	imageHeight: number;
	screenWidth: number;
	screenHeight: number;
	originX: number;
	originY: number;
}

export type ClickButton = "left" | "right" | "middle";

export interface WindowRef {
	hwnd: number;
	title: string;
	process: string;
	pid: number;
	minimized?: boolean;
	foreground?: boolean;
}

export interface WindowRow extends WindowRef {
	class: string;
	x: number;
	y: number;
	w: number;
	h: number;
	minimized: boolean;
	foreground: boolean;
}

export interface ComputerElement {
	id: string;
	name: string;
	controlType: string;
	enabled: boolean;
	password: boolean;
	rect: { x: number; y: number; width: number; height: number };
	patterns: string[];
	/** Bounded UIA field/document readback. Password controls never expose content. */
	value?: string;
	text?: string;
	isReadOnly?: boolean;
	truncated?: boolean;
}

export interface NativeObservation {
	observationId: string;
	target: WindowRow | null;
	elements: ComputerElement[];
	screenshot?: ScreenshotMeta & { jpeg: string };
	capabilities: { uia: boolean; windowCapture: boolean; input: boolean; backgroundUia?: boolean };
	diagnostics?: string[];
}

export type ComputerAction =
	| "open_app"
	| "click"
	| "type"
	| "key"
	| "scroll"
	| "focus"
	| "restore"
	| "invoke"
	| "set_value"
	| "select"
	| "toggle";

export interface NativeActInput {
	observationId: string;
	action: ComputerAction;
	inputMode?: "auto" | "background" | "foreground";
	/** Application executable name/path or Windows App User Model ID; never a command line. */
	app?: string;
	elementId?: string;
	x?: number;
	y?: number;
	text?: string;
	/** type normally inserts; true permits replacing the complete field through UIA Value. */
	replace?: boolean;
	button?: ClickButton;
	double?: boolean;
	delta?: number;
	horizontal?: boolean;
	down?: number[];
	tap?: number[];
}

export interface NativeActResult {
	status: "confirmed" | "issued" | "blocked" | "partial" | "unknown";
	code?: string;
	message?: string;
	typedCharacters?: number;
	requiresExclusive?: boolean;
	requestedMode?: "auto" | "background" | "foreground";
	executedMode?: "background" | "foreground";
	executedAction?: ComputerAction;
	fallbackReason?: string;
	retryable?: boolean;
	retryAfterMs?: number;
	nextAction?: string;
	/** A launch may reveal a different target than the observation used to authorize it. */
	target?: WindowRow;
	observation?: NativeObservation;
}

/** A narrow port also allows runtime tests to avoid real desktop input. */
export interface ComputerDriverPort {
	observe(
		options: { hwnd?: number; includeImage?: boolean; maxWidth?: number },
		signal?: AbortSignal,
	): Promise<NativeObservation>;
	act(input: NativeActInput, signal?: AbortSignal): Promise<NativeActResult>;
	windows(signal?: AbortSignal): Promise<WindowRow[]>;
	release(signal?: AbortSignal): Promise<void>;
}
