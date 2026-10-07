// Seed catalog for Cursor subscription models. Live discovery via refreshModels
// replaces/extends this list after login.

import values from "./data/cursor.json" with { type: "json" };
import {
	flattenChatModelCatalog,
	flattenClassifierModelCatalog,
	flattenImageModelCatalog,
	type ChatModelCatalog,
	type ClassifierModelCatalog,
	type ImageModelCatalog,
} from "../model-catalog.ts";

export const CURSOR_MODELS: ChatModelCatalog<typeof values, "cursor"> = flattenChatModelCatalog("cursor", values);

export const CURSOR_IMAGE_MODELS: ImageModelCatalog<typeof values, "cursor"> = flattenImageModelCatalog(
	"cursor",
	values,
);

export const CURSOR_CLASSIFIER_MODELS: ClassifierModelCatalog<typeof values, "cursor"> =
	flattenClassifierModelCatalog("cursor", values);
