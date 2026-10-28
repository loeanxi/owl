/**
 * The `offer_next_steps` tool as an extension: the model proposes next steps
 * and the answer stream renders them as clickable chips.
 *
 * Registered inactive — activate it with `--tools`, the `defaultTools` setting
 * (`["+offer_next_steps"]`), or `setActiveTools()`.
 */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createOfferNextStepsToolDefinition } from "./tool.ts";

export function createOfferNextStepsExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({ ...createOfferNextStepsToolDefinition(), defaultActive: false });
	};
}

export default createOfferNextStepsExtension();
