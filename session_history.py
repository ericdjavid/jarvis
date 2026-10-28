"""The conversations that are no longer running, newest first.

The Orbit only shows what is alive. A window closed by mistake, or work the
user wants to pick up again, is still a transcript on disk, and
`claude --resume <id>` in its directory brings it back. This module finds
those transcripts; the reopening is `actions.open_warp_resume`.

Only interactive conversations count (`entrypoint: cli`): JARVIS's own brain
and its unattended runs are `claude -p` and nothing anyone would reopen.
Every field is read off the transcript's tail, the same way `session_watch`
does, so a multi-megabyte conversation costs 64 KB.
"""

from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import session_watch

DEFAULT_LIMIT = 15
# How far down the mtime-sorted list to look before giving up: most recent
# files are runs and subagents, which are skipped.
MAX_SCANNED = 400


@dataclass
class ClosedSession:
    session_id: str
    name: str | None        # what /rename set, if anything
    title: str | None       # Claude Code's own title for it
    last_prompt: str | None
    cwd: str
    project: str
    ended: float            # transcript mtime, epoch seconds


def _transcripts(roots: list[Path]) -> list[tuple[float, Path]]:
    found: list[tuple[float, Path]] = []
    for root in roots:
        # One level only: subagent transcripts live a level deeper.
        for path in (Path(root) / "projects").glob("*/*.jsonl"):
            try:
                found.append((path.stat().st_mtime, path))
            except OSError:
                continue
    found.sort(key=lambda t: t[0], reverse=True)
    return found


def _read(path: Path, mtime: float) -> ClosedSession | None:
    name = title = prompt = cwd = None
    interactive = False
    for o in session_watch.tail_objects(path):
        kind = o.get("type")
        if kind == "custom-title":
            name = session_watch._clip(o.get("customTitle"), 80) or name
        elif kind == "ai-title":
            title = session_watch._clip(o.get("aiTitle"), 200) or title
        elif kind == "last-prompt":
            prompt = session_watch._clip(o.get("lastPrompt")) or prompt
        if o.get("entrypoint") == "cli":
            interactive = True
        if isinstance(o.get("cwd"), str):
            cwd = o["cwd"]
    if not interactive or not cwd or not (title or prompt):
        return None
    return ClosedSession(session_id=path.stem, name=name, title=title,
                         last_prompt=prompt, cwd=cwd,
                         project=session_watch.project_name(cwd), ended=mtime)


def recent_closed(live_ids: set[str], limit: int = DEFAULT_LIMIT,
                  roots: list[Path] | None = None) -> list[ClosedSession]:
    """The `limit` most recent conversations not in `live_ids`."""
    seen: set[str] = set()
    out: list[ClosedSession] = []
    for mtime, path in _transcripts(roots or session_watch.config_roots())[:MAX_SCANNED]:
        sid = path.stem
        if sid in seen or sid in live_ids:
            continue
        seen.add(sid)      # the roots are hardlinked: one conversation, two paths
        item = _read(path, mtime)
        if item is None or item.cwd == session_watch.brain_cwd():
            continue
        out.append(item)
        if len(out) >= limit:
            break
    return out


def find(session_id: str, live_ids: set[str]) -> ClosedSession | None:
    """A closed conversation by id, only from the history itself, so the
    browser can never name an arbitrary file or directory to resume in."""
    for item in recent_closed(live_ids, limit=MAX_SCANNED):
        if item.session_id == session_id:
            return item if os.path.isdir(item.cwd) else None
    return None


# Words said around a name that pick out nothing: "rouvre la session sponsor".
_FILLER = frozenset({
    "la", "le", "les", "l", "de", "du", "des", "d", "sur", "session",
    "sessions", "conversation", "fenetre", "projet", "the", "a", "my", "ma",
    "mon", "celle", "qu", "on", "a", "fermee", "ferme", "recemment",
})


def _words(text: str | None) -> list[str]:
    flat = unicodedata.normalize("NFKD", (text or "").lower())
    flat = "".join(c for c in flat if not unicodedata.combining(c))
    return [w for w in re.split(r"[^a-z0-9]+", flat) if w]


def _hits(query: list[str], text: str | None) -> bool:
    """Every query word starts a word of the text: "sponsor" finds SPONSORS."""
    words = _words(text)
    return bool(query) and all(any(w.startswith(q) for w in words) for q in query)


def match(query: str, live_ids: set[str],
          roots: list[Path] | None = None) -> list[ClosedSession]:
    """The closed conversations a spoken reference means, newest first.

    A name the user gave (/rename, `claude -n`) wins over a title or a
    project, so "sponsor" is the SPONSORS session and not every conversation
    that once mentioned sponsors."""
    words = [w for w in _words(query) if w not in _FILLER]
    if not words:
        return []
    items = recent_closed(live_ids, limit=MAX_SCANNED, roots=roots)
    by_name = [i for i in items if _hits(words, i.name)]
    if by_name:
        return by_name
    return [i for i in items if _hits(words, i.title) or _hits(words, i.project)]


def to_dict(s: ClosedSession) -> dict:
    return {"session_id": s.session_id, "name": s.name, "title": s.title,
            "last_prompt": s.last_prompt, "cwd": s.cwd, "project": s.project,
            "ended": s.ended}
