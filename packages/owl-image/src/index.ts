/**
 * owl-image — multi-provider image generation for the Owl coding agent.
 *
 * Extension entry: registers the generate_image / generate_images / edit_image /
 * find_inspiration tools plus the /image-login, /image-logout and /image-status
 * commands. Tool layer and tool descriptions ported from shanliuling/dsh-image-gen
 * (Apache-2.0); the DSH attachment store, settings service and browser workbench
 * are replaced by owl-native equivalents (workspace files, image-gen.json, and
 * image blocks carried inline in the conversation).
 */
import type { ExtensionAPI } from "@owl/owl-coding-agent";
import { Type } from "typebox";
import { openInBrowser } from "./browser-open.ts";
import { editComfyUIImage, generateComfyUIImage } from "./comfyui.ts";
import {
	type AspectRatio,
	DEFAULT_WORKSPACE_FOLDER,
	type ImageSize,
	installApiKeys,
	loadConfig,
	type OwlImageConfig,
	providerOverrideOf,
	type ResolvedProvider,
	requireApiKey,
	resolveApiKey,
	resolveProvider,
	selectComfyUIWorkflow,
	setAmbientProxy,
	withProviderOverrides,
} from "./config.ts";
import { editDashScopeImage, generateDashScopeImage } from "./dashscope.ts";
import { editGoogleImage, generateGoogleImage } from "./google.ts";
import { BUNDLED_INSPIRATION_CATALOG, searchInspirationCases } from "./inspiration/catalog.ts";
import { detectImageMediaType, type GeneratedImage } from "./media.ts";
import { editOpenAICompatibleImage, generateOpenAICompatibleImage } from "./openai-compatible.ts";
import { type OwlSessionLike, resolveReferenceImages } from "./reference-image.ts";
import { editSeedreamImage } from "./seedream.ts";
import { type ImageProvider, mergeComfyUIPrompt, SUBSCRIPTION_TIMEOUT_MS } from "./shared.ts";
import { SubscriptionManager, type SubscriptionReferenceImage } from "./subscription/manager.ts";
import { imageDigest, saveImageToWorkspace } from "./workspace-save.ts";
import { xaiToolParameters } from "./xai-params.ts";

/** Match pi-ai's StringEnum without loading its compat barrel during registration. */
function StringEnum<T extends string[]>(values: T, options?: { description?: string }) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values,
		...(options?.description !== undefined && { description: options.description }),
	});
}

const PROVIDER_ENUM = [
	"google",
	"openai",
	"openai-compat",
	"seedream",
	"dashscope",
	"xai",
	"zhipu",
	"comfyui",
	"google-sub",
] as const;
const ASPECT_RATIO_VALUES = ["1:1", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "16:9", "9:16", "21:9"] as const;
const IMAGE_SIZE_VALUES = ["1K", "2K", "4K"] as const;

/** One generated image plus its provenance, shared by all generation paths. */
interface GeneratedValue {
	image: GeneratedImage;
	provider: ImageProvider;
	model: string;
	output: string;
	savedTo?: string;
	saveError?: string;
	seed?: number;
}

/** Per-item generation request fields shared by generate_image and generate_images. */
interface SingleGenerationArgs {
	prompt: string;
	provider?: string;
	model?: string;
	aspect_ratio?: string;
	image_size?: string;
	size?: string;
	workflow?: string;
}

/** Execution environment a generation call needs from the owl session. */
interface GenerationEnv {
	cwd?: string;
	session?: OwlSessionLike;
	signal: AbortSignal;
	maxBytes: number;
	saveToWorkspace: boolean;
	workspaceFolder: string | undefined;
	proxy?: string;
}

/** Provider description strings shared by generate_image and generate_images. */
const PROVIDER_ARG_DESCRIPTION =
	"Optional provider for this call only (for example when the user asks to use a specific one); omit to use the configured default. google-sub generates through the logged-in Google (Antigravity) subscription account instead of an API key.";
const SIZE_ARG_DESCRIPTION =
	"Optional dimensions or size tier for OpenAI, Seedream, or DashScope; WIDTHxHEIGHT maps to aspect_ratio for xAI Grok and google-sub.";
const RATIO_ARG_DESCRIPTION = "Optional output aspect ratio for Google Gemini, xAI Grok, and google-sub.";
const IMAGE_SIZE_ARG_DESCRIPTION =
	"Optional output resolution for Google Gemini (1K/2K/4K) or google-sub (1K/4K; 4K means HD).";

/**
 * Module-level subscription manager shared by the extension instance and the
 * bridge-facing exports at the bottom of this file: the desktop settings page
 * drives login/logout from the bridge process, which imports this dist file
 * directly, while the session-resident extension reads the same on-disk auth
 * blob on every call.
 */
const sharedSubscriptionManager = new SubscriptionManager();

export default function (pi: ExtensionAPI) {
	const manager = sharedSubscriptionManager;

	/** Config re-read per call so image-gen.json edits apply without a restart. */
	function currentConfig(): OwlImageConfig {
		const config = loadConfig();
		installApiKeys(config);
		setAmbientProxy(config.proxy);
		return config;
	}

	// -----------------------------------------------------------------------
	// Shared generation pipeline
	// -----------------------------------------------------------------------

	async function generateSingle(args: SingleGenerationArgs, env: GenerationEnv): Promise<GeneratedValue> {
		const config = currentConfig();
		const active = resolveProvider(withProviderOverrides(config, providerOverrideOf(args.provider), args.model));
		const proxy = config.proxy;
		const generated = await generateWithProvider(active, args, env, config, proxy);
		return saveGenerated(generated, active, env, config);
	}

	/** Dispatch one wire call on the resolved provider profile. */
	async function generateWithProvider(
		active: ResolvedProvider,
		args: SingleGenerationArgs,
		env: GenerationEnv,
		config: OwlImageConfig,
		proxy: string | undefined,
	): Promise<{ image: GeneratedImage; model: string; output: string; seed?: number }> {
		if (active.provider === "comfyui") {
			const workflow = selectComfyUIWorkflow(active, args.workflow);
			const generated = await generateComfyUIImage({
				baseURL: active.baseURL,
				workflowJson: workflow.json,
				prompt: mergeComfyUIPrompt(workflow.presetPrompt, args.prompt),
				timeoutMs: active.timeoutMs,
				maxBytes: env.maxBytes,
				signal: env.signal,
				proxy,
			});
			return {
				image: { data: generated.data, mediaType: generated.mediaType },
				model: workflow.name,
				output: "API workflow",
				seed: generated.seed,
			};
		}
		if (active.provider === "google-sub") {
			const params = googleSubParameters(args);
			const result = await withSubscriptionTimeout(
				manager.generate({
					prompt: args.prompt,
					...(config.googleSubModel !== undefined && config.googleSubModel.trim().length > 0
						? { model: config.googleSubModel.trim() }
						: {}),
					...params,
					signal: env.signal,
					proxy,
				}),
				env.signal,
			);
			const data = new Uint8Array(Buffer.from(result.b64, "base64"));
			if (data.byteLength > env.maxBytes)
				throw new Error(`google-sub image exceeded the ${String(env.maxBytes)} byte image limit`);
			return {
				image: sniffImage(data, "google-sub"),
				model: active.model,
				output: params.quality === "hd" ? "4K HD" : (params.size ?? "auto"),
			};
		}
		const credential = await requireApiKey(active.provider, "generate_image");
		if (active.provider === "google") {
			const aspectRatio = (args.aspect_ratio ?? active.aspectRatio) as AspectRatio;
			const imageSize = (args.image_size ?? active.imageSize) as ImageSize;
			const generated = await generateGoogleImage({
				apiKey: credential,
				endpoint: active.endpoint,
				model: active.model,
				prompt: args.prompt,
				aspectRatio,
				imageSize,
				maxBytes: env.maxBytes,
				signal: env.signal,
				proxy,
			});
			return { image: generated, model: active.model, output: `${aspectRatio}, ${imageSize}` };
		}
		if (active.provider === "dashscope") {
			const size = args.size ?? active.imageSize;
			const generated = await generateDashScopeImage({
				apiKey: credential,
				endpoint: active.endpoint,
				model: active.model,
				prompt: args.prompt,
				size,
				maxBytes: env.maxBytes,
				signal: env.signal,
				proxy,
			});
			return { image: generated, model: active.model, output: size };
		}
		if (active.provider === "xai") {
			const extraBody = xaiToolParameters({
				...(args.aspect_ratio !== undefined ? { aspectRatio: args.aspect_ratio } : {}),
				...(args.image_size !== undefined ? { imageSize: args.image_size } : {}),
				...(args.size !== undefined ? { size: args.size } : {}),
			});
			const generated = await generateOpenAICompatibleImage({
				provider: "xai",
				apiKey: credential,
				baseURL: active.baseURL,
				model: active.model,
				prompt: args.prompt,
				extraBody,
				maxBytes: env.maxBytes,
				signal: env.signal,
				proxy,
			});
			return { image: generated, model: active.model, output: extraBody.aspect_ratio ?? "auto" };
		}
		const size = args.size ?? active.imageSize;
		// Ark output controls exist only on the Seedream profile; every other
		// provider in this branch ignores them.
		const arkOptions = active.provider === "seedream" ? active.arkOptions : undefined;
		const generated = await generateOpenAICompatibleImage({
			provider: active.provider,
			apiKey: credential,
			baseURL: active.baseURL,
			model: active.model,
			prompt: args.prompt,
			size,
			maxBytes: env.maxBytes,
			signal: env.signal,
			proxy,
			...(arkOptions === undefined ? {} : { arkOptions }),
		});
		return { image: generated, model: active.model, output: size };
	}

	/** Persist the generated image under the session workspace (content-addressed name). */
	async function saveGenerated(
		generated: { image: GeneratedImage; model: string; output: string; seed?: number },
		active: ResolvedProvider,
		env: GenerationEnv,
		config: OwlImageConfig,
	): Promise<GeneratedValue> {
		const value: GeneratedValue = {
			image: generated.image,
			provider: active.provider,
			model: generated.model,
			output: generated.output,
			...(generated.seed === undefined ? {} : { seed: generated.seed }),
		};
		if (env.saveToWorkspace === false) return value;
		const workspaceRoot = env.cwd;
		if (workspaceRoot === undefined) return value;
		try {
			value.savedTo = await saveImageToWorkspace({
				workspaceRoot,
				folder: config.workspaceFolder ?? DEFAULT_WORKSPACE_FOLDER,
				mediaType: generated.image.mediaType,
				data: generated.image.data,
				signal: env.signal,
			});
		} catch (error) {
			env.signal.throwIfAborted();
			value.saveError = error instanceof Error ? error.message : String(error);
		}
		return value;
	}

	/** Tool-result content for one generated image: model-facing text plus the image itself. */
	function imageResultContent(value: GeneratedValue, config: OwlImageConfig): Array<Record<string, unknown>> {
		const saved =
			typeof value.savedTo === "string"
				? ` It was also saved to the workspace as ${value.savedTo}.`
				: typeof value.saveError === "string"
					? ` Saving it to the workspace failed: ${value.saveError}.`
					: " It has no local file path.";
		const text =
			`Generated one image with ${value.provider}/${value.model} (${value.output}). Image id: ${imageDigest(value.image.data)}.` +
			`${saved} It is attached to this tool result — respond to the user without calling read or other tools to locate or verify the image.`;
		const content: Array<Record<string, unknown>> = [{ type: "text", text }];
		if (config.attachImageToResult !== false) {
			content.push({
				type: "image",
				data: Buffer.from(value.image.data).toString("base64"),
				mimeType: value.image.mediaType,
			});
		}
		return content;
	}

	function detailsOf(value: GeneratedValue): Record<string, unknown> {
		return {
			provider: value.provider,
			model: value.model,
			output: value.output,
			bytes: value.image.data.byteLength,
			mediaType: value.image.mediaType,
			...(value.savedTo === undefined ? {} : { savedTo: value.savedTo }),
			...(value.saveError === undefined ? {} : { saveError: value.saveError }),
			...(value.seed === undefined ? {} : { seed: value.seed }),
			digest: imageDigest(value.image.data),
		};
	}

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate a new image with the configured provider. Use when the user asks to create or draw a new image; use edit_image instead when they want to change an existing image. Give a complete visual prompt including subject, composition, style, lighting, and any exact text that should appear. The optional provider/model arguments switch provider or model for this call only when the user asks for a specific one. A successful image is attached to the tool result and may also be saved under the session workspace. Do not call read, glob, or other tools to locate or verify the image.",
		promptSnippet:
			"Use when the user asks to create or draw a new image; prefer edit_image for changing an existing one.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete description of the image to generate." }),
			provider: Type.Optional(
				Type.Unsafe<string>({ type: "string", enum: [...PROVIDER_ENUM], description: PROVIDER_ARG_DESCRIPTION }),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Optional model name for this call only, overriding the configured model. Not used by ComfyUI (use workflow instead) nor by google-sub (model fixed by the channel).",
				}),
			),
			aspect_ratio: Type.Optional(StringEnum([...ASPECT_RATIO_VALUES], { description: RATIO_ARG_DESCRIPTION })),
			image_size: Type.Optional(StringEnum([...IMAGE_SIZE_VALUES], { description: IMAGE_SIZE_ARG_DESCRIPTION })),
			size: Type.Optional(Type.String({ description: SIZE_ARG_DESCRIPTION })),
			workflow: Type.Optional(
				Type.String({
					description:
						"Optional name of the ComfyUI workflow to run; omit to use the active workflow from image-gen.json. Only meaningful when the ComfyUI provider is selected.",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			signal = signal ?? new AbortController().signal;
			const config = currentConfig();
			const value = await generateSingle(params, {
				cwd: ctx.cwd,
				session: ctx.sessionManager as unknown as OwlSessionLike,
				signal,
				maxBytes: config.maxImageBytes ?? 10 * 1024 * 1024,
				saveToWorkspace: config.saveToWorkspace !== false,
				workspaceFolder: config.workspaceFolder ?? DEFAULT_WORKSPACE_FOLDER,
				...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
			});
			return {
				content: imageResultContent(value, config),
				details: detailsOf(value),
			} as never;
		},
		renderCall(args) {
			const provider = typeof args.provider === "string" && args.provider.length > 0 ? args.provider : "default";
			const prompt = typeof args.prompt === "string" ? args.prompt : "";
			const display = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
			return `generate_image [${provider}] ${display}`;
		},
		renderResult(result, { isPartial }) {
			if (isPartial) return "generating image...";
			const details = (result.details ?? {}) as {
				provider?: string;
				model?: string;
				output?: string;
				savedTo?: string;
				saveError?: string;
			};
			if (result.isError) return `image generation failed: ${errorMessageOf(result)}`;
			const where =
				typeof details.savedTo === "string"
					? `\n  saved: ${details.savedTo}`
					: typeof details.saveError === "string"
						? `\n  save failed: ${details.saveError}`
						: "";
			return `${details.provider ?? "image"}/${details.model ?? ""} (${details.output ?? ""})${where}`;
		},
	});

	pi.registerTool({
		name: "generate_images",
		label: "Generate Images (batch)",
		description:
			"Generate several images in one call, one per prompt, in order. Use for batches, variations, or illustration sets; prefer generate_image for a single image. Every successful image is attached to the tool result and may be saved under the session workspace. Items generate sequentially; a failed item is reported in the failures list and does not abort the rest. The optional provider/model/size arguments apply to every item.",
		promptSnippet: "Use for image batches or variation sets; one prompt per image, failures isolated per item.",
		parameters: Type.Object({
			prompts: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 10,
				description: "Ordered complete prompts; one image is generated per entry (1-10).",
			}),
			provider: Type.Optional(
				Type.Unsafe<string>({
					type: "string",
					enum: [...PROVIDER_ENUM],
					description:
						"Optional provider for this call, applied to every item; omit to use the configured default.",
				}),
			),
			model: Type.Optional(
				Type.String({ description: "Optional model name for this call, applied to every item." }),
			),
			aspect_ratio: Type.Optional(StringEnum([...ASPECT_RATIO_VALUES], { description: RATIO_ARG_DESCRIPTION })),
			image_size: Type.Optional(StringEnum([...IMAGE_SIZE_VALUES], { description: IMAGE_SIZE_ARG_DESCRIPTION })),
			size: Type.Optional(Type.String({ description: SIZE_ARG_DESCRIPTION })),
			workflow: Type.Optional(
				Type.String({
					description: "Optional name of the ComfyUI workflow to run; omit to use the active workflow.",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			signal = signal ?? new AbortController().signal;
			const config = currentConfig();
			if (params.prompts.length === 0) throw new Error("generate_images requires at least one prompt");
			if (params.prompts.length > 10)
				throw new Error(
					`generate_images accepts at most 10 prompts per call (got ${String(params.prompts.length)}); split larger batches into several calls`,
				);
			const env: GenerationEnv = {
				cwd: ctx.cwd,
				session: ctx.sessionManager as unknown as OwlSessionLike,
				signal,
				maxBytes: config.maxImageBytes ?? 10 * 1024 * 1024,
				saveToWorkspace: config.saveToWorkspace !== false,
				workspaceFolder: config.workspaceFolder ?? DEFAULT_WORKSPACE_FOLDER,
				...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
			};
			const images: Array<GeneratedValue & { prompt: string }> = [];
			const failures: Array<{ index: number; prompt: string; error: string }> = [];
			for (const [index, prompt] of params.prompts.entries()) {
				if (signal.aborted) {
					failures.push({ index, prompt, error: "aborted before this image started" });
					continue;
				}
				try {
					const value = await generateSingle(
						{
							prompt,
							...(params.provider !== undefined ? { provider: params.provider } : {}),
							...(params.model !== undefined ? { model: params.model } : {}),
							...(params.aspect_ratio !== undefined ? { aspect_ratio: params.aspect_ratio } : {}),
							...(params.image_size !== undefined ? { image_size: params.image_size } : {}),
							...(params.size !== undefined ? { size: params.size } : {}),
							...(params.workflow !== undefined ? { workflow: params.workflow } : {}),
						},
						env,
					);
					images.push({ ...value, prompt });
				} catch (error) {
					failures.push({ index, prompt, error: error instanceof Error ? error.message : String(error) });
				}
			}
			const content: Array<Record<string, unknown>> = [
				{
					type: "text",
					text:
						`Generated ${String(images.length)} of ${String(images.length + failures.length)} images.\n` +
						failures.map((failure) => `${failure.prompt.slice(0, 80)} — failed: ${failure.error}`).join("\n"),
				},
			];
			if (config.attachImageToResult !== false) {
				for (const image of images) {
					content.push({
						type: "image",
						data: Buffer.from(image.image.data).toString("base64"),
						mimeType: image.image.mediaType,
					});
				}
			}
			return {
				content,
				details: {
					generated: images.length,
					failed: failures.length,
					images: images.map((image) => ({
						prompt: image.prompt,
						provider: image.provider,
						model: image.model,
						...(image.savedTo === undefined ? {} : { savedTo: image.savedTo }),
					})),
					failures,
				},
			} as never;
		},
		renderCall(args) {
			const prompts = Array.isArray(args.prompts) ? args.prompts.length : 0;
			return `generate_images ×${String(prompts)}`;
		},
		renderResult(result, { isPartial }) {
			if (isPartial) return "generating images...";
			const details = (result.details ?? {}) as { generated?: number; failed?: number };
			if (result.isError) return `batch image generation failed: ${errorMessageOf(result)}`;
			return `generated ${String(details.generated ?? 0)}${(details.failed ?? 0) > 0 ? `, ${String(details.failed)} failed` : ""}`;
		},
	});

	pi.registerTool({
		name: "edit_image",
		label: "Edit Image",
		description:
			"Edit, combine, or restyle existing images with the configured provider. Images the user attached to the latest message are readable from the conversation directly: call edit_image with prompt only and they are used in upload order — NEVER call read, glob, or shell to locate them, and NEVER invent paths. Images this tool generated earlier in the conversation are equally usable. For files the user explicitly names in the workspace use source_path or source_paths. Provide at most one selector kind. When the user wants a person, character, or object from the reference images kept as the same identity, write short hard identity-preservation instructions (use the same subject from the references; do not redesign it or synthesize a similar-looking replacement; change only scene, clothing, pose, lighting, style, or composition) instead of long generic appearance descriptions, which make the model replace the subject with a synthesized lookalike.",
		promptSnippet:
			"Use to edit, combine, or restyle conversation or workspace images; without selectors it edits the newest conversation images.",
		parameters: Type.Object({
			prompt: Type.String({
				description: "Describe the changes to make while preserving everything else that should remain.",
			}),
			provider: Type.Optional(
				Type.Unsafe<string>({ type: "string", enum: [...PROVIDER_ENUM], description: PROVIDER_ARG_DESCRIPTION }),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Optional model name for this call only, overriding the configured model. Not used by ComfyUI (use workflow instead) nor by google-sub.",
				}),
			),
			source_path: Type.Optional(
				Type.String({
					description:
						"Optional absolute or workspace-relative path of a specific image file inside the session workspace. Prefer this when the user names a saved file.",
				}),
			),
			source_paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional ordered absolute or workspace-relative paths of multiple image files inside the session workspace.",
				}),
			),
			aspect_ratio: Type.Optional(StringEnum([...ASPECT_RATIO_VALUES], { description: RATIO_ARG_DESCRIPTION })),
			image_size: Type.Optional(StringEnum([...IMAGE_SIZE_VALUES], { description: IMAGE_SIZE_ARG_DESCRIPTION })),
			size: Type.Optional(Type.String({ description: SIZE_ARG_DESCRIPTION })),
			workflow: Type.Optional(
				Type.String({
					description:
						"Optional name of the ComfyUI workflow to run; omit to use the active workflow. Only meaningful when the ComfyUI provider is selected.",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			signal = signal ?? new AbortController().signal;
			const config = currentConfig();
			const active = resolveProvider(
				withProviderOverrides(config, providerOverrideOf(params.provider), params.model),
			);
			const proxy = config.proxy;
			const env: GenerationEnv = {
				cwd: ctx.cwd,
				session: ctx.sessionManager as unknown as OwlSessionLike,
				signal,
				maxBytes: config.maxImageBytes ?? 10 * 1024 * 1024,
				saveToWorkspace: config.saveToWorkspace !== false,
				workspaceFolder: config.workspaceFolder ?? DEFAULT_WORKSPACE_FOLDER,
				...(proxy !== undefined ? { proxy } : {}),
			};
			const sourceImages = await resolveReferenceImages({
				session: env.session,
				...(params.source_path !== undefined ? { sourcePath: params.source_path } : {}),
				...(Array.isArray(params.source_paths) ? { sourcePaths: params.source_paths } : {}),
				maxBytes: env.maxBytes,
				signal,
				...(proxy !== undefined ? { proxy } : {}),
			});

			let generated: { image: GeneratedImage; model: string; output: string; seed?: number };
			if (active.provider === "comfyui") {
				if (sourceImages.length > 1) {
					throw new Error(
						`ComfyUI edit_image supports exactly one source image per call; this call resolved ${String(sourceImages.length)} images. Call edit_image again with source_path set to the single image to edit.`,
					);
				}
				const sourceImage = sourceImages[0];
				if (sourceImage === undefined) throw new Error("edit_image requires a reference image");
				const workflow = selectComfyUIWorkflow(active, params.workflow);
				const result = await editComfyUIImage({
					baseURL: active.baseURL,
					workflowJson: workflow.json,
					prompt: mergeComfyUIPrompt(workflow.presetPrompt, params.prompt),
					sourceImage: { data: sourceImage.data, mediaType: sourceImage.mediaType },
					timeoutMs: active.timeoutMs,
					maxBytes: env.maxBytes,
					signal,
					...(proxy !== undefined ? { proxy } : {}),
				});
				generated = {
					image: { data: result.data, mediaType: result.mediaType },
					model: workflow.name,
					output: "API workflow",
					seed: result.seed,
				};
			} else if (active.provider === "google-sub") {
				if (sourceImages.length === 0) throw new Error("edit_image requires a reference image");
				const subParams = googleSubParameters(params);
				const references: SubscriptionReferenceImage[] = sourceImages.map((image) => ({
					data: image.data,
					mediaType: image.mediaType,
				}));
				const result = await withSubscriptionTimeout(
					manager.generate({
						prompt: params.prompt,
						...(config.googleSubModel !== undefined && config.googleSubModel.trim().length > 0
							? { model: config.googleSubModel.trim() }
							: {}),
						...subParams,
						referenceImages: references,
						signal,
						...(proxy !== undefined ? { proxy } : {}),
					}),
					signal,
				);
				const data = new Uint8Array(Buffer.from(result.b64, "base64"));
				if (data.byteLength > env.maxBytes)
					throw new Error(`google-sub image exceeded the ${String(env.maxBytes)} byte image limit`);
				generated = {
					image: sniffImage(data, "google-sub"),
					model: active.model,
					output: subParams.quality === "hd" ? "4K HD edit" : "subscription edit",
				};
			} else {
				const credential = await requireApiKey(active.provider, "edit_image");
				if (active.provider === "google") {
					const aspectRatio = (params.aspect_ratio ?? active.aspectRatio) as AspectRatio;
					const imageSize = (params.image_size ?? active.imageSize) as ImageSize;
					const result = await editGoogleImage({
						apiKey: credential,
						endpoint: active.endpoint,
						model: active.model,
						prompt: params.prompt,
						sourceImages,
						aspectRatio,
						imageSize,
						maxBytes: env.maxBytes,
						signal,
						proxy,
					});
					generated = { image: result, model: active.model, output: `${aspectRatio}, ${imageSize}` };
				} else if (
					active.provider === "openai" ||
					active.provider === "openai-compat" ||
					active.provider === "xai" ||
					active.provider === "zhipu"
				) {
					const xaiExtraBody =
						active.provider === "xai"
							? xaiToolParameters({
									...(params.aspect_ratio !== undefined ? { aspectRatio: params.aspect_ratio } : {}),
									...(params.image_size !== undefined ? { imageSize: params.image_size } : {}),
									...(params.size !== undefined ? { size: params.size } : {}),
								})
							: undefined;
					const size = params.size ?? active.imageSize;
					const result = await editOpenAICompatibleImage({
						apiKey: credential,
						baseURL: active.baseURL,
						model: active.model,
						prompt: params.prompt,
						sourceImages,
						...(active.provider === "xai" ? {} : { size }),
						maxBytes: env.maxBytes,
						signal,
						proxy,
						...(active.provider === "openai-compat"
							? { editFormat: active.editFormat, editExtra: active.editExtra }
							: active.provider === "xai"
								? {
										editFormat: "xaiJson" as const,
										...(xaiExtraBody === undefined ? {} : { extraBody: xaiExtraBody }),
									}
								: {}),
					});
					generated = {
						image: result,
						model: active.model,
						output: active.provider === "xai" ? (xaiExtraBody?.aspect_ratio ?? "auto") : size,
					};
				} else if (active.provider === "seedream") {
					const size = params.size ?? active.imageSize;
					const result = await editSeedreamImage({
						apiKey: credential,
						baseURL: active.baseURL,
						model: active.model,
						prompt: params.prompt,
						sourceImages,
						size,
						maxBytes: env.maxBytes,
						signal,
						arkOptions: active.arkOptions,
						proxy,
					});
					generated = { image: result, model: active.model, output: size };
				} else {
					const size = params.size ?? active.imageSize;
					const result = await editDashScopeImage({
						apiKey: credential,
						endpoint: active.endpoint,
						model: active.model,
						prompt: params.prompt,
						sourceImages,
						size,
						maxBytes: env.maxBytes,
						signal,
						proxy,
					});
					generated = { image: result, model: active.model, output: size };
				}
			}

			const value = await saveGenerated(generated, active, env, config);
			return {
				content: imageResultContent(value, config),
				details: { ...detailsOf(value), operation: "edit", referenceCount: sourceImages.length },
			} as never;
		},
		renderCall(args) {
			const provider = typeof args.provider === "string" && args.provider.length > 0 ? args.provider : "default";
			const prompt = typeof args.prompt === "string" ? args.prompt : "";
			const display = prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
			return `edit_image [${provider}] ${display}`;
		},
		renderResult(result, { isPartial }) {
			if (isPartial) return "editing image...";
			const details = (result.details ?? {}) as {
				provider?: string;
				model?: string;
				savedTo?: string;
				saveError?: string;
				referenceCount?: number;
			};
			if (result.isError) return `image edit failed: ${errorMessageOf(result)}`;
			const where =
				typeof details.savedTo === "string"
					? `\n  saved: ${details.savedTo}`
					: typeof details.saveError === "string"
						? `\n  save failed: ${details.saveError}`
						: "";
			return `${details.provider ?? "image"}/${details.model ?? ""} edit (${String(details.referenceCount ?? 0)} reference)${where}`;
		},
	});

	pi.registerTool({
		name: "find_inspiration",
		label: "Find Inspiration",
		description:
			"Search the bundled inspiration libraries for ready-made image prompts: the handdraw-style cookbook (styles 风格, layouts 排版, theme colors 单色) plus the awesome-gpt-image-2 example set. Use before generate_image whenever the user wants a specific art style, layout template, or theme color, mentions a numbered style like 风格 #123, or asks for reference or example prompts. Each hit carries a full prompt reusable with generate_image; handdraw style prompts contain a 主题 placeholder to replace with the user's topic, and may be combined with a layout and a theme-color prompt.",
		promptSnippet: "Search before generate_image when the user wants a specific art style, layout, or theme color.",
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Keyword matched against titles, prompts, categories, and style/scene tags; Chinese or English. Omit to sample what a library offers.",
				}),
			),
			category: Type.Optional(
				Type.String({
					description:
						'Optional exact category filter, for example "风格 · D 日本作者 / 当代插画体系", "排版 · 信息图", or "单色 · 中性色系".',
				}),
			),
			source: Type.Optional(
				StringEnum(["handraw-style", "awesome-gpt-image-2"], {
					description: "Optional single library to search; omit to search both.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({ description: "Optional maximum number of hits to return, 1-20 (default 8)." }),
			),
		}),
		execute: async (_toolCallId, params) => {
			const { total, hits } = searchInspirationCases(BUNDLED_INSPIRATION_CATALOG, {
				query: params.query ?? "",
				sourceId: params.source,
				category: params.category,
				limit: params.limit,
			});
			return {
				content: [
					{
						type: "text",
						text:
							`${String(hits.length)} of ${String(total)} matching inspiration cases.\n\n` +
							hits.map((hit) => `[${hit.sourceId} · ${hit.category}] ${hit.title}\n${hit.prompt}`).join("\n\n"),
					},
				],
				details: { total, hits },
			} as never;
		},
		renderCall(args) {
			const query = typeof args.query === "string" ? args.query : "";
			return `find_inspiration ${query.length > 40 ? `${query.slice(0, 37)}...` : query}`.trimEnd();
		},
		renderResult(result, { isPartial }) {
			if (isPartial) return "searching inspiration...";
			const details = (result.details ?? {}) as { total?: number; hits?: unknown[] };
			if (result.isError) return `inspiration search failed: ${errorMessageOf(result)}`;
			return `${String(details.hits?.length ?? 0)} of ${String(details.total ?? 0)} inspiration cases`;
		},
	});

	// -----------------------------------------------------------------------
	// Subscription commands (google-sub / Antigravity)
	// -----------------------------------------------------------------------

	pi.registerCommand("image-login", {
		description: "Log in to the Google (Antigravity) subscription account for image generation",
		handler: async (_args, ctx) => {
			try {
				const { url } = await manager.beginLogin();
				openInBrowser(url);
				ctx.ui.notify(
					`Google 订阅授权页已在浏览器打开。若未弹出，请手动访问:${url}\n完成授权后本机回环端口会自动接收结果,可用 /image-status 确认。`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Google 订阅登录启动失败:${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("image-logout", {
		description: "Sign out of the Google (Antigravity) subscription account",
		handler: async (_args, ctx) => {
			manager.logout();
			ctx.ui.notify("已退出 Google 订阅账号。", "info");
		},
	});

	pi.registerCommand("image-status", {
		description: "Show owl-image provider configuration and subscription status",
		handler: async (_args, ctx) => {
			const config = currentConfig();
			const lines: string[] = [];
			lines.push(`provider: ${config.provider ?? "google"}`);
			const sub = manager.loginStatus();
			lines.push(`google-sub: ${sub.state === "logged-in" ? `已登录 (${sub.email})` : "未登录 (/image-login)"}`);
			for (const provider of [
				"google",
				"openai",
				"openai-compat",
				"seedream",
				"dashscope",
				"xai",
				"zhipu",
			] as const) {
				lines.push(`${provider}: ${resolveApiKey(provider) !== undefined ? "API key 已配置" : "未配置"}`);
			}
			const comfy = config.comfyuiWorkflows ?? [];
			lines.push(
				`comfyui: ${config.comfyuiBaseURL ?? "http://127.0.0.1:8188"} (${String(comfy.length)} workflow${comfy.length === 1 ? "" : "s"})`,
			);
			lines.push(
				`config: image-gen.json${config.proxy !== undefined && config.proxy.length > 0 ? ` (proxy: ${config.proxy})` : ""}`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Translate image tool options into the google-sub channel's wire inputs. */
function googleSubParameters(args: { size?: string; aspect_ratio?: string; image_size?: string }): {
	size?: string;
	quality?: string;
} {
	if (args.size !== undefined && args.aspect_ratio !== undefined) throw new Error("size 与 aspect_ratio 请只选一个");
	let size = args.size;
	if (size === undefined && args.aspect_ratio !== undefined) size = args.aspect_ratio;
	let quality: string | undefined;
	if (args.image_size === "4K") quality = "hd";
	else if (args.image_size === "1K") quality = undefined;
	else if (args.image_size !== undefined) throw new Error(`google-sub 不支持清晰度 ${args.image_size}`);
	return {
		...(size === undefined ? {} : { size }),
		...(quality === undefined ? {} : { quality }),
	};
}

/** Run one subscription promise with the shared timeout and the call's abort signal. */
async function withSubscriptionTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectCall: (error: Error) => void;
	const onAbort = (): void => {
		rejectCall(new Error("Subscription image generation aborted"));
	};
	const guarded = new Promise<T>((resolve, reject) => {
		rejectCall = reject;
		timer = setTimeout(() => {
			reject(
				new Error(
					`Subscription image generation timed out after ${String(Math.round(SUBSCRIPTION_TIMEOUT_MS / 1000))}s`,
				),
			);
		}, SUBSCRIPTION_TIMEOUT_MS);
		promise.then(resolve, reject);
	});
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await guarded;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/** Sniff generated subscription bytes into a typed image. */
function sniffImage(data: Uint8Array, provider: string): GeneratedImage {
	const mediaType = detectImageMediaType(data);
	if (mediaType === undefined) throw new Error(`${provider} image payload has an unrecognized format`);
	return { data, mediaType };
}

/** First line of the model-facing text of an errored tool result, for TUI rendering. */
function errorMessageOf(result: { content?: Array<{ type: string; text?: string }> }): string {
	const text = (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join(" ");
	return text.split("\n")[0]?.trim() || "unknown error";
}

// ---------------------------------------------------------------------------
// Bridge-facing named exports — the desktop bridge (serve.ts) imports this
// dist file to drive the Google subscription login from the settings page.
// Everything else (config get/set, status, logout) is plain file access and
// lives in the bridge; only the PKCE + loopback + token-exchange flow needs
// this module (single source of truth with the /image-login command).
// ---------------------------------------------------------------------------

/** Begin the Antigravity OAuth login: start the loopback catch server, open
 * the browser, and return the authorize URL (for the UI to display). */
export async function beginGoogleSubscriptionLogin(): Promise<string> {
	const { url } = await sharedSubscriptionManager.beginLogin();
	openInBrowser(url);
	return url;
}

/** Sign out: clear the stored OAuth blob and this instance's caches. */
export function googleSubscriptionLogout(): void {
	sharedSubscriptionManager.logout();
}

/** Login status for badges: { loggedIn, email? }. */
export function googleSubscriptionStatus(): { loggedIn: boolean; email?: string } {
	const status = sharedSubscriptionManager.loginStatus();
	return status.state === "logged-in" ? { loggedIn: true, email: status.email } : { loggedIn: false };
}

/** Bridge-facing: model ids for one provider, for the settings page 「拉取模型」. */
export async function listProviderModelIds(provider: string): Promise<{ models: string[]; error?: string }> {
	const { listProviderModelIds: listIds } = await import("./models-list.ts");
	return listIds(provider);
}
