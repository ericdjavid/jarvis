#!/usr/bin/env python3
"""Claude Code statusline that feeds JARVIS the subscription gauges.

Set it in ~/.claude/settings.json:

  "statusLine": {"type": "command",
                 "command": "python3 ~/2026/jarvis/statusline_usage.py"}

Every open session then reports the five-hour and seven-day windows to
`usage_store`, so the dashboard stays current even when JARVIS himself has
not taken a turn. It prints the two numbers so the line is useful on its own.
"""

import json
import sys

import usage_store

LABELS = {"five_hour": "5h", "seven_day": "7j"}


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return
    limits = payload.get("rate_limits") if isinstance(payload, dict) else None
    if not isinstance(limits, dict):
        return
    try:
        usage_store.record_statusline(limits)
    except Exception:
        pass  # a statusline must never print a traceback into the session
    parts = []
    for key, label in LABELS.items():
        pct = (limits.get(key) or {}).get("used_percentage")
        if isinstance(pct, (int, float)):
            parts.append(f"{label} {round(pct)}%")
    print(" · ".join(parts))


if __name__ == "__main__":
    main()
