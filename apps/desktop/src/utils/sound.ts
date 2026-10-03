/**
 * WebAudio 合成提示音（零素材、零依赖）。
 * WebView2 自动播放策略下 AudioContext 可能初始挂起——resume 是异步的，
 * 用户与页面有过一次交互后即正常；失败静默降级。
 */

let ctx: AudioContext | undefined;

export function playChime(kind: "critical" | "info", volumePercent: number): void {
	const volume = Math.min(100, Math.max(0, volumePercent)) / 100;
	if (volume <= 0) return;
	try {
		ctx ??= new AudioContext();
		if (ctx.state === "suspended") void ctx.resume();
		const now = ctx.currentTime;
		const master = ctx.createGain();
		// 滑块是线性刻度、听感是对数的，取平方折中
		master.gain.value = volume * volume;
		master.connect(ctx.destination);
		const beep = (frequency: number, start: number, duration: number): void => {
			const oscillator = ctx!.createOscillator();
			const gain = ctx!.createGain();
			oscillator.type = "sine";
			oscillator.frequency.value = frequency;
			gain.gain.setValueAtTime(0.0001, now + start);
			gain.gain.exponentialRampToValueAtTime(1, now + start + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
			oscillator.connect(gain);
			gain.connect(master);
			oscillator.start(now + start);
			oscillator.stop(now + start + duration + 0.05);
		};
		if (kind === "critical") {
			// 需要人工介入：上行双音，更急促
			beep(880, 0, 0.16);
			beep(1174.66, 0.16, 0.22);
		} else {
			// 任务完成：单音轻响
			beep(659.25, 0, 0.24);
		}
	} catch {
		// 静默降级
	}
}
