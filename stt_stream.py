"""stt_stream.py — the ear: ElevenLabs Scribe realtime, one stream per page.

Chrome's SpeechRecognition was the weak link of the voice path: it ends its
own sessions every few seconds, goes deaf with no error (1 270 "DEAF" lines
in one log), and finalises a sentence whenever it pleases. Scribe listens to
raw audio and commits a sentence on its own voice-activity detection, ~0.6 s
after the user stops talking.

The browser captures 16 kHz mono PCM with the browser's echo cancellation on
and sends it here only while there is sound (see frontend/src/listen.ts). The
key never leaves the server. This module opens the Scribe socket on the first
chunk, buffers what arrives during the handshake so the first word is not
lost, and closes it after a quiet spell, so silence costs nothing.

  ear = ScribeStream(api_key, on_text, on_event)
  await ear.feed(b64_pcm)     # 16 kHz s16le mono, base64
  await ear.flush()           # the browser heard the end of speech
  await ear.close()

`on_text(kind, text)` gets kind "partial" or "final".
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Awaitable, Callable, Optional
from urllib.parse import urlencode

import websockets

log = logging.getLogger("jarvis.stt")

SCRIBE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
SAMPLE_RATE = 16000
# Silence that ends a sentence. Shorter cuts people off mid-thought; longer is
# the half-second that makes a voice assistant feel slow.
VAD_SILENCE_SEC = 0.6
# Words Scribe should expect. Each ≤ 20 characters, at most 50.
KEYTERMS = ("Jarvis", "Orbit", "Claude Code", "monsieur")
# A socket nobody has fed for this long is closed; the next sound reopens it.
IDLE_CLOSE_SEC = 45.0
# What may wait for the handshake: 10 s of audio, the rest is dropped oldest
# first. A handshake that slow has failed anyway.
MAX_PENDING = 100

TextCb = Callable[[str, str], Awaitable[None]]
EventCb = Callable[[str], Awaitable[None]]


def scribe_url(language: str = "fr") -> str:
    params = [("model_id", "scribe_v2_realtime"), ("audio_format", "pcm_16000"),
              ("commit_strategy", "vad"), ("language_code", language),
              ("vad_silence_threshold_secs", str(VAD_SILENCE_SEC))]
    params += [("keyterms", k) for k in KEYTERMS]
    return f"{SCRIBE_URL}?{urlencode(params)}"


def chunk_message(b64: str, commit: bool = False) -> str:
    return json.dumps({"message_type": "input_audio_chunk", "audio_base_64": b64,
                       "commit": commit, "sample_rate": SAMPLE_RATE})


class ScribeStream:
    def __init__(self, api_key: str, on_text: TextCb, on_event: EventCb,
                 language: str = "fr", connect=None):
        self.api_key = api_key
        self.on_text = on_text
        self.on_event = on_event
        self.language = language
        self._connect = connect or websockets.connect
        self._ws = None
        self._opening: Optional[asyncio.Task] = None
        self._reader: Optional[asyncio.Task] = None
        self._idle: Optional[asyncio.Task] = None
        self._pending: list[str] = []
        self._last_fed = 0.0
        self._closed = False
        self.failures = 0

    # ── public ──────────────────────────────────────────────────────────

    async def feed(self, b64: str) -> None:
        if self._closed or not b64:
            return
        self._last_fed = time.monotonic()
        msg = chunk_message(b64)
        if self._ws is not None:
            try:
                await self._ws.send(msg)
                return
            except Exception as e:
                await self._lost(f"send failed: {e}")
        self._pending.append(msg)
        if len(self._pending) > MAX_PENDING:
            del self._pending[0]
        if self._opening is None or self._opening.done():
            self._opening = asyncio.create_task(self._open())

    async def flush(self) -> None:
        """Commit now: the browser stopped hearing sound, no need to wait for
        Scribe's own silence detector to agree."""
        if self._ws is None:
            if self._pending:
                self._pending.append(chunk_message("", commit=True))
            return
        try:
            await self._ws.send(chunk_message("", commit=True))
        except Exception as e:
            await self._lost(f"commit failed: {e}")

    async def close(self) -> None:
        self._closed = True
        for task in (self._opening, self._reader, self._idle):
            if task is not None and not task.done() and task is not asyncio.current_task():
                task.cancel()
        await self._shut()

    # ── internals ───────────────────────────────────────────────────────

    async def _open(self) -> None:
        t0 = time.monotonic()
        try:
            ws = await self._connect(scribe_url(self.language),
                                     additional_headers={"xi-api-key": self.api_key},
                                     open_timeout=8, max_size=2**20)
        except Exception as e:
            self.failures += 1
            self._pending.clear()
            await self.on_event(f"stt: could not reach Scribe ({type(e).__name__}: {e})")
            return
        if self._closed:
            await ws.close()
            return
        self.failures = 0
        await self.on_event(f"stt: Scribe connected in {time.monotonic() - t0:.2f}s")
        self._reader = asyncio.create_task(self._read(ws))
        if self._idle is None or self._idle.done():
            self._idle = asyncio.create_task(self._idle_watch())
        # Drain before publishing the socket: chunks fed meanwhile still land
        # in `_pending` and go out behind the older ones, never ahead of them.
        try:
            while self._pending:
                await ws.send(self._pending.pop(0))
        except Exception as e:
            await self.on_event(f"stt: send failed: {e}")
            await ws.close()
            return
        self._ws = ws

    async def _read(self, ws) -> None:
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                kind = msg.get("message_type")
                text = msg.get("text")
                if kind == "partial_transcript" and isinstance(text, str) and text.strip():
                    await self.on_text("partial", text.strip())
                elif kind == "committed_transcript" and isinstance(text, str):
                    if text.strip():
                        await self.on_text("final", text.strip())
                elif kind and kind != "session_started" and "transcript" not in kind:
                    # Every other message type is a problem report: quota,
                    # auth, rate limit, malformed chunk.
                    await self.on_event(f"stt: {kind}: {str(msg.get('error') or msg)[:120]}")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.on_event(f"stt: Scribe stream ended ({type(e).__name__})")
        finally:
            if self._ws is ws:
                self._ws = None

    async def _idle_watch(self) -> None:
        while not self._closed:
            await asyncio.sleep(5)
            if self._ws is not None and time.monotonic() - self._last_fed > IDLE_CLOSE_SEC:
                await self._shut()
                return

    async def _lost(self, why: str) -> None:
        await self.on_event(f"stt: {why}")
        await self._shut()

    async def _shut(self) -> None:
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass
