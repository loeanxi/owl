/** 会话打开/项目恢复中的浮动状态胶囊：挂在 owl-conversation-pins 浮动层里，
 *  不占布局行——出现与消失都不再推挤整屏（此前的状态条会把对话区顶下去再弹回）。 */
export function SessionStatusPill({ text }: { text: string }): React.JSX.Element {
	return (
		<p className="owl-session-status-pill" role="status">
			{text}
		</p>
	);
}
