"""session_close: only `claude` processes are signalled, and only with SIGTERM."""
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import session_close  # noqa: E402


def run(pids, commands, errors=None):
    sent = []

    def kill(pid, sig):
        if errors and pid in errors:
            raise errors[pid]
        sent.append((pid, sig))

    out = session_close.close(pids, command=lambda p: commands.get(p, ""), kill=kill)
    return out, sent


def test_claude_processes_get_sigterm():
    out, sent = run([11, 12], {11: "claude --resume abc", 12: "/Users/x/.local/bin/claude"})
    assert out == session_close.CLOSED
    assert sent == [(11, signal.SIGTERM), (12, signal.SIGTERM)]


def test_a_reused_pid_is_left_alone():
    out, sent = run([11], {11: "/usr/bin/python3 server.py"})
    assert out == session_close.NOTHING and sent == []


def test_gone_and_bad_pids():
    out, sent = run([0, -1, 13], {13: "claude"}, errors={13: ProcessLookupError()})
    assert out == session_close.NOTHING and sent == []
    out, _ = run([14], {14: "claude"}, errors={14: PermissionError()})
    assert out == session_close.FAILED


def test_is_claude():
    assert session_close.is_claude("node /opt/lib/node_modules/@anthropic-ai/claude/cli.js")
    assert session_close.is_claude("/Users/x/.local/share/claude/versions/2.1.322 --session-id 1")
    assert session_close.is_claude("/Users/x/Library/Application Support/Claude/claude-code/2.1.321/ab/claude --x")
    assert session_close.is_claude("claude --resume abc")
    assert not session_close.is_claude("vim claude.md")
    assert not session_close.is_claude("/Applications/Claude.app/Contents/MacOS/Claude")
