"""Bring the window a Claude Code session runs in to the front.

The dashboard's "take me there": click a session, land in its terminal.
Unlike `dialog.py` this never types anything, so the worst a wrong match can
do is raise the wrong window. The rules still follow dialog.py's:

**1. The target is found by tty.** A session's pid maps to a tty
(`ps -o tty=`). Terminal.app publishes the tty of every tab, so that path is
an exact pid -> tty -> tab identity (reusing `dialog.find_terminal_tab`).

**2. Warp publishes nothing**, not even over AppleScript. So the tty is used
to WRITE instead of read: an OSC 0 title sequence carrying a marker unique to
this pid goes to the session's tty, Warp shows it as that window's title, and
System Events raises the one window whose title contains the marker. The
title is handed back to the session's own name right after. A session in a
background Warp TAB does not put its title on the window, so it is
`not_found`, never a guess: there is no "raise the front Warp window" fallback.

**3. Nothing here raises.** Every path returns an outcome string.

Needs Accessibility + Automation (System Events) for the process running
JARVIS, the same grant `dialog.py` already asks for.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess

import dialog

log = logging.getLogger("jarvis.window_focus")

# --- outcomes ---------------------------------------------------------------
FOCUSED = "focused"
NO_TTY = dialog.NO_TTY
NOT_FOUND = dialog.NOT_FOUND
NOT_PERMITTED = dialog.NOT_PERMITTED
FAILED = dialog.FAILED

WARP_BUNDLE_ID = "dev.warp.Warp-Stable"

# How long Warp needs to repaint a window title after the OSC lands, measured
# on this machine to be well under this. Too short and System Events still
# sees the old title; the cost of too long is a click that feels slow.
TITLE_SETTLE_SEC = 0.18
RAISE_TIMEOUT = 6.0


def _app_running(bundle_id: str) -> bool:
    """pgrep-free and launch-free: `lsappinfo` reads the running-app table
    without `tell application`, which would LAUNCH the app."""
    if shutil.which("lsappinfo") is None:
        return False
    try:
        out = subprocess.run(["lsappinfo", "find", f"bundleid={bundle_id}"],
                             capture_output=True, text=True, timeout=1.0)
    except Exception:
        return False
    return bool(out.stdout.strip())


def _marker(pid: int) -> str:
    return f"JARVIS-FOCUS-{pid}"


def _write_title(tty: str, title: str) -> bool:
    """OSC 0 on the session's tty. Control characters are stripped from the
    title: it is a roster name, but it goes straight into a terminal."""
    safe = "".join(ch for ch in title if ch.isprintable())[:120]
    try:
        fd = os.open(tty, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        log.warning(f"cannot open {tty} to retitle it: {e}")
        return False
    try:
        os.write(fd, f"\x1b]0;{safe}\x07".encode("utf-8"))
        return True
    except OSError as e:
        log.warning(f"cannot write title to {tty}: {e}")
        return False
    finally:
        os.close(fd)


def _raise_warp_script(needle: str) -> str:
    # The needle is a fixed ASCII marker built from an int, so quoting it is
    # belt and braces, not a sanitiser.
    quoted = needle.replace("\\", "").replace('"', "")
    return f'''
tell application "System Events"
    set warp to first application process whose bundle identifier is "{WARP_BUNDLE_ID}"
    repeat with w in windows of warp
        if name of w contains "{quoted}" then
            perform action "AXRaise" of w
            set frontmost of warp to true
            return "raised"
        end if
    end repeat
    return "missing"
end tell
'''


async def _focus_warp(pid: int, tty: str, name: str) -> str:
    marker = _marker(pid)
    if not await asyncio.to_thread(_write_title, tty, marker):
        return FAILED
    await asyncio.sleep(TITLE_SETTLE_SEC)
    try:
        code, out, err = await dialog._osascript(_raise_warp_script(marker),
                                                 RAISE_TIMEOUT)
    finally:
        await asyncio.to_thread(_write_title, tty, name or "claude")
    if code != 0:
        if dialog._is_permission_error(err):
            return NOT_PERMITTED
        log.warning(f"warp raise for pid {pid} failed: {err.strip()}")
        return FAILED
    return FOCUSED if out.strip() == "raised" else NOT_FOUND


def _raise_terminal_script(tab: "dialog.TerminalTab") -> str:
    return f'''
tell application "Terminal"
    set w to window id {int(tab.window_id)}
    set selected of tab {int(tab.tab_index)} of w to true
    set index of w to 1
    activate
end tell
'''


async def _focus_terminal(tty: str) -> str:
    tab = await dialog.find_terminal_tab(tty)
    if tab is None:
        return NOT_FOUND
    code, _out, err = await dialog._osascript(_raise_terminal_script(tab),
                                              RAISE_TIMEOUT)
    if code != 0:
        return NOT_PERMITTED if dialog._is_permission_error(err) else FAILED
    return FOCUSED


async def focus(pid: int, name: str = "") -> str:
    """Raise the window running `pid`. Terminal.app first (an exact match
    when it owns the tty), then Warp (marker title)."""
    tty = await dialog.tty_for_pid_async(pid)
    if tty is None:
        return NO_TTY
    if await asyncio.to_thread(dialog._terminal_is_running):
        outcome = await _focus_terminal(tty)
        if outcome != NOT_FOUND:
            return outcome
    if await asyncio.to_thread(_app_running, WARP_BUNDLE_ID):
        return await _focus_warp(pid, tty, name)
    return NOT_FOUND
