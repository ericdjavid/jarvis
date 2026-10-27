// frontend/src/dashboard/voice-hud.ts
//
// JARVIS's voice inside the dashboard: one window instead of the orb page
// plus this one. A small dock at the bottom: microphone mode, live level,
// what he is doing, and Stop while he talks. All text via textContent.
import { startVoice, type MicMode, type VoiceState } from "../voice-app";

const MODE_LABEL: Record<MicMode, string> = {
  wake: "Dis « Jarvis »",
  open: "Écoute tout",
  off: "Micro coupé",
};
const MODE_NEXT: Record<MicMode, MicMode> = { wake: "open", open: "off", off: "wake" };
const STATE_LABEL: Record<VoiceState, string> = {
  idle: "",
  listening: "",
  thinking: "Je réfléchis…",
  speaking: "Je parle",
  compacting: "Je range ma mémoire…",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text) n.textContent = text;
  return n;
}

/**
 * Chrome lets one page at a time run speech recognition: two JARVIS tabs
 * abort each other's engine many times a second and neither hears a word.
 * A Web Lock makes the first tab the only voice; the others wait quietly
 * and take over the moment it closes.
 */
export function initVoiceHud(): void {
  if (!navigator.locks) { startHud(); return; }
  const waiting = el("div", "voice-dock", "Jarvis écoute déjà dans un autre onglet");
  waiting.dataset.mode = "off";
  document.body.append(waiting);
  void navigator.locks.request("jarvis-voice", () => {
    waiting.remove();
    startHud();
    return new Promise<void>(() => {});   // held for the life of the tab
  });
}

function startHud(): void {
  const dock = el("div", "voice-dock");
  const modeBtn = el("button", "voice-mode");
  modeBtn.type = "button";
  modeBtn.title = "Mode du micro (touche J)";
  const level = el("span", "voice-level");
  const status = el("span", "voice-status");
  const stop = el("button", "voice-stop", "Stop");
  stop.type = "button";
  stop.title = "Le faire taire (Échap)";
  stop.hidden = true;
  dock.append(modeBtn, level, status, stop);
  document.body.append(dock);

  let errTimer = 0;
  const voice = startVoice({
    onState(s) {
      dock.dataset.state = s;
      dispatchEvent(new CustomEvent("jarvis:state", { detail: s }));
      stop.hidden = s !== "speaking";
      status.textContent = STATE_LABEL[s];
    },
    onStatus(text) { status.textContent = text; },
    onError(text) {
      status.textContent = text;
      window.clearTimeout(errTimer);
      errTimer = window.setTimeout(() => { status.textContent = ""; }, 5000);
    },
    onLevel(l) {
      level.style.setProperty("--level", String(Math.min(1, l * 9)));
    },
    onMode(mode, awake) {
      dock.dataset.mode = mode;
      dock.classList.toggle("is-awake", awake);
      modeBtn.textContent = mode !== "open" && awake ? "Je t'écoute" : MODE_LABEL[mode];
      dispatchEvent(new CustomEvent("jarvis:awake", { detail: awake }));
    },
  });

  modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    voice.setMode(MODE_NEXT[voice.mode()]);
  });
  stop.addEventListener("click", () => voice.hush());
  // The reactor in the middle of Orbit is his face: clicking it means "I'm talking to you".
  addEventListener("jarvis:wake", () => voice.wakeUp());
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "j" || e.key === "J") voice.setMode(MODE_NEXT[voice.mode()]);
  });
}
