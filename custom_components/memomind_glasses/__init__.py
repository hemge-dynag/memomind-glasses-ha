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

    register_views(hass)

    await _async_register_panel_dir(hass)

    try:
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name=PANEL_COMPONENT,
            frontend_url_path=PANEL_URL,
            module_url=f"/{DOMAIN}/panel.js?v={_frontend_version(hass)}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=False,
            config={},
            embed_iframe=False,
        )
    except Exception:  # noqa: BLE001 - keep the API usable even if the panel fails
        _LOGGER.exception("MemoMind Glasses: unable to register the sidebar panel")
    return True


def _frontend_version(hass: HomeAssistant) -> int:
    from .const import VERSION

    parts = [int(part) for part in VERSION.split(".") if part.isdigit()][:3]
    while len(parts) < 3:
        parts.append(0)
    return parts[0] * 10000 + parts[1] * 100 + parts[2]


def register_views(hass: HomeAssistant) -> None:
    """Registers the HTTP views once per Home Assistant instance."""

    registered = hass.data.setdefault(DOMAIN, {}).setdefault("views", set())
    for view in VIEWS:
        if view.name in registered:
            continue
        hass.http.register_view(view)
        registered.add(view.name)
        _LOGGER.debug("MemoMind Glasses: registered %s", view.url)


async def _async_register_panel_dir(hass: HomeAssistant) -> None:
    """Serves the panel directory with the API of the running HA version."""

    path = f"/{DOMAIN}"
    static_paths = hass.data[DOMAIN].setdefault("static_paths", set())
    if path in static_paths:
        return
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(path, str(PANEL_DIR), cache_headers=False)]
        )
    except AttributeError:
        hass.http.register_static_path(path, str(PANEL_DIR), cache_headers=False)
    except RuntimeError as error:
        _LOGGER.warning("MemoMind Glasses: static path already registered: %s", error)
    static_paths.add(path)


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    """Unload the config entry."""

    hass.data.pop(DOMAIN, None)
    return True
