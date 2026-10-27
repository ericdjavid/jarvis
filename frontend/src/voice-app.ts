/**
 * The voice loop (mic -> server -> speaker), shared by the orb page and the
 * dashboard so JARVIS lives in one window, not two.
 *
 * Wake word: by default nothing reaches the server until a phrase contains
 * "Jarvis". Other apps that talk or dictate (calls, Wispr Flow) used to feed
 * him everything the microphone picked up. Once woken he stays awake for a
 * short follow-up window, renewed every time he answers.
 */

import { createVoiceInput, createAudioPlayer, createMicMonitor } from "./voice";
import { createSocket } from "./ws";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "compacting";
export type MicMode = "wake" | "open" | "off";

export interface VoiceHooks {
  onState?(state: VoiceState): void;
  onStatus?(text: string): void;
  onError?(text: string): void;
  onLevel?(level: number): void;
  onMode?(mode: MicMode, awake: boolean): void;
}

export interface VoiceApp {
  analyser: AnalyserNode;
  hush(): void;
  /** Click on the reactor: listen now, whatever the mode, as if he heard "Jarvis". */
  wakeUp(): void;
  setMode(mode: MicMode): void;
  mode(): MicMode;
  state(): VoiceState;
}

// No word boundaries: Chrome glues "dis Jarvis" into "dijarvis" or "disjarvis",
// and French ears write him "jervis", "djarvis" or "gervis".
const WAKE = /(j|dj|g)[ae]r ?v[iy]|jarvi|chavis|harvis/i;
// Through speakers the mic hears all of him, and his own sentences came back
// as the user's. So while he talks (and just after) only a stop word gets out.
const STOP = /(stop|arr[eê]te|tais[- ]?toi|chut|silence|attends|annule|cancel)\W*$/i;
const ECHO_TAIL_MS = 1500;
const AWAKE_MS = 20_000;
const MODE_KEY = "jarvis.micMode";

function loadMode(): MicMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "wake" || m === "open" || m === "off") return m;
  } catch { /* storage blocked: default */ }
  return "wake";
}

export function startVoice(hooks: VoiceHooks = {}): VoiceApp {
  let current: VoiceState = "idle";
  let mode: MicMode = loadMode();
  let awakeUntil = 0;
  let muteMicDuringSpeech = false;
  let quietSince = 0;                 // when his voice last stopped
  // The server says "idle" once it has SENT the audio; the speaker may still be
  // playing it for seconds. So "is he audible" is asked of the player itself.
  const hearingHim = () => current === "speaking" || audioPlayer.playing()
    || Date.now() - quietSince < ECHO_TAIL_MS;
  /** While he is audible: a trailing stop word cuts him off, all else is him. */
  function stopWordOnly(text: string, isFinal: boolean): boolean {
    if (!hearingHim()) return false;
    const m = text.match(STOP);
    if (m) {
      hush();
      // The word itself still goes up: a steer's cancel window listens for it.
      if (isFinal || current !== "speaking") socket.send({ type: "transcript", text: m[1], isFinal: true });
    }
    return true;
  }

  const wsProto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = createSocket(`${wsProto}//${window.location.host}/ws/voice`);
  const audioPlayer = createAudioPlayer();

  const awake = () => mode === "open" || Date.now() < awakeUntil;
  const wake = () => {
    const was = awake();
    awakeUntil = Date.now() + AWAKE_MS;
    if (!was) hooks.onMode?.(mode, true);
  };
  // With the mic off, a click still opens a window; outside it he rests.
  const rest = (): VoiceState => (mode === "off" && !awake() ? "idle" : "listening");
  // Dozing off is noticed lazily; a light timer keeps the indicator honest.
  let lastAwake = false;
  setInterval(() => {
    const now = awake();
    if (now === lastAwake) return;
    lastAwake = now;
    if (!now && mode === "off" && current === "listening") { voiceInput.pause(); transition("idle"); }
    hooks.onMode?.(mode, now);
  }, 500);

  /** Pass a phrase to the server only when he is awake or it wakes him. */
  // Why "dis Jarvis" failed is only visible in what Chrome wrote down.
  let lastIgnored = 0;
  function logIgnored(text: string) {
    if (Date.now() - lastIgnored < 3000) return;
    lastIgnored = Date.now();
    socket.send({ type: "mic", text: `ignored interim (no wake word): ${text.slice(0, 60)}` });
  }

  function admit(text: string): boolean {
    if (awake()) { if (mode !== "open") wake(); return true; }
    if (mode === "off") return false;
    if (WAKE.test(text)) { wake(); return true; }
    return false;
  }

  function transition(next: VoiceState) {
    if (next === current) return;
    if (current === "speaking") quietSince = Date.now();
    current = next;
    hooks.onState?.(next);
    if (next === "thinking" || next === "speaking") {
      if (mode === "wake" || (mode === "off" && awakeUntil > 0)) wake();
    } else if (next === "listening" && mode !== "open" && awakeUntil > 0) {
      wake();                       // follow-up window after each answer
    }
    if (mode === "off" && !awake()) return;
    if (next === "speaking" && muteMicDuringSpeech) voiceInput.pause();
    else voiceInput.resume();
  }

  const voiceInput = createVoiceInput(
    (text: string) => {
      micMonitor.sawSpeech();
      if (stopWordOnly(text, true)) return;
      if (admit(text)) socket.send({ type: "transcript", text, isFinal: true });
      else if (mode === "wake") socket.send({ type: "mic", text: `ignored (no wake word): ${text.slice(0, 60)}` });
    },
    (text: string) => {
      micMonitor.sawSpeech();
      if (stopWordOnly(text, false)) return;
      if (admit(text)) socket.send({ type: "interim", text });
      else if (mode === "wake" && text.length > 12) logIgnored(text);
    },
    (msg: string) => hooks.onError?.(msg),
    (event: string) => socket.send({ type: "mic", text: event }),
  );

  const micMonitor = createMicMonitor(
    (level: number) => hooks.onLevel?.(level),
    (event: string) => {
      socket.send({ type: "mic", text: event });
      if (event.startsWith("DEAF")) voiceInput.restart("deaf: audio in, no results");
    },
  );

  function hush() {
    if (current !== "speaking" && !audioPlayer.playing()) return;
    audioPlayer.stop();
    socket.send({ type: "hush" });
    transition(rest());
  }

  audioPlayer.onPlayed((utt, idx) => socket.send({ type: "played", utt, idx }));
  audioPlayer.onFinished(() => { quietSince = Date.now(); });
  audioPlayer.onNeedsGesture(() => hooks.onError?.("Clique n'importe où pour activer le son"));

  socket.onMessage((msg) => {
    const type = msg.type as string;
    if (type === "config") {
      muteMicDuringSpeech = Boolean(msg.muteMicDuringSpeech);
    } else if (type === "audio") {
      const data = msg.data as string;
      if (data) {
        if (current !== "speaking") transition("speaking");
        audioPlayer.enqueue(data, Number(msg.utt), Number(msg.idx));
      }
    } else if (type === "stop") {
      audioPlayer.stop();
      transition(rest());
    } else if (type === "drop_queued") {
      audioPlayer.dropQueued();
    } else if (type === "status") {
      const s = msg.state as string;
      if (s === "thinking") transition("thinking");
      else if (s === "speaking") transition("speaking");
      else if (s === "compacting") transition("compacting");
      else if (s === "idle") transition(rest());
    } else if (type === "text") {
      hooks.onStatus?.(String(msg.text));
    } else if (type === "notice") {
      hooks.onStatus?.(String(msg.text ?? ""));
    }
  });

  function wakeUp() {
    if (current === "speaking") hush();
    wake();
    voiceInput.resume();
    if (current === "idle") transition("listening");
    hooks.onMode?.(mode, true);
  }

  function setMode(next: MicMode) {
    mode = next;
    awakeUntil = 0;
    try { localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer nicety only */ }
    if (next === "off") { voiceInput.pause(); transition("idle"); }
    else { voiceInput.resume(); transition("listening"); }
    hooks.onMode?.(mode, awake());
  }

  setTimeout(() => {
    voiceInput.start();
    if (mode === "off") voiceInput.pause();
    else if (current !== "speaking") transition("listening");
    hooks.onMode?.(mode, awake());
  }, 1000);

  const ensureAudio = () => {
    const ctx = audioPlayer.getAnalyser().context as AudioContext;
    if (ctx.state === "suspended") void ctx.resume();
  };
  document.addEventListener("click", ensureAudio);
  document.addEventListener("keydown", ensureAudio, { once: true });
  ensureAudio();

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); hush(); }
  });

  return {
    analyser: audioPlayer.getAnalyser(),
    hush,
    wakeUp,
    setMode,
    mode: () => mode,
    state: () => current,
  };
}
