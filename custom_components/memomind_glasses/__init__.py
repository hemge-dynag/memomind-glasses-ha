"""MemoMind Glasses: compose glasses dashboards inside Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .api import VIEWS
from .const import (
    DOMAIN,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
)
from .store import DashboardStore

_LOGGER = logging.getLogger(__name__)

PANEL_DIR = Path(__file__).parent / "panel"


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    """Register the store, the HTTP views and the sidebar panel."""

    store = DashboardStore(hass)
    await store.async_load()
    hass.data.setdefault(DOMAIN, {})["store"] = store

    for view in VIEWS:
        hass.http.register_view(view)

    await hass.http.async_register_static_paths(
        [StaticPathConfig(f"/{DOMAIN}", str(PANEL_DIR), cache_headers=False)]
    )

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_COMPONENT,
        frontend_url_path=PANEL_URL,
        module_url=f"/{DOMAIN}/panel.js",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=False,
        config={},
        embed_iframe=False,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    """Unload the config entry."""

    hass.data.pop(DOMAIN, None)
    return True
