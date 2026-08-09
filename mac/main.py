"""Milestone 1 entry point: drive macOS from typed text commands.

    python main.py                     interactive REPL
    python main.py "open Safari ..."   one-shot task

Later milestones replace stdin with the WS gateway + Deepgram STT, and the
narration callback feeds ElevenLabs TTS instead of print().
"""

import sys

import pyautogui

from agent import loop


def _describe(action: dict) -> str:
    kind = action.get("action", "?")
    if "coordinate" in action:
        return f"{kind} @ {tuple(action['coordinate'])}"
    if kind in ("type", "key", "hold_key"):
        return f"{kind}: {action.get('text', '')!r}"
    return kind


def run(task: str):
    print(f"\n▶ task: {task}")
    try:
        result = loop.run_task(
            task,
            on_narration=lambda t: print(f"  🗣  {t}"),
            on_action=lambda a: print(f"  ·  {_describe(a)}"),
        )
        print(f"✔ {result}\n")
    except KeyboardInterrupt:
        print("\n✖ task cancelled\n")
    except pyautogui.FailSafeException:
        print("\n✖ failsafe triggered (cursor in top-left corner), task aborted\n")


def main():
    if len(sys.argv) > 1:
        run(" ".join(sys.argv[1:]))
        return
    print("voiceos-connect mac agent — type a command, Ctrl+C cancels a task, Ctrl+D quits")
    while True:
        try:
            task = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if task:
            run(task)


if __name__ == "__main__":
    main()
