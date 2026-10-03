import { getUiLanguage, useT } from "../../i18n/index.ts";

export function useResearchEntryText(): string {
	useT();
	return getUiLanguage() === "en" ? "Research" : "研究工作台";
}
