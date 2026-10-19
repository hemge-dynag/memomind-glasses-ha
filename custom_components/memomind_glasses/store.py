"""Persistent storage for glasses dashboards."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION
from .model import ModelError, clean_dashboards, clean_page


class DashboardStore:
    """Ordered list of dashboards, persisted through a HA Store."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict[str, Any] = {"dashboards": []}
        self.listeners: list[Any] = []

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            self._data = {"dashboards": clean_dashboards(stored.get("dashboards"))}

    async def _async_save(self) -> None:
        await self._store.async_save(self._data)
        for listener in list(self.listeners):
            listener()

    @property
    def dashboards(self) -> list[dict[str, Any]]:
        return self._data["dashboards"]

    def get(self, index: int) -> dict[str, Any] | None:
        if 0 <= index < len(self.dashboards):
            return self.dashboards[index]
        return None

    def add(self, name: str) -> dict[str, Any]:
        dashboard = {"name": name, "pages": []}
        self.dashboards.append(dashboard)
        return dashboard

    def remove(self, index: int) -> bool:
        if not (0 <= index < len(self.dashboards)):
            return False
        del self.dashboards[index]
        return True

    def replace(self, index: int, dashboard: dict[str, Any]) -> bool:
        if not (0 <= index < len(self.dashboards)):
            return False
        self.dashboards[index] = dashboard
        return True

    def reorder(self, order: list[int]) -> bool:
        if sorted(order) != list(range(len(self.dashboards))):
            return False
        self.dashboards[:] = [self.dashboards[i] for i in order]
        return True

    def add_page(self, index: int, title: str) -> dict[str, Any] | None:
        dashboard = self.get(index)
        if dashboard is None:
            return None
        page = {"title": title, "cards": []}
        dashboard["pages"].append(page)
        return page

    def replace_page(self, index: int, page: int, value: Any) -> bool:
        dashboard = self.get(index)
        if dashboard is None or not (0 <= page < len(dashboard["pages"])):
            return False
        cleaned = clean_page(value)
        if cleaned is None:
            raise ModelError("a page needs at least one row")
        dashboard["pages"][page] = cleaned
        return True

    def remove_page(self, index: int, page: int) -> bool:
        dashboard = self.get(index)
        if dashboard is None or not (0 <= page < len(dashboard["pages"])):
            return False
        del dashboard["pages"][page]
        return True

    def move_page(self, index: int, page: int, target: int) -> bool:
        dashboard = self.get(index)
        if dashboard is None:
            return False
        pages = dashboard["pages"]
        if not (0 <= page < len(pages)) or not (0 <= target <= len(pages) - 1):
            return False
        pages.insert(target, pages.pop(page))
        return True

    async def async_save(self) -> None:
        await self._async_save()
