"""stt_stream: the Scribe socket opens on demand, keeps chunk order across the
handshake, and turns Scribe's messages into partial / final text."""

import asyncio
import json
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import stt_stream  # noqa: E402


class FakeWS:
    def __init__(self, replies=()):
        self.sent: list[dict] = []
        self.inbox: asyncio.Queue = asyncio.Queue()
        for r in replies:
            self.inbox.put_nowait(json.dumps(r))
        self.closed = False

    async def send(self, msg):
        self.sent.append(json.loads(msg))

    async def close(self):
        self.closed = True
        self.inbox.put_nowait(None)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item


def make(ws, gate=None):
    texts, events, calls = [], [], []

    async def on_text(kind, text):
        texts.append((kind, text))

    async def on_event(e):
        events.append(e)

    async def connect(url, **kw):
        calls.append((url, kw))
        if gate is not None:
            await gate.wait()
        return ws

    return stt_stream.ScribeStream("key", on_text, on_event, connect=connect), texts, events, calls


def test_url_asks_for_french_vad_and_keyterms():
    q = parse_qs(urlparse(stt_stream.scribe_url()).query)
    assert q["model_id"] == ["scribe_v2_realtime"]
    assert q["commit_strategy"] == ["vad"]
    assert q["language_code"] == ["fr"]
    assert "Jarvis" in q["keyterms"]
    assert all(len(k) <= 20 for k in stt_stream.KEYTERMS)


@pytest.mark.asyncio
async def test_chunks_fed_during_handshake_go_out_in_order():
    ws, gate = FakeWS(), asyncio.Event()
    ear, _, _, calls = make(ws, gate)
    for i in range(3):
        await ear.feed(f"c{i}")
    await asyncio.sleep(0)
    assert len(calls) == 1                       # one handshake, not three
    gate.set()
    await asyncio.sleep(0.01)
    await ear.feed("c3")
    assert [m["audio_base_64"] for m in ws.sent] == ["c0", "c1", "c2", "c3"]
    assert calls[0][1]["additional_headers"] == {"xi-api-key": "key"}
    await ear.close()


@pytest.mark.asyncio
async def test_partials_and_commits_become_text():
    ws = FakeWS([{"message_type": "session_started"},
                 {"message_type": "partial_transcript", "text": "Jarvis, ouvre"},
                 {"message_type": "partial_transcript", "text": "  "},
                 {"message_type": "committed_transcript", "text": "Jarvis, ouvre Orbit."},
                 {"message_type": "committed_transcript", "text": ""},
                 {"message_type": "quota_exceeded", "error": "out of credits"}])
    ear, texts, events, _ = make(ws)
    await ear.feed("c0")
    await asyncio.sleep(0.02)
    assert texts == [("partial", "Jarvis, ouvre"), ("final", "Jarvis, ouvre Orbit.")]
    assert any("quota_exceeded" in e for e in events)
    await ear.close()


@pytest.mark.asyncio
async def test_flush_sends_an_empty_commit():
    ws = FakeWS()
    ear, *_ = make(ws)
    await ear.feed("c0")
    await asyncio.sleep(0.01)
    await ear.flush()
    assert ws.sent[-1] == {"message_type": "input_audio_chunk", "audio_base_64": "",
                           "commit": True, "sample_rate": 16000}
    await ear.close()


@pytest.mark.asyncio
async def test_a_failed_handshake_is_reported_and_retried_on_next_sound():
    texts, events, attempts = [], [], []

    async def on_text(k, t):
        texts.append(t)

    async def on_event(e):
        events.append(e)

    async def connect(url, **kw):
        attempts.append(1)
        raise OSError("offline")

    ear = stt_stream.ScribeStream("key", on_text, on_event, connect=connect)
    await ear.feed("c0")
    await asyncio.sleep(0.01)
    assert ear.failures == 1 and "could not reach Scribe" in events[-1]
    await ear.feed("c1")
    await asyncio.sleep(0.01)
    assert len(attempts) == 2 and ear.failures == 2
    await ear.close()
