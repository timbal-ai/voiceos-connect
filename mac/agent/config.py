import os

from dotenv import load_dotenv

load_dotenv()

MODEL = os.getenv("VOICEOS_MODEL", "claude-sonnet-5")
BETA_FLAG = "computer-use-2025-11-24"
TOOL_TYPE = "computer_20251124"

MAX_STEPS = int(os.getenv("VOICEOS_MAX_STEPS", "30"))
MAX_TOKENS = 2048

# Model-facing resolution cap. Docs recommend staying near WXGA; clicks get
# scaled back to native logical coordinates in screen.py.
MODEL_MAX_W = 1366
MODEL_MAX_H = 768

# Let the UI settle before the post-action screenshot.
SETTLE_DELAY_S = 0.6

# How many screenshots to keep in the conversation before pruning old ones.
KEEP_IMAGES = 3

JPEG_QUALITY = 70
