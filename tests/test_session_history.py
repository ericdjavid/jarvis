"""session_history: closed interactive conversations, newest first."""

import json
import os

import session_history


def _write(root, cwd, sid, lines, mtime):
    d = root / "projects" / cwd.replace("/", "-")
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{sid}.jsonl"
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    os.utime(path, (mtime, mtime))
    return path


def _chat(cwd, entry="cli", name=None, prompt="fais ça"):
    lines = [{"type": "user", "entrypoint": entry, "cwd": cwd},
             {"type": "ai-title", "aiTitle": "Un sujet"},
             {"type": "last-prompt", "lastPrompt": prompt}]
    if name:
        lines.append({"type": "custom-title", "customTitle": name})
    return lines


def test_lists_closed_interactive_sessions_newest_first(tmp_path):
    cwd = str(tmp_path / "proj")
    os.mkdir(cwd)
    _write(tmp_path, cwd, "old", _chat(cwd, name="VIEILLE"), 1000)
    _write(tmp_path, cwd, "new", _chat(cwd), 2000)
    _write(tmp_path, cwd, "live", _chat(cwd), 3000)
    _write(tmp_path, cwd, "run", _chat(cwd, entry="sdk-cli"), 4000)

    rows = session_history.recent_closed({"live"}, roots=[tmp_path])

    assert [r.session_id for r in rows] == ["new", "old"]
    assert rows[1].name == "VIEILLE"
    assert rows[0].title == "Un sujet" and rows[0].cwd == cwd


def test_hardlinked_roots_count_once(tmp_path):
    cwd = str(tmp_path / "proj")
    a, b = tmp_path / "a", tmp_path / "b"
    _write(a, cwd, "same", _chat(cwd), 1000)
    _write(b, cwd, "same", _chat(cwd), 1000)
    rows = session_history.recent_closed(set(), roots=[a, b])
    assert [r.session_id for r in rows] == ["same"]


def test_limit(tmp_path):
    cwd = str(tmp_path / "proj")
    for i in range(5):
        _write(tmp_path, cwd, f"s{i}", _chat(cwd), 1000 + i)
    assert len(session_history.recent_closed(set(), limit=3, roots=[tmp_path])) == 3


def test_a_spoken_reference_finds_the_named_session_first(tmp_path):
    cwd = str(tmp_path / "proj")
    _write(tmp_path, cwd, "named", _chat(cwd, name="SPONSORS"), 1000)
    lines = _chat(cwd)
    lines[1]["aiTitle"] = "Relance des sponsors"
    _write(tmp_path, cwd, "titled", lines, 2000)

    rows = session_history.match("la session sponsor", set(), roots=[tmp_path])

    assert [r.session_id for r in rows] == ["named"]


def test_without_a_named_match_titles_and_accents_count(tmp_path):
    cwd = str(tmp_path / "proj")
    lines = _chat(cwd)
    lines[1]["aiTitle"] = "Soirées Halloween à Valencia"
    _write(tmp_path, cwd, "valencia", lines, 1000)

    assert [r.session_id for r in session_history.match(
        "soirees valencia", set(), roots=[tmp_path])] == ["valencia"]
    assert session_history.match("la session", set(), roots=[tmp_path]) == []
