/**
 * The `offer_next_steps` tool: the model proposes what to do next, and the
 * answer stream renders the proposals as a row of chips.
 *
 * Claude Desktop has the same shape: `offer_next_step_v0` is one of its
 * "display" tool results (`shared-130-DnUXVlYq.js` 的 `Fz` 列表) and renders
 * as clickable suggestion chips under the answer. Clicking one sends it on
 * (Claude's `sendTransparentMessage` — it does not leave a user turn behind).
 *
 * Registered **inactive**, like `tool_search` / `codemode`: the model only
 * sees it when the user turns it on (`defaultTools: ["+offer_next_steps"]`).
 * A tool that is always declared turns every answer into a menu.
 */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";

export const OFFER_NEXT_STEPS_TOOL_NAME = "offer_next_steps";

/** 建议的数量上下限。Claude 的建议卡是一排，太多就成菜单了。 */
export const MIN_NEXT_STEPS = 1;
export const MAX_NEXT_STEPS = 4;

const nextStepSchema = Type.Object({
	label: Type.String({
		description: "Chip text. Short and concrete — what the user would tap. One line, under ~20 characters.",
	}),
	prompt: Type.Optional(
		Type.String({
			description:
				"The message to send when the chip is tapped. Defaults to the label. Write it as the user's own request, not as an instruction to yourself.",
		}),
	),
});

const offerNextStepsSchema = Type.Object({
	steps: Type.Array(nextStepSchema, {
		description: `The next steps to offer. ${MIN_NEXT_STEPS}–${MAX_NEXT_STEPS} items.`,
	}),
});

export interface OfferNextStep {
	/** Chip text. */
	label: string;
	/** What gets sent when the chip is tapped. */
	prompt: string;
}

export interface OfferNextStepsDetails {
	steps: OfferNextStep[];
}

export const OFFER_NEXT_STEPS_DESCRIPTION =
	"Offer the user concrete next steps after finishing. Each step becomes a clickable chip under the answer. " +
	"Offer only when there is a genuine, actionable follow-up — not a summary of what you just did, and not a menu of everything possible. " +
	"Skip it entirely when the answer is complete, when the user asked a question that needs no follow-up, or when you have already asked them something.";

export const OFFER_NEXT_STEPS_GUIDELINES = [
	'Each chip is one concrete action the user could take next, phrased as their request ("Add tests for the parser"), not as your suggestion ("I could add tests").',
	"Two or three chips beat five. If a step needs a paragraph to explain, it is not a chip.",
	"Offer steps only when the work is genuinely open. A finished task with nothing to follow up on gets no chips at all.",
	"Never repeat a step the user already took, and never offer to do the thing they just asked for.",
];

export function createOfferNextStepsToolDefinition(): ToolDefinition<
	typeof offerNextStepsSchema,
	OfferNextStepsDetails
> {
	return {
		name: OFFER_NEXT_STEPS_TOOL_NAME,
		label: OFFER_NEXT_STEPS_TOOL_NAME,
		description: OFFER_NEXT_STEPS_DESCRIPTION,
		promptSnippet: "Offer the user concrete next steps as clickable chips",
		promptGuidelines: [...OFFER_NEXT_STEPS_GUIDELINES],
		parameters: offerNextStepsSchema,
		// The chips are a surface for the human; scripts have nothing to do with them.
		exposure: "model-only",
		async execute(_toolCallId, input: Static<typeof offerNextStepsSchema>) {
			const steps = input.steps
				.filter((step) => step.label.trim() !== "")
				.map((step) => ({ label: step.label.trim(), prompt: step.prompt?.trim() || step.label.trim() }));
			if (steps.length === 0) throw new Error("Provide at least one step with a non-empty label.");
			if (steps.length > MAX_NEXT_STEPS) throw new Error(`Provide at most ${MAX_NEXT_STEPS} steps.`);
			const details: OfferNextStepsDetails = { steps };
			return {
				content: [{ type: "text", text: steps.map((step) => step.label).join(" / ") }],
				details,
			};
		},
	};
}
