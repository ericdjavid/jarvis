"""
JARVIS Action Executor — AppleScript-based system actions.

Execute actions IMMEDIATELY, before generating any LLM response.
Each function returns {"success": bool, "confirmation": str}.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess

log = logging.getLogger("jarvis.actions")

async def _mark_terminal_as_jarvis(revert_after: float = 5.0):
    """Temporarily set the front Terminal window to Ocean theme, then revert.

    Shows the user JARVIS is active in that terminal. Reverts after revert_after seconds.
    """
    # Save the current profile, switch to Ocean, then revert
    script_save = (
        'tell application "Terminal"\n'
        '    return name of current settings of front window\n'
        'end tell'
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            "osascript", "-e", script_save,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        original_profile = stdout.decode().strip()

        # Switch to Ocean
        script_set = (
            'tell application "Terminal"\n'
            '    set current settings of front window to settings set "Ocean"\n'
            'end tell'
        )
        proc2 = await asyncio.create_subprocess_exec(
            "osascript", "-e", script_set,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc2.communicate()

        # Schedule revert
        if original_profile and original_profile != "Ocean":
            asyncio.get_event_loop().call_later(
                revert_after,
                lambda: asyncio.ensure_future(_revert_terminal_theme(original_profile))
            )
    except Exception:
        pass


async def _revert_terminal_theme(profile_name: str):
    """Revert a Terminal window back to its original profile."""
    escaped = applescript_escape(profile_name)
    script = (
        'tell application "Terminal"\n'
        f'    set current settings of front window to settings set "{escaped}"\n'
        'end tell'
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            "osascript", "-e", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
    except Exception:
        pass


def applescript_escape(s: str) -> str:
    """Escape a string for safe embedding in an AppleScript double-quoted string."""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "").replace("\n", " ")


async def open_terminal(command: str = "") -> dict:
    """Open Terminal.app and optionally run a command. Marks it blue for JARVIS."""
    if command:
        escaped = applescript_escape(command)
        script = (
            'tell application "Terminal"\n'
            "    activate\n"
            f'    do script "{escaped}"\n'
            "end tell"
        )
    else:
        script = (
            'tell application "Terminal"\n'
            "    activate\n"
            "end tell"
        )
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    success = proc.returncode == 0
    if not success:
        log.error(f"open_terminal failed: {stderr.decode()}")
    else:
        await _mark_terminal_as_jarvis()
    return {
        "success": success,
        "confirmation": "Terminal is open, sir." if success else "I had trouble opening Terminal, sir.",
    }


CHROME_BIN = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_DATA_DIR = os.path.expanduser("~/Library/Application Support/Google/Chrome")
# A plain web address and nothing else may go on Chrome's command line: no
# space, no quote, and it cannot start with "-" since it starts with http.
_PLAIN_URL_RE = re.compile(r"https?://[^\s\"'<>\\]+")


def _user_chrome_pid() -> int | None:
    """The Chrome the user is signed into, not one an automation started.

    A debugging tool (chrome-devtools MCP, Playwright) runs a second Google
    Chrome with its own --user-data-dir. AppleScript's `tell application
    "Google Chrome"` cannot tell the two apart and opened RevenueCat in the
    signed-out one. The user's own instance is the one on the default data
    directory."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True,
                             text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if not cmd.startswith(CHROME_BIN) or "--type=" in cmd:
            continue
        data_dir = re.search(r"--user-data-dir=(\S+)", cmd)
        if data_dir is None or data_dir.group(1).rstrip("/") == CHROME_DATA_DIR:
            return int(pid)
    return None


def _chrome_profile() -> str | None:
    """JARVIS_CHROME_PROFILE (a folder name like "Profile 5"), else the
    profile the user last used."""
    chosen = os.getenv("JARVIS_CHROME_PROFILE", "").strip()
    if chosen:
        return chosen
    try:
        with open(os.path.join(CHROME_DATA_DIR, "Local State")) as f:
            return json.load(f).get("profile", {}).get("last_used") or None
    except (OSError, ValueError):
        return None


async def _open_in_user_chrome(url: str) -> bool:
    """Hand the URL to the user's own Chrome, in his profile, and bring that
    instance to the front. False when there is no such instance to target."""
    if not _PLAIN_URL_RE.fullmatch(url) or not os.path.exists(CHROME_BIN):
        return False
    pid = await asyncio.to_thread(_user_chrome_pid)
    if pid is None:
        return False
    argv = [CHROME_BIN]
    profile = _chrome_profile()
    if profile:
        argv.append(f"--profile-directory={profile}")
    argv.append(url)
    # The second process passes the URL to the running instance (same data
    # directory) and exits; it is never waited on.
    subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)
    raise_it = ('tell application "System Events" to set frontmost of '
                f'(first process whose unix id is {pid}) to true')
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", raise_it,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    await proc.wait()
    return True


async def open_browser(url: str, browser: str = "chrome") -> dict:
    """Open URL in user's browser (Chrome or Firefox).

    The URL goes through `applescript_escape` and nothing else. A hand-rolled
    `.replace('"', ...)` lived here and escaped the quote but not the
    BACKSLASH, which is the half that matters: AppleScript reads `\\\\` as one
    literal backslash, so a URL ending `x\\"` closes the string literal and
    everything after it is code — and `do shell script` is in that language.
    The URL arrives from a model, out of speech, possibly echoing a page or a
    README, so this is a straight line from attacker text to a shell.
    `tests/test_applescript_url_injection.py` runs the payload.
    """
    escaped_url = applescript_escape(url)

    if browser.lower() == "firefox":
        app_name = "Firefox"
        script = (
            'tell application "Firefox"\n'
            "    activate\n"
            f'    open location "{escaped_url}"\n'
            "end tell"
        )
    else:
        app_name = "Chrome"
        if await _open_in_user_chrome(url):
            return {"success": True,
                    "confirmation": "Pulled that up in Chrome, sir."}
        script = (
            'tell application "Google Chrome"\n'
            "    activate\n"
            f'    open location "{escaped_url}"\n'
            "end tell"
        )

    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    success = proc.returncode == 0
    if not success:
        log.error(f"open_browser ({app_name}) failed: {stderr.decode()}")
    return {
        "success": success,
        "confirmation": f"Pulled that up in {app_name}, sir." if success else f"{app_name} ran into a problem, sir.",
    }


# Keep backward compat
async def open_chrome(url: str) -> dict:
    return await open_browser(url, "chrome")


async def get_chrome_tab_info() -> dict:
    """Read the current Chrome tab's title and URL via AppleScript."""
    script = (
        'tell application "Google Chrome"\n'
        "    set tabTitle to title of active tab of front window\n"
        "    set tabURL to URL of active tab of front window\n"
        '    return tabTitle & "|" & tabURL\n'
        "end tell"
    )
    try:
        proc = await asyncio.create_subprocess_exec(
            "osascript", "-e", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        if proc.returncode == 0:
            result = stdout.decode().strip()
            parts = result.split("|", 1)
            if len(parts) == 2:
                return {"title": parts[0], "url": parts[1]}
        return {}
    except Exception as e:
        log.warning(f"get_chrome_tab_info failed: {e}")
        return {}


# --- Opening code where the user actually reads it -----------------------
#
# The user's words: "maybe he should be able to open code files in VS Code or
# text editor." VS Code first when it is installed, the system default
# otherwise, so this still works on a Mac that has never had it.
#
# No AppleScript and no shell: `open` is exec'd with the path as its own argv
# entry, so a filename cannot be quoted out of a script the way it can out of
# an AppleScript string literal. Containment and the sensitive-file wall are
# the CALLER's job and have already run by the time this is reached — see
# server.tool_open_in_editor.

VSCODE_APP = "/Applications/Visual Studio Code.app"


def _vscode_command(path: str) -> list[str] | None:
    """The argv that opens `path` in VS Code, or None if it is not installed."""
    binary = shutil.which("code")
    if binary:
        return [binary, str(path)]
    if os.path.isdir(VSCODE_APP):
        return ["open", "-a", VSCODE_APP, str(path)]
    return None


async def open_in_editor(path: str) -> dict:
    """Open a file or directory in VS Code, else in the system default."""
    argv = _vscode_command(path)
    editor = "VS Code"
    if argv is None:
        argv = ["open", str(path)]
        editor = "your editor"

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        success = proc.returncode == 0
    except OSError as e:
        log.error(f"open_in_editor could not launch: {e}")
        return {"success": False, "editor": editor,
                "confirmation": "I couldn't open an editor, sir."}

    if not success:
        log.error(f"open_in_editor failed: {stderr.decode(errors='replace')}")
    return {
        "success": success,
        "editor": editor,
        "confirmation": f"Opened that in {editor}, sir." if success
        else f"{editor} wouldn't open that, sir.",
    }


def _generate_project_name(prompt: str) -> str:
    """Generate a kebab-case project folder name from the prompt."""
    # First: check for a quoted name like "tiktok-analytics-dashboard"
    quoted = re.search(r'"([^"]+)"', prompt)
    if quoted:
        name = quoted.group(1).strip()
        # Already kebab-case or close to it
        name = re.sub(r"[^a-zA-Z0-9\s-]", "", name).strip()
        if name:
            return re.sub(r"[\s]+", "-", name.lower())

    # Second: check for "called X" or "named X" pattern
    called = re.search(r'(?:called|named)\s+(\S+(?:[-_]\S+)*)', prompt, re.IGNORECASE)
    if called:
        name = re.sub(r"[^a-zA-Z0-9-]", "", called.group(1))
        if len(name) > 3:
            return name.lower()

    # Fallback: extract meaningful words
    words = re.sub(r"[^a-zA-Z0-9\s]", "", prompt.lower()).split()
    skip = {"a", "the", "an", "me", "build", "create", "make", "for", "with", "and",
            "to", "of", "i", "want", "need", "new", "project", "directory", "called",
            "on", "desktop", "that", "application", "app", "full", "stack", "simple",
            "web", "page", "site", "named"}
    meaningful = [w for w in words if w not in skip and len(w) > 2][:4]
    return "-".join(meaningful) if meaningful else "jarvis-project"


# --- a new Claude Code session in its own Warp window ------------------------
# Warp has no AppleScript, but a launch configuration can open a window in a
# directory and run a command there, and `warp://launch/<name>` runs one. The
# prompt never goes into the YAML or a shell line: it sits in a file the
# command reads, so no quote in the user's words can break out of it. The
# window is its own, never a tab, so the Orbit click can find it again.
WARP_LAUNCH_DIR = os.path.expanduser("~/.warp/launch_configurations")
_SESSION_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")
LAUNCH_CLEANUP_SEC = 60.0


def session_name(raw: str) -> str:
    name = _SESSION_NAME_RE.sub("_", raw.strip().upper()).strip("_")
    return name[:40] or "AGENT"


async def _launch_in_warp(cwd: str, cmd: str, files: tuple[str, ...] = ()) -> dict:
    """Run `cmd` in `cwd` in a new Warp window, via a throwaway launch
    configuration. `files` are deleted with it once Warp has read them."""
    import json
    import secrets
    tag = f"jarvis-agent-{secrets.token_hex(4)}"
    os.makedirs(WARP_LAUNCH_DIR, exist_ok=True)
    config = os.path.join(WARP_LAUNCH_DIR, f"{tag}.yaml")
    with open(config, "w", encoding="utf-8") as f:
        f.write("---\n"
                f"name: {json.dumps(tag)}\n"
                "windows:\n"
                "  - tabs:\n"
                # No `title:`: a fixed tab title ignores the OSC retitle that
                # window_focus finds windows by, and the session could never
                # be brought to the front again.
                "      - layout:\n"
                f"          cwd: {json.dumps(cwd)}\n"
                "          commands:\n"
                f"            - exec: {json.dumps(cmd)}\n")
    # Warp resolves the link by the configuration's NAME; a path in it is
    # refused ("couldn't turn launch link into path" in warp.log).
    proc = await asyncio.create_subprocess_exec(
        "open", f"warp://launch/{tag}",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, stderr = await proc.communicate()

    async def _cleanup():
        await asyncio.sleep(LAUNCH_CLEANUP_SEC)
        for path in (config, *files):
            try:
                os.remove(path)
            except OSError:
                pass
    asyncio.get_running_loop().create_task(_cleanup())
    if proc.returncode != 0:
        log.error(f"warp launch failed: {stderr.decode()}")
        return {"success": False, "confirmation": "Warp ne s'est pas ouvert."}
    return {"success": True, "confirmation": ""}


def session_command(prompt_file: str, name: str, model: str = "") -> str:
    import shlex
    cmd = f"claude -n {shlex.quote(name)}"
    if model:
        cmd += f" --model {shlex.quote(model)}"
    return cmd + f' "$(cat {shlex.quote(prompt_file)})"'


async def open_warp_session(cwd: str, prompt: str, name: str, model: str = "") -> dict:
    """A new interactive session working on `prompt`, in its own window."""
    import tempfile
    fd, prompt_file = tempfile.mkstemp(prefix="jarvis-agent-", suffix=".txt")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(prompt)
    return await _launch_in_warp(cwd, session_command(prompt_file, name, model),
                                 (prompt_file,))


async def open_warp_resume(cwd: str, session_id: str) -> dict:
    """A closed conversation, back in its own window where it left off."""
    import shlex
    return await _launch_in_warp(cwd, f"claude --resume {shlex.quote(session_id)}")
