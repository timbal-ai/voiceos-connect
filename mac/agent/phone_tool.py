"""CLI entry for the VoiceOS notch integration: run ONE phone task end to end.

    python -m agent.phone_tool "clean up my notifications"
    python -m agent.phone_tool --status          (window rect JSON or null)
    python -m agent.phone_tool --dry-run "..."   (validate setup, do nothing)

Connects iPhone Mirroring, snaps the window under the notch (the stage
effect), runs the computer-use loop cropped to it, and prints:

    SAY: <narration line>          (as the agent works)
    STEP <n>: <action>             (per action)
    RESULT_JSON:{"result", "steps"} (last line, machine-readable)

The integration's server.ts consumes this stream. Honest failures: non-zero
exit + the error on stderr.
"""

import json
import sys

from . import mirroring


def main():
    args = [a for a in sys.argv[1:]]
    if "--status" in args:
        print(json.dumps({"window": mirroring.find_window()}))
        return

    dry_run = "--dry-run" in args
    task = " ".join(a for a in args if not a.startswith("--")).strip()

    if dry_run:
        import importlib
        checks = {
            "anthropic_key": bool(__import__("os").environ.get("ANTHROPIC_API_KEY")),
            "quartz": importlib.util.find_spec("Quartz") is not None,
            "mirroring_window_now": mirroring.find_window() is not None,
        }
        print("RESULT_JSON:" + json.dumps({"dry_run": True, "checks": checks}))
        return

    if not task:
        print("no task given", file=sys.stderr)
        sys.exit(2)

    from . import loop, panic

    panic.install()
    mirroring.connect()
    try:
        rect = mirroring.snap_under_notch() or mirroring.find_window()
    except Exception:
        rect = mirroring.find_window()  # snap is cosmetic, never fatal
    if rect is None:
        print("mirroring window vanished after connect", file=sys.stderr)
        sys.exit(1)

    steps = {"n": 0}

    def on_action(action):
        steps["n"] += 1
        print(f"STEP {steps['n']}: {action.get('action')}", flush=True)

    result = loop.run_task(
        task,
        on_narration=lambda t: print(f"SAY: {t}", flush=True),
        on_action=on_action,
        region=tuple(rect),
        phone=True,
    )
    print("RESULT_JSON:" + json.dumps({"result": result, "steps": steps["n"]}), flush=True)


if __name__ == "__main__":
    main()
