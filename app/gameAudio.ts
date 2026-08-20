"use client";

let audioContext: AudioContext | null = null;
let enabledCache: boolean | null = null;

export function isSoundEnabled() {
  if (enabledCache !== null) return enabledCache;
  enabledCache = typeof window === "undefined" ? true : window.localStorage.getItem("futesenai-sound") !== "off";
  return enabledCache;
}

export async function unlockAudio() {
  if (!isSoundEnabled() || typeof window === "undefined") return;
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
}

export function setSoundEnabled(enabled: boolean) {
  enabledCache = enabled;
  if (typeof window !== "undefined") window.localStorage.setItem("futesenai-sound", enabled ? "on" : "off");
  if (enabled) { void unlockAudio().then(playMenu); }
}

function tone(frequency: number, duration: number, options: { delay?: number; endFrequency?: number; gain?: number; type?: OscillatorType } = {}) {
  if (!isSoundEnabled() || !audioContext || audioContext.state !== "running") return;
  const start = audioContext.currentTime + (options.delay ?? 0);
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = options.type ?? "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  if (options.endFrequency) oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, start + duration);
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.gain ?? .06, start + .012);
  gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(start); oscillator.stop(start + duration + .02);
}

export function playMenu() { tone(520, .08, { gain: .035 }); }
export function playKick() { tone(145, .09, { endFrequency: 62, gain: .09, type: "triangle" }); }
export function playWhistle() { tone(1180, .14, { gain: .045 }); tone(1480, .22, { delay: .16, gain: .05 }); }
export function playGoal() {
  tone(330, .18, { gain: .06, type: "square" }); tone(440, .18, { delay: .13, gain: .055, type: "square" }); tone(660, .34, { delay: .26, gain: .06, type: "square" });
}
export function playCorrect() { tone(440, .12, { gain: .045 }); tone(660, .2, { delay: .11, gain: .055 }); }
export function playWrong() { tone(260, .14, { endFrequency: 145, gain: .045, type: "sawtooth" }); }
export function playAdvance() { tone(392, .12, { gain: .04 }); tone(523, .13, { delay: .1, gain: .045 }); tone(659, .2, { delay: .2, gain: .05 }); }
export function playChampion() {
  [523, 659, 784, 1047].forEach((frequency, index) => tone(frequency, .32, { delay: index * .14, gain: .055, type: "triangle" }));
}
