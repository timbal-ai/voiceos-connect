"""The brain: the standard Anthropic computer-use loop.

screenshot -> model returns action -> execute -> screenshot -> repeat.

Every action's tool_result carries a fresh screenshot so the model never has
to spend a whole round-trip asking for one - that halves the step count,
which is the difference between 8s and 16s of stage dead-air per task.
"""

import time

import anthropic

from . import config, control, prompts, screen


class TaskCancelled(Exception):
    pass


def _execute(action: dict) -> list:
    """Run one computer-use action; return tool_result content blocks."""
    kind = action["action"]

    if kind == "screenshot":
        return [screen.screenshot_block()]
    if kind == "zoom":
        return [screen.zoom_block(action["region"])]
    if kind == "cursor_position":
        x, y = control.cursor_position()
        return [{"type": "text", "text": f"Cursor at ({x}, {y}) in screen points."}]
    if kind == "wait":
        time.sleep(min(float(action.get("duration", 1)), 5.0))
    elif kind == "key":
        control.press_combo(action["text"])
    elif kind == "hold_key":
        control.hold_key(action["text"], float(action.get("duration", 1)))
    elif kind == "type":
        control.type_text(action["text"])
    elif kind == "mouse_move":
        control.move(*screen.to_points(*action["coordinate"]))
    elif kind in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
        x, y = screen.to_points(*action["coordinate"])
        button = {"right_click": "right", "middle_click": "middle"}.get(kind, "left")
        clicks = {"double_click": 2, "triple_click": 3}.get(kind, 1)
        control.click(x, y, button=button, clicks=clicks, modifier=action.get("text"))
    elif kind == "left_mouse_down":
        control.mouse_down(*screen.to_points(*action["coordinate"]))
    elif kind == "left_mouse_up":
        control.mouse_up(*screen.to_points(*action["coordinate"]))
    elif kind == "left_click_drag":
        x1, y1 = screen.to_points(*action["start_coordinate"])
        x2, y2 = screen.to_points(*action["coordinate"])
        control.drag(x1, y1, x2, y2)
    elif kind == "scroll":
        x, y = screen.to_points(*action["coordinate"])
        control.scroll(
            x, y,
            action["scroll_direction"],
            int(action.get("scroll_amount", 3)),
            modifier=action.get("text"),
        )
    else:
        return [{"type": "text", "text": f"Unsupported action: {kind}"}]

    time.sleep(config.SETTLE_DELAY_S)
    return [screen.screenshot_block()]


def _prune_images(messages: list):
    """Keep only the newest KEEP_IMAGES screenshots; old pixels are dead weight."""
    image_blocks = []
    for msg in messages:
        if msg["role"] != "user" or not isinstance(msg["content"], list):
            continue
        for part in msg["content"]:
            if isinstance(part, dict) and part.get("type") == "tool_result":
                for block in part.get("content", []):
                    if isinstance(block, dict) and block.get("type") == "image":
                        image_blocks.append((part, block))
    for part, block in image_blocks[: -config.KEEP_IMAGES]:
        part["content"] = [
            b for b in part["content"] if b is not block
        ] or [{"type": "text", "text": "(older screenshot removed)"}]


def run_task(task: str, on_narration=None, on_action=None) -> str:
    """Run one task to completion. Returns the model's final text.

    on_narration(text): called with each spoken-style progress line.
    on_action(action_dict): called before each action executes.
    """
    client = anthropic.Anthropic()
    mw, mh = screen.model_size()
    tools = [{
        "type": config.TOOL_TYPE,
        "name": "computer",
        "display_width_px": mw,
        "display_height_px": mh,
        "enable_zoom": True,
    }]
    messages = [{"role": "user", "content": task}]
    final_text = ""

    for _ in range(config.MAX_STEPS):
        response = client.beta.messages.create(
            model=config.MODEL,
            max_tokens=config.MAX_TOKENS,
            system=prompts.SYSTEM,
            tools=tools,
            messages=messages,
            betas=[config.BETA_FLAG],
        )

        tool_uses = []
        for block in response.content:
            if block.type == "text" and block.text.strip():
                final_text = block.text.strip()
                if on_narration:
                    on_narration(final_text)
            elif block.type == "tool_use":
                tool_uses.append(block)

        messages.append({"role": "assistant", "content": response.content})

        if not tool_uses:
            return final_text

        results = []
        for tu in tool_uses:
            if on_action:
                on_action(tu.input)
            try:
                content = _execute(tu.input)
            except Exception as e:  # report failures back to the model, rule 5 style
                content = [{"type": "text", "text": f"Action failed: {e}"}]
            results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": content,
            })
        messages.append({"role": "user", "content": results})
        _prune_images(messages)

    return final_text + " (stopped: step limit reached)"
