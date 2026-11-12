"""session_close.py — end a Claude Code conversation from the dashboard.

The Orbit's close button. It stops the `claude` processes of one
conversation with SIGTERM, the signal the CLI handles like Ctrl+C twice:
the transcript is already on disk, so the conversation moves to the history
list and can be reopened with `claude --resume`. Nothing is deleted.

The pids come from the server's snapshot, never from the browser, and each
one is checked to still be a `claude` process before it is signalled: a pid
the roster remembers may have been reused by something else since.
"""
from __future__ import annotations

import os
import signal
import subprocess

CLOSED = "closed"
NOTHING = "nothing"     # no process left to stop: it had already ended
FAILED = "failed"


def _command(pid: int) -> str:
    try:
        out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip()


def is_claude(command: str) -> bool:
    """`claude …`, `/…/claude …` or `node …/claude …`: the CLI, whatever
    installed it. Anything else under that pid is not ours to stop."""
    exe = command.split(" --", 1)[0].split(" -p", 1)[0].strip()
    return (os.path.basename(exe) == "claude"
            or "/.local/share/claude/versions/" in exe   # background sessions
            or "/claude-code/" in exe                    # the desktop app's copy
            or exe.endswith("/claude/cli.js"))


def close(pids: list[int], *, command=_command, kill=os.kill) -> str:
    stopped = failed = 0
    for pid in pids:
        if not isinstance(pid, int) or pid <= 0 or pid == os.getpid():
            continue
        if not is_claude(command(pid)):
            continue
        try:
            kill(pid, signal.SIGTERM)
            stopped += 1
        except ProcessLookupError:
            pass
        except OSError:
            failed += 1
    if stopped:
        return CLOSED
    return FAILED if failed else NOTHING
