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

Warp needs only Accessibility for the process running JARVIS (AX API via
ctypes); the Terminal.app path still goes through AppleScript.
"""

from __future__ import annotations

import asyncio
import ctypes
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


# --- Accessibility API (ctypes, no Apple Events) ----------------------------
# System Events needs an Automation grant that macOS can refuse silently
# (-1743 with the toggle on, no prompt after a reset). The AX API underneath
# needs only Accessibility, which the terminal running JARVIS already has.

_AS = ctypes.cdll.LoadLibrary(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
_CF = ctypes.cdll.LoadLibrary(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_UTF8 = 0x08000100
_VP = ctypes.c_void_p

_AS.AXIsProcessTrusted.restype = ctypes.c_bool
_AS.AXUIElementCreateApplication.restype = _VP
_AS.AXUIElementCreateApplication.argtypes = [ctypes.c_int]
_AS.AXUIElementCopyAttributeValue.restype = ctypes.c_int
_AS.AXUIElementCopyAttributeValue.argtypes = [_VP, _VP, ctypes.POINTER(_VP)]
_AS.AXUIElementSetAttributeValue.restype = ctypes.c_int
_AS.AXUIElementSetAttributeValue.argtypes = [_VP, _VP, _VP]
_AS.AXUIElementPerformAction.restype = ctypes.c_int
_AS.AXUIElementPerformAction.argtypes = [_VP, _VP]
_CF.CFStringCreateWithCString.restype = _VP
_CF.CFStringCreateWithCString.argtypes = [_VP, ctypes.c_char_p, ctypes.c_uint32]
_CF.CFStringGetCString.restype = ctypes.c_bool
_CF.CFStringGetCString.argtypes = [_VP, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
_CF.CFArrayGetCount.restype = ctypes.c_long
_CF.CFArrayGetCount.argtypes = [_VP]
_CF.CFArrayGetValueAtIndex.restype = _VP
_CF.CFArrayGetValueAtIndex.argtypes = [_VP, ctypes.c_long]
_CF.CFRelease.argtypes = [_VP]
_TRUE = _VP.in_dll(_CF, "kCFBooleanTrue")
_AS.AXIsProcessTrustedWithOptions.restype = ctypes.c_bool
_AS.AXIsProcessTrustedWithOptions.argtypes = [_VP]
_CF.CFDictionaryCreate.restype = _VP
_CF.CFDictionaryCreate.argtypes = [_VP, ctypes.POINTER(_VP), ctypes.POINTER(_VP), ctypes.c_long, _VP, _VP]
_prompted = False

# NSRunningApplication through the ObjC runtime: `activateWithOptions:0`
# brings forward only the app's main window, where AXFrontmost (like a Dock
# click) pulls every Warp window on every display in front of everything.
ctypes.cdll.LoadLibrary("/System/Library/Frameworks/AppKit.framework/AppKit")
_OBJC = ctypes.cdll.LoadLibrary("/usr/lib/libobjc.A.dylib")
_OBJC.objc_getClass.restype = _VP
_OBJC.objc_getClass.argtypes = [ctypes.c_char_p]
_OBJC.sel_registerName.restype = _VP
_OBJC.sel_registerName.argtypes = [ctypes.c_char_p]
_send_int = ctypes.CFUNCTYPE(_VP, _VP, _VP, ctypes.c_int)(("objc_msgSend", _OBJC))
_send_ulong = ctypes.CFUNCTYPE(ctypes.c_bool, _VP, _VP, ctypes.c_ulong)(("objc_msgSend", _OBJC))


def _activate_main_window_only(app_pid: int) -> bool:
    cls = _OBJC.objc_getClass(b"NSRunningApplication")
    app = _send_int(cls, _OBJC.sel_registerName(b"runningApplicationWithProcessIdentifier:"), app_pid)
    if not app:
        return False
    return bool(_send_ulong(app, _OBJC.sel_registerName(b"activateWithOptions:"), 0))


def _ask_for_accessibility() -> None:
    """Once per run: have macOS show its own "allow Accessibility" dialog,
    which also lists the right app (the one macOS holds responsible) in
    Settings. Toggling a stale entry by hand does not always do that."""
    global _prompted
    if _prompted:
        return
    _prompted = True
    # Real CF callbacks and the framework's own key constant: a dictionary
    # built with NULL callbacks segfaults inside AXIsProcessTrustedWithOptions.
    key_cb = ctypes.addressof(ctypes.c_char.in_dll(_CF, "kCFTypeDictionaryKeyCallBacks"))
    val_cb = ctypes.addressof(ctypes.c_char.in_dll(_CF, "kCFTypeDictionaryValueCallBacks"))
    key = _VP.in_dll(_AS, "kAXTrustedCheckOptionPrompt").value
    opts = _CF.CFDictionaryCreate(None, (_VP * 1)(key), (_VP * 1)(_TRUE.value), 1,
                                  key_cb, val_cb)
    try:
        _AS.AXIsProcessTrustedWithOptions(opts)
    finally:
        _CF.CFRelease(opts)


def _cfstr(text: str):
    return _CF.CFStringCreateWithCString(None, text.encode(), _UTF8)


def _str_of(ref) -> str:
    buf = ctypes.create_string_buffer(512)
    if ref and _CF.CFStringGetCString(ref, buf, 512, _UTF8):
        return buf.value.decode("utf-8", "replace")
    return ""


def _warp_pid() -> int | None:
    try:
        out = subprocess.run(["lsappinfo", "info", "-only", "pid", "-app", WARP_BUNDLE_ID],
                             capture_output=True, text=True, timeout=1.0).stdout
    except Exception:
        return None
    digits = out.rsplit("=", 1)[-1].strip()
    return int(digits) if digits.isdigit() else None


def _ax_raise_window(app_pid: int, needle: str) -> str:
    """Raise the window of `app_pid` whose title contains `needle`, then make
    the app frontmost. Returns FOCUSED, NOT_FOUND or NOT_PERMITTED."""
    if not _AS.AXIsProcessTrusted():
        _ask_for_accessibility()
        return NOT_PERMITTED
    app = _AS.AXUIElementCreateApplication(app_pid)
    k_windows, k_title = _cfstr("AXWindows"), _cfstr("AXTitle")
    k_raise, k_main, k_front = _cfstr("AXRaise"), _cfstr("AXMain"), _cfstr("AXFrontmost")
    windows = _VP()
    try:
        if _AS.AXUIElementCopyAttributeValue(app, k_windows, ctypes.byref(windows)) != 0 \
                or not windows.value:
            return NOT_FOUND
        for i in range(_CF.CFArrayGetCount(windows)):
            win = _CF.CFArrayGetValueAtIndex(windows, i)
            title = _VP()
            if _AS.AXUIElementCopyAttributeValue(win, k_title, ctypes.byref(title)) != 0:
                continue
            found = needle in _str_of(title)
            _CF.CFRelease(title)
            if found:
                _AS.AXUIElementSetAttributeValue(win, k_main, _TRUE)
                _AS.AXUIElementPerformAction(win, k_raise)
                if not _activate_main_window_only(app_pid):
                    # macOS refused the polite activation: fall back to AX,
                    # which raises every Warp window but at least gets there.
                    _AS.AXUIElementSetAttributeValue(app, k_front, _TRUE)
                return FOCUSED
        return NOT_FOUND
    finally:
        if windows.value:
            _CF.CFRelease(windows)
        for ref in (k_windows, k_title, k_raise, k_main, k_front, app):
            _CF.CFRelease(ref)


async def _focus_warp(pid: int, tty: str, name: str) -> str:
    app_pid = await asyncio.to_thread(_warp_pid)
    if app_pid is None:
        return NOT_FOUND
    marker = _marker(pid)
    if not await asyncio.to_thread(_write_title, tty, marker):
        return FAILED
    await asyncio.sleep(TITLE_SETTLE_SEC)
    try:
        outcome = await asyncio.to_thread(_ax_raise_window, app_pid, marker)
    finally:
        await asyncio.to_thread(_write_title, tty, name or "claude")
    if outcome == NOT_PERMITTED:
        log.warning("warp raise not permitted: the process running JARVIS lacks Accessibility")
    return outcome


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
        log.warning(f"terminal raise failed: {err.strip()}")
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
