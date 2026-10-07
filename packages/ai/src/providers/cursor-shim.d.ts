declare module "@rahularya01/pi-cursor" {
	const start: (api: {
		on: (...args: unknown[]) => void;
		registerCommand: (...args: unknown[]) => void;
		registerProvider: (id: string, config: Record<string, unknown>) => void;
	}) => void | Promise<void>;
	export default start;
	export const CURSOR_NATIVE_API: string;
	export const FALLBACK_MODELS: ReadonlyArray<{
		id: string;
		name: string;
		reasoning?: boolean;
		contextWindow?: number;
		maxTokens?: number;
	}>;
}
