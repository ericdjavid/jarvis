"""open_browser targets the user's own Chrome, never an automation's."""

import subprocess

import pytest

import actions

PS = (f"  111 {actions.CHROME_BIN} --user-data-dir=/tmp/devtools-profile --remote-debugging-pipe\n"
      f"  222 {actions.CHROME_BIN} --type=renderer\n"
      f"  333 {actions.CHROME_BIN}\n")


def test_the_automation_chrome_is_skipped(monkeypatch):
    monkeypatch.setattr(subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, PS, ""))
    assert actions._user_chrome_pid() == 333


def test_only_an_automation_chrome_means_no_target(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, PS.splitlines()[0] + "\n", ""))
    assert actions._user_chrome_pid() is None


@pytest.mark.asyncio
async def test_a_plain_url_goes_to_the_users_profile(monkeypatch):
    launched, raised = [], []
    monkeypatch.setattr(actions, "_user_chrome_pid", lambda: 333)
    monkeypatch.setenv("JARVIS_CHROME_PROFILE", "Profile 5")
    monkeypatch.setattr(actions.os.path, "exists", lambda p: True)
    monkeypatch.setattr(subprocess, "Popen", lambda argv, **k: launched.append(argv))

    class Proc:
        async def wait(self):
            return 0

    async def fake_exec(*argv, **k):
        raised.append(argv)
        return Proc()
    monkeypatch.setattr(actions.asyncio, "create_subprocess_exec", fake_exec)

    result = await actions.open_browser("https://app.revenuecat.com/overview")

    assert result["success"]
    assert launched == [[actions.CHROME_BIN, "--profile-directory=Profile 5",
                         "https://app.revenuecat.com/overview"]]
    assert "unix id is 333" in raised[0][2]


@pytest.mark.asyncio
async def test_anything_but_a_plain_url_stays_off_the_command_line(monkeypatch):
    monkeypatch.setattr(actions, "_user_chrome_pid", lambda: 333)
    assert not await actions._open_in_user_chrome('https://a.example/"x y')
    assert not await actions._open_in_user_chrome("file:///etc/passwd")
