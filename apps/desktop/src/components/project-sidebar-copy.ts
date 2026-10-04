import { getUiLanguage, useT } from "../i18n/index.ts";
const zh = {
	pin: "置顶", unpin: "取消置顶", edit: "编辑", section: "分区", defaultSection: "项目", newSection: "新建分区",
	reveal: "在资源管理器中打开", markAllRead: "全部标为已读", archiveChats: "归档聊天", removeProject: "移除项目",
	organize: "整理侧边栏", projects: "分项目显示", merged: "合并显示", sort: "聊天排序方式", recent: "最近活动", name: "名称", oldest: "最早创建",
	sectionName: "分区名称", createSection: "创建分区", renameSection: "重命名分区", removeSection: "移除分区", cancel: "取消", save: "保存", confirm: "确认", close: "关闭",
	sectionDuplicate: "已存在同名分区，请换一个名称。", sectionRequired: "请输入分区名称。", removeSectionHint: "移除分区后，项目会回到默认项目分组。",
	archiveTitle: "归档项目聊天", archiveHint: "归档该项目中已结束的聊天。可在设置中恢复，之后按归档保留期自动清理。正在运行的聊天将保留。",
	removeTitle: "移除项目", removeHint: "从侧栏移除此项目，文件夹和聊天记录会保留。", working: "处理中…", archiveResult: "已归档 {done} 个聊天，{failed} 个失败，保留 {running} 个运行中的聊天。", allRead: "该项目的聊天已全部标为已读。",
} as const;
const en: Record<keyof typeof zh, string> = {
	pin: "Pin", unpin: "Unpin", edit: "Edit", section: "Section", defaultSection: "Projects", newSection: "New section",
	reveal: "Open in File Explorer", markAllRead: "Mark all as read", archiveChats: "Archive chats", removeProject: "Remove project",
	organize: "Organize sidebar", projects: "Group by project", merged: "Combined view", sort: "Chat sort order", recent: "Recent activity", name: "Name", oldest: "Oldest created",
	sectionName: "Section name", createSection: "Create section", renameSection: "Rename section", removeSection: "Remove section", cancel: "Cancel", save: "Save", confirm: "Confirm", close: "Close",
	sectionDuplicate: "A section with this name already exists. Choose another name.", sectionRequired: "Enter a section name.", removeSectionHint: "Projects return to the default Projects section when this section is removed.",
	archiveTitle: "Archive project chats", archiveHint: "Archive finished chats in this project. They can be restored in Settings and will later be cleaned up according to the archive retention policy. Running chats will be kept.",
	removeTitle: "Remove project", removeHint: "Remove this project from the sidebar. Its folder and chat history will be kept.", working: "Working…", archiveResult: "Archived {done} chats; {failed} failed; kept {running} running chats.", allRead: "All chats in this project are marked as read.",
};
export type ProjectSidebarTextKey = keyof typeof zh;
export type ProjectSidebarText = (key: ProjectSidebarTextKey) => string;
export const projectSidebarText: ProjectSidebarText = (key) => (getUiLanguage() === "en" ? en : zh)[key];
export function useProjectSidebarText(): ProjectSidebarText { useT(); return projectSidebarText; }
