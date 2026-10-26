import { getUiLanguage } from "../i18n/index.ts";

const zh = { expandRecords: "展开工具记录", collapseRecords: "收起工具记录" } as const;
const en: Record<keyof typeof zh, string> = { expandRecords: "Expand tool records", collapseRecords: "Collapse tool records" };
/** 工具记录就地开关的双语文案（模块级静态，切换不随语言抖动）。 */
export const chatToolText = (key: keyof typeof zh): string => (getUiLanguage() === "en" ? en : zh)[key];
