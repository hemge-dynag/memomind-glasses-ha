"""HTTP views used by the MemoMind phone plugin.

All views sit under /api/memomind_glasses and inherit HomeAssistantView, so the
long-lived access token already configured in the phone plugin authenticates
them without any extra credential.
"""

from __future__ import annotations

import json

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import API_DASHBOARDS, DOMAIN
from .model import (
    ModelError,
    clean_dashboard,
    dashboard_summary,
    wire_pages,
)
from .store import DashboardStore


def _store(hass: HomeAssistant) -> DashboardStore:
    return hass.data[DOMAIN]["store"]


class DashboardsView(HomeAssistantView):
    """List, create and reorder dashboards."""

    url = API_DASHBOARDS
    name = f"api:{DOMAIN}:dashboards"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        store = _store(hass)
        return self.json(
            {
                "dashboards": [
                    dashboard_summary(index, dashboard)
                    for index, dashboard in enumerate(store.dashboards)
                ]
            }
        )

    async def post(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        store = _store(hass)
        try:
            body = await request.json()
        except ValueError:
            return self.json_message("JSON invalide", 400)
        if not isinstance(body, dict):
            return self.json_message("JSON invalide", 400)
        action = body.get("action") or "create"
        try:
            if action == "create":
                name = str(body.get("name") or "Nouveau dashboard")[:40]
                dashboard = store.add(name)
                await store.async_save()
                return self.json({"dashboard": dashboard})
            if action == "reorder":
                order = [int(x) for x in body.get("order") or []]
                if not store.reorder(order):
                    return self.json_message("ordre invalide", 400)
                await store.async_save()
                return self.json({"ok": True})
        except (TypeError, ValueError):
            return self.json_message("requête invalide", 400)
        return self.json_message("action inconnue", 400)


class DashboardView(HomeAssistantView):
    """Read, replace and delete a single dashboard."""

    url = API_DASHBOARDS + "/{index}"
    name = f"api:{DOMAIN}:dashboard"
    requires_auth = True

    async def get(self, request: web.Request, index: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        try:
            position = int(index)
        except ValueError:
            return self.json_message("index invalide", 400)
        dashboard = _store(hass).get(position)
        if dashboard is None:
            return self.json_message("dashboard inconnu", 404)
        return self.json(
            {
                "id": str(position),
                "name": dashboard.get("name", "Dashboard"),
                "pages": wire_pages(dashboard),
                "source": dashboard,
            }
        )

    async def put(self, request: web.Request, index: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        try:
            position = int(index)
            body = await request.json()
        except ValueError:
            return self.json_message("requête invalide", 400)
        store = _store(hass)
        if store.get(position) is None:
            return self.json_message("dashboard inconnu", 404)
        try:
            dashboard = clean_dashboard(body)
        except ModelError as error:
            return self.json_message(str(error), 400)
        if dashboard is None:
            return self.json_message("dashboard vide", 400)
        store.replace(position, dashboard)
        await store.async_save()
        return self.json({"dashboard": dashboard})

    async def delete(self, request: web.Request, index: str) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        try:
            position = int(index)
        except ValueError:
            return self.json_message("index invalide", 400)
        store = _store(hass)
        if not store.remove(position):
            return self.json_message("dashboard inconnu", 404)
        await store.async_save()
        return self.json({"ok": True})


class DashboardsExportView(HomeAssistantView):
    """Compact export used by the phone when it only needs the wire pages."""

    url = API_DASHBOARDS + "/export"
    name = f"api:{DOMAIN}:export"
    requires_auth = True

    async def get(self, request: web.Request) -> web.Response:
        hass: HomeAssistant = request.app["hass"]
        store = _store(hass)
        payload = []
        for index, dashboard in enumerate(store.dashboards):
            payload.append(
                {
                    "id": str(index),
                    "name": dashboard.get("name", "Dashboard"),
                    "pages": wire_pages(dashboard),
                }
            )
        return web.json_response(payload, dumps=lambda value: json.dumps(value))


VIEWS = (DashboardsView, DashboardView, DashboardsExportView)
