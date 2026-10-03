/**
 * WebAudio 合成提示音库（零素材、零依赖）。
 * WebView2 自动播放策略下 AudioContext 可能初始挂起——resume 是异步的，
 * 用户与页面有过一次交互后即正常；失败静默降级。
 *
 * "auto" 按类别自动选音：需要人工介入（审批/提问）用上行双音，完成用单音轻响。
 */

export const NOTIFICATION_SOUNDS = ["auto", "ding", "chime", "soft", "bell", "marimba", "pulse", "drop"] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export function isNotificationSound(value: unknown): value is NotificationSound {
	return typeof value === "string" && (NOTIFICATION_SOUNDS as readonly string[]).includes(value);
}

let ctx: AudioContext | undefined;

function getContext(): AudioContext | undefined {
	try {
		ctx ??= new AudioContext();
		if (ctx.state === "suspended") void ctx.resume();
		return ctx;
	} catch {
		return undefined;
	}
}

/** 单个音符：正弦/三角波 + 起音/指数衰减包络。 */
function beep(
	audio: AudioContext,
	master: GainNode,
	options: { frequency: number; start: number; duration: number; type?: OscillatorType; gain?: number },
): void {
	const oscillator = audio.createOscillator();
	const gain = audio.createGain();
	oscillator.type = options.type ?? "sine";
	oscillator.frequency.value = options.frequency;
	const peak = options.gain ?? 1;
	gain.gain.setValueAtTime(0.0001, audio.currentTime + options.start);
	gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), audio.currentTime + options.start + 0.02);
	gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + options.start + options.duration);
	oscillator.connect(gain);
	gain.connect(master);
	oscillator.start(audio.currentTime + options.start);
	oscillator.stop(audio.currentTime + options.start + options.duration + 0.05);
}

/** 播放指定提示音；volumePercent 0-100，声音风格 "auto" 时按 critical 自动选。 */
export function playChime(sound: NotificationSound, volumePercent: number, critical: boolean): void {
	const volume = Math.min(100, Math.max(0, volumePercent)) / 100;
	if (volume <= 0) return;
	const audio = getContext();
	if (!audio) return;
	try {
		const now = audio.currentTime;
		const master = audio.createGain();
		// 滑块是线性刻度、听感是对数的，取平方折中
		master.gain.value = volume * volume;
		master.connect(audio.destination);

		switch (sound) {
			case "auto":
				if (critical) {
					// 需要人工介入：上行双音，更急促
					beep(audio, master, { frequency: 880, start: 0, duration: 0.16 });
					beep(audio, master, { frequency: 1174.66, start: 0.16, duration: 0.22 });
				} else {
					// 任务完成：单音轻响
					beep(audio, master, { frequency: 659.25, start: 0, duration: 0.24 });
				}
				break;
			case "ding":
				beep(audio, master, { frequency: 880, start: 0, duration: 0.18 });
				break;
			case "chime":
				beep(audio, master, { frequency: 880, start: 0, duration: 0.16 });
				beep(audio, master, { frequency: 1174.66, start: 0.16, duration: 0.22 });
				break;
			case "soft":
				beep(audio, master, { frequency: 659.25, start: 0, duration: 0.24 });
				break;
			case "bell":
				// 钟声：基音 + 八度泛音，长衰减
				beep(audio, master, { frequency: 523.25, start: 0, duration: 0.8 });
				beep(audio, master, { frequency: 1046.5, start: 0, duration: 0.5, gain: 0.35 });
				break;
			case "marimba":
				// 三连上行，三角波更"木"
				beep(audio, master, { frequency: 523.25, start: 0, duration: 0.12, type: "triangle" });
				beep(audio, master, { frequency: 659.25, start: 0.1, duration: 0.12, type: "triangle" });
				beep(audio, master, { frequency: 783.99, start: 0.2, duration: 0.18, type: "triangle" });
				break;
			case "pulse":
				// 两记短促脉冲，适合强提醒
				beep(audio, master, { frequency: 660, start: 0, duration: 0.08, type: "triangle" });
				beep(audio, master, { frequency: 660, start: 0.14, duration: 0.08, type: "triangle" });
				break;
			case "drop":
				// 下行双音：与上行 chime 反向，区分度高
				beep(audio, master, { frequency: 880, start: 0, duration: 0.14 });
				beep(audio, master, { frequency: 587.33, start: 0.14, duration: 0.22 });
				break;
		}
	} catch {
		// 静默降级
	}
}
