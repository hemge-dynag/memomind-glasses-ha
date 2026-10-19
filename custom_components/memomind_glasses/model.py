"""Pure data model for MemoMind glasses dashboards.

The model is deliberately free of Home Assistant imports so it can be unit
tested on its own. A dashboard is an ordered list of pages; a page is an
ordered list of cards; an entities card is an ordered list of rows. The order
the user arranges in the panel is exactly the order the glasses render.
"""

from __future__ import annotations

from typing import Any

from .const import (
    MAX_CONFIG_TEXT,
    MAX_DASHBOARDS,
    MAX_LABEL,
    MAX_PAGES,
    MAX_ROWS,
    MAX_TITLE,
)

class ModelError(ValueError):
    """Raised when a payload cannot be turned into a valid dashboard."""


def _text(value: Any, limit: int) -> str:
    """Coerces to a trimmed single-line string capped at ``limit`` bytes."""

    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ")
    text = " ".join(text.split())
    return text[:limit]


def _clean_entity_id(value: Any) -> str:
    entity_id = str(value or "").strip()
    if "." not in entity_id:
        return ""
    domain, _, object_id = entity_id.partition(".")
    if not domain or not object_id:
        return ""
    return entity_id


def _clean_entity(value: Any) -> dict[str, Any] | None:
    if isinstance(value, str):
        value = {"entity": value}
    if not isinstance(value, dict):
        return None
    entity_id = _clean_entity_id(value.get("entity") or value.get("entity_id"))
    if not entity_id:
        return None
    entry: dict[str, Any] = {"entity": entity_id}
    name = _text(value.get("name"), MAX_LABEL)
    if name:
        entry["name"] = name
    icon = _text(value.get("icon"), 40)
    if icon:
        entry["icon"] = icon
    action = _text(value.get("action"), 64)
    if action:
        entry["action"] = action
    return entry


def _clean_config(value: Any, depth: int = 0) -> Any:
    """Keeps a Lovelace card config JSON-safe and bounded.

    Markdown-ish fields keep their line breaks: squashing them would destroy
    the content card the user typed in Lovelace.
    """

    if depth > 8:
        return None
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in list(value.items())[:64]:
            key = _text(key, 48)
            if not key:
                continue
            cleaned = _clean_config(item, depth + 1)
            if cleaned is not None:
                out[key] = cleaned
        return out
    if isinstance(value, (list, tuple)):
        return [
            cleaned
            for raw in list(value)[:MAX_ROWS]
            if (cleaned := _clean_config(raw, depth + 1)) is not None
        ]
    if isinstance(value, bool) or isinstance(value, (int, float)):
        return value
    if value is None:
        return None
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    if isinstance(value, str) and "\n" in text:
        return text[:MAX_CONFIG_TEXT]
    return _text(value, 1024)


def _entity_ids_from_config(value: Any, found: list[str], depth: int = 0) -> None:
    """Walks a Lovelace config and collects the entity ids it references."""

    if depth > 8 or len(found) >= MAX_ROWS:
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("entity", "entity_id") and isinstance(item, str):
                entity_id = _clean_entity_id(item)
                if entity_id and entity_id not in found:
                    found.append(entity_id)
            elif key == "entities":
                if isinstance(item, list):
                    for raw in item:
                        if isinstance(raw, str):
                            entity_id = _clean_entity_id(raw)
                            if entity_id and entity_id not in found:
                                found.append(entity_id)
                        else:
                            _entity_ids_from_config(raw, found, depth + 1)
                elif isinstance(item, str):
                    entity_id = _clean_entity_id(item)
                    if entity_id and entity_id not in found:
                        found.append(entity_id)
            else:
                _entity_ids_from_config(item, found, depth + 1)
    elif isinstance(value, list):
        for raw in value[:MAX_ROWS]:
            _entity_ids_from_config(raw, found, depth + 1)


def _config_of(value: dict[str, Any]) -> dict[str, Any]:
    """Returns the Lovelace config of a card, ignoring our own bookkeeping."""

    raw = value.get("config")
    if isinstance(raw, dict) and raw.get("type"):
        return raw
    return value


def _clean_card(value: Any) -> dict[str, Any] | None:
    """Normalises one card, keeping its Lovelace config for the live preview."""

    if not isinstance(value, dict):
        return None
    config = _config_of(value)
    card_type = _text(value.get("type"), 48) or _text(config.get("type"), 48) or "entities"
    config.pop("config", None)
    config["type"] = card_type
    entities = []
    for raw in value.get("entities") or []:
        entry = _clean_entity(raw)
        if entry is not None:
            entities.append(entry)
    if not entities:
        ids: list[str] = []
        _entity_ids_from_config(value.get("config") or value, ids)
        entities = [{"entity": entity_id} for entity_id in ids]
    if len(entities) > MAX_ROWS:
        raise ModelError(f"a card holds at most {MAX_ROWS} rows")
    return {
        "type": card_type,
        "title": _text(value.get("title"), MAX_TITLE),
        "entities": entities,
        "config": config,
    }


def _is_stray_entities_card(card: dict[str, Any]) -> bool:
    """True for an entities card the user never filled with a row.

    The panel keeps a placeholder card while the picker is open; a real
    Lovelace card always brings its own config (title, entities, ...).
    """

    if card["type"] != "entities" or card["entities"]:
        return False
    config = card.get("config") or {}
    meaningful = {key for key in config if key != "type"}
    return not meaningful


def clean_page(
    value: Any, allow_empty: bool = False, drop_stray: bool = True
) -> dict[str, Any] | None:
    """Normalises one page. Pages without any usable row are dropped.

    ``allow_empty`` keeps a page that only carries a title, so renaming a page
    before adding its first card is not silently lost on save. ``drop_stray``
    is off for a whole dashboard save: there the placeholder card the panel
    shows while its picker is open used to make the title unrecoverable.
    """

    if not isinstance(value, dict):
        return None
    cards = []
    for raw in value.get("cards") or []:
        card = _clean_card(raw)
        if card is not None:
            cards.append(card)
    if drop_stray:
        cards = [card for card in cards if not _is_stray_entities_card(card)]
    if not cards and not allow_empty:
        return None
    total = sum(len(card["entities"]) for card in cards)
    if total > MAX_ROWS:
        raise ModelError(f"a page holds at most {MAX_ROWS} rows")
    return {"title": _text(value.get("title"), MAX_TITLE), "cards": cards}


def clean_dashboard(
    value: Any, allow_empty: bool = False
) -> dict[str, Any] | None:
    """Normalises one dashboard. Accepts pages or a legacy ``cards`` list.

    ``allow_empty`` keeps a freshly created dashboard (no page yet) instead of
    dropping it, which would make it vanish from the list as soon as it is saved.
    """

    if not isinstance(value, dict):
        return None
    pages = []
    raw_pages = value.get("pages")
    if raw_pages is None and value.get("cards") is not None:
        raw_pages = [{"title": "", "cards": value.get("cards")}]
    for raw in raw_pages or []:
        page = clean_page(raw, allow_empty=allow_empty, drop_stray=not allow_empty)
        if page is not None:
            pages.append(page)
    pages = pages[:MAX_PAGES]
    if not pages and not allow_empty:
        return None
    name = _text(value.get("name"), 40) or "Dashboard"
    return {"name": name, "pages": pages}


def clean_dashboards(values: Any) -> list[dict[str, Any]]:
    """Normalises the whole stored list."""

    out = []
    for raw in values or []:
        dashboard = clean_dashboard(raw, allow_empty=True)
        if dashboard is not None:
            out.append(dashboard)
    return out[:MAX_DASHBOARDS]


def wire_pages(dashboard: dict[str, Any]) -> list[dict[str, Any]]:
    """Flattens a dashboard into the wire shape the phone expects.

    One card becomes one glasses page. The JSON field names match what the
    phone plugin already uses for its local cards, so the same builder and the
    same icon resolver handle both sources.
    """

    pages = []
    for page in dashboard.get("pages") or []:
        cards = page.get("cards") or []
        multi = len(cards) > 1
        for index, card in enumerate(cards):
            title = card.get("title") or page.get("title") or ""
            if multi and title:
                suffix = f" {index + 1}/{len(cards)}"
                title = (title[: max(0, MAX_TITLE - len(suffix))] + suffix)[
                    :MAX_TITLE
                ]
            pages.append(
                {
                    "title": title,
                    "cardtype": card.get("type", "entities"),
                    "config": card.get("config") or {},
                    "entities": [
                        {
                            "id": entity["entity"],
                            "name": entity.get("name", ""),
                            "icon": entity.get("icon", ""),
                            **(
                                {"action": entity["action"]}
                                if entity.get("action")
                                else {}
                            ),
                        }
                        for entity in card.get("entities") or []
                    ],
                }
            )
    return pages


def dashboard_summary(index: int, dashboard: dict[str, Any]) -> dict[str, Any]:
    """Small entry used by the phone to list the selectable dashboards."""

    pages = dashboard.get("pages") or []
    rows = sum(
        len(card.get("entities") or [])
        for page in pages
        for card in page.get("cards") or []
    )
    return {
        "id": str(index),
        "name": dashboard.get("name", "Dashboard"),
        "page_count": len(wire_pages(dashboard)),
        "row_count": rows,
    }
