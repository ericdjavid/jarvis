/**
 * The streaming ear: raw microphone audio to the server, which hands it to
 * ElevenLabs Scribe (stt_stream.py) and sends the words back.
 *
 * It replaces Chrome's SpeechRecognition, which rotated sessions every few
 * seconds and went deaf without an error. Two things change for the user:
 *   - the capture runs with the browser's echo cancellation, so his own voice
 *     is mostly removed before it is transcribed and the user can talk over
 *     him; the server's echo rules still have the last word;
 *   - a sentence ends on Scribe's silence detector (~0.6 s), not whenever
 *     Chrome decides to finalise.
 *
 * Audio is only sent while there is sound: a level gate with half a second
 * of pre-roll, so the first syllable is never clipped and silence costs
 * nothing.
 */

import type { VoiceInput } from "./voice";

const TARGET_RATE = 16000;
const BLOCK_MS = 100;
// RMS of a 100 ms block, after the browser's noise suppression and gain
// control, above which it is someone talking rather than the room.
const OPEN_LEVEL = 0.012;
// Blocks kept from before the gate opened: the start of the first word.
const PREROLL_BLOCKS = 5;
// How long the gate stays open after the last loud block. Longer than
// Scribe's own 0.6 s silence threshold, so Scribe commits on its own VAD.
const HANG_MS = 1500;

// The worklet only copies the microphone's frames out to the main thread.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("jarvis-tap", Tap);
`;

export interface StreamingInput extends VoiceInput {
  /** A `stt` frame from the server: Scribe's partial or committed text. */
  handle(kind: string, text: string): void;
}

function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function createStreamingVoiceInput(
  send: (msg: Record<string, unknown>) => void,
  onTranscript: (text: string) => void,
  onInterim: (text: string) => void,
  onError: (msg: string) => void,
  onMicEvent: (event: string) => void = () => {},
): StreamingInput {
  let running = false;
  let paused = false;
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;

  // Resampling state: input frames averaged down to 16 kHz.
  let ratio = 1;
  let acc = 0;
  let accN = 0;
  let pos = 0;
  const blockLen = (TARGET_RATE * BLOCK_MS) / 1000;
  let block = new Float32Array(blockLen);
  let filled = 0;

  // Gate state.
  const preroll: Int16Array[] = [];
  let open = false;
  let lastLoudAt = 0;

  function emitBlock(samples: Float32Array) {
    let sum = 0;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      sum += v * v;
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    if (paused) { open = false; preroll.length = 0; return; }
    const rms = Math.sqrt(sum / samples.length);
    const now = Date.now();
    if (rms > OPEN_LEVEL) lastLoudAt = now;

    if (!open && rms > OPEN_LEVEL) {
      open = true;
      for (const p of preroll) send({ type: "audio_in", data: toBase64(p) });
      preroll.length = 0;
    }
    if (open) {
      send({ type: "audio_in", data: toBase64(pcm) });
      if (now - lastLoudAt > HANG_MS) {
        open = false;
        send({ type: "audio_end" });
      }
    } else {
      preroll.push(pcm);
      if (preroll.length > PREROLL_BLOCKS) preroll.shift();
    }
  }

  function onFrame(frame: Float32Array) {
    for (let i = 0; i < frame.length; i++) {
      acc += frame[i];
      accN++;
      pos += 1;
      if (pos >= ratio) {
        pos -= ratio;
        block[filled++] = acc / accN;
        acc = 0;
        accN = 0;
        if (filled === blockLen) {
          emitBlock(block);
          block = new Float32Array(blockLen);
          filled = 0;
        }
      }
    }
  }

  async function open_() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      ctx = new AudioContext();
      ratio = ctx.sampleRate / TARGET_RATE;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "jarvis-tap");
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
      ctx.createMediaStreamSource(stream).connect(node);
      // A worklet only runs while connected to the graph; a muted gain keeps
      // it running without sending the microphone to the speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      if (ctx.state === "suspended") void ctx.resume();
      onMicEvent(`streaming ear attached (${ctx.sampleRate} Hz -> 16 kHz, echo cancellation on)`);
    } catch (e) {
      onError("Micro inaccessible");
      onMicEvent(`streaming ear could not open the microphone: ${(e as Error)?.name}`);
    }
  }

  function close_() {
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    stream = null;
    ctx = null;
    if (open) send({ type: "audio_end" });
    open = false;
  }

  // An AudioContext created before any gesture starts suspended.
  document.addEventListener("click", () => { if (ctx?.state === "suspended") void ctx.resume(); });

  return {
    start() { if (!running) { running = true; void open_(); } },
    stop() { running = false; close_(); },
    pause() {
      if (!paused && open) send({ type: "audio_end" });
      paused = true;
    },
    resume() { paused = false; },
    restart(reason: string) {
      onMicEvent(`streaming ear restart: ${reason}`);
      close_();
      if (running) void open_();
    },
    handle(kind: string, text: string) {
      if (!text) return;
      if (kind === "final") onTranscript(text);
      else onInterim(text);
    },
  };
}
