"""Constants for the MemoMind Glasses integration."""

DOMAIN = "memomind_glasses"
NAME = "MemoMind Glasses"

STORAGE_KEY = f"{DOMAIN}.dashboards"
STORAGE_VERSION = 1

PANEL_URL = "memomind-glasses"
PANEL_TITLE = "MemoMind Glasses"
PANEL_ICON = "mdi:glasses"
PANEL_COMPONENT = "memomind-glasses-panel"
VERSION = "1.5.8"
CARD_DIALOG_FALLBACK = "memomind-glasses-card-dialog"

API_PREFIX = f"/api/{DOMAIN}"
API_DASHBOARDS = f"{API_PREFIX}/dashboards"

MAX_DASHBOARDS = 32
MAX_PAGES = 24
MAX_ROWS = 32
MAX_LABEL = 32
MAX_TITLE = 32
MAX_CONFIG_TEXT = 4000

CARD_TYPES = ("entities",)
