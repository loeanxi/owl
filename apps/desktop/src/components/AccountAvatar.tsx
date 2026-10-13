/**
 * 账号头像：自定义图片（256px PNG，存账号 agentDir）优先，其次名字首字符
 * 圆形（accent 底），再次 Owl 吉祥物占位。左下角 rail、账号菜单、个人主页
 * 共用 `useAccountAvatar` 拉取。
 */

import { useEffect, useState } from "react";
import type { BridgeClient } from "../bridge/client.ts";

export function AccountAvatar({
	name,
	src,
	size = 28,
	className,
}: {
	name?: string;
	/** 自定义头像 data URL（可空）。 */
	src?: string | null;
	size?: number;
	className?: string;
}): React.JSX.Element {
	if (src) {
		return (
			<img
				src={src}
				alt=""
				draggable={false}
				className={`owl-account-avatar is-image${className ? ` ${className}` : ""}`}
				style={{ width: size, height: size }}
			/>
		);
	}
	const trimmed = name?.trim();
	const initial = trimmed ? [...trimmed][0]?.toUpperCase() : undefined;
	if (!initial) {
		return (
			<img
				src="/owl.svg"
				alt=""
				draggable={false}
				className={`owl-account-avatar is-fallback${className ? ` ${className}` : ""}`}
				style={{ width: size, height: size }}
			/>
		);
	}
	return (
		<span
			className={`owl-account-avatar${className ? ` ${className}` : ""}`}
			style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
			aria-hidden="true"
		>
			{initial}
		</span>
	);
}

/** 拉当前账号自定义头像（data URL；无则 null）。菜单打开/页面挂载时重拉即可拿到最新。 */
export function useAccountAvatar(client: BridgeClient, refreshKey?: unknown): string | null {
	const [avatar, setAvatar] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		void client
			.request<{ data: string | null }>({ type: "account.avatar.get" })
			.then((response) => {
				if (!cancelled && response.ok && response.result) setAvatar(response.result.data);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [client, refreshKey]);
	return avatar;
}

/** 把任意图片 data URL 压成 256×256 PNG（cover 裁剪），供头像存储。 */
export async function compressAvatarImage(dataUrl: string, size = 256): Promise<string> {
	const image = await new Promise<HTMLImageElement>((resolve, reject) => {
		const element = new Image();
		element.onload = () => resolve(element);
		element.onerror = () => reject(new Error("图片解码失败"));
		element.src = dataUrl;
	});
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("canvas 不可用");
	const scale = Math.max(size / image.width, size / image.height);
	const drawWidth = image.width * scale;
	const drawHeight = image.height * scale;
	context.drawImage(image, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);
	return canvas.toDataURL("image/png");
}
