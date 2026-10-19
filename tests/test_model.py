"""Unit tests for the pure dashboard model."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from custom_components.memomind_glasses import model  # noqa: E402


def test_clean_dashboard_keeps_order_and_drops_junk():
    raw = {
        "name": "  Salon  ",
        "pages": [
            {
                "title": "Lumieres",
                "cards": [
                    {
                        "type": "entities",
                        "entities": [
                            {"entity": "light.salon", "name": "Salon"},
                            "light.cuisine",
                            {"entity": "bad"},
                            {"entity": "light.extra", "icon": "lamp"},
                        ],
                    }
                ],
            },
            {"title": "vide", "cards": [{"entities": []}]},
        ],
    }
    out = model.clean_dashboard(raw)
    assert out["name"] == "Salon"
    assert len(out["pages"]) == 1
    card = out["pages"][0]["cards"][0]
    entities = card["entities"]
    assert [e["entity"] for e in entities] == [
        "light.salon",
        "light.cuisine",
        "light.extra",
    ]
    assert entities[2]["icon"] == "lamp"
    assert card["config"]["type"] == "entities"


def test_wire_pages_flattens_cards_into_glasses_pages():
    dashboard = {
        "name": "Maison",
        "pages": [
            {
                "title": "Rez",
                "cards": [
                    {"title": "Salon", "entities": [{"entity": "light.salon"}]},
                    {"title": "Cuisine", "entities": [{"entity": "light.cuisine"}]},
                ],
            }
        ],
    }
    pages = model.wire_pages(dashboard)
    assert [p["title"] for p in pages] == ["Salon 1/2", "Cuisine 2/2"]
    assert pages[0]["entities"] == [{"id": "light.salon", "name": "", "icon": ""}]
    assert pages[1]["entities"] == [{"id": "light.cuisine", "name": "", "icon": ""}]


def test_wire_pages_uses_page_title_for_single_card():
    dashboard = {
        "name": "Maison",
        "pages": [
            {
                "title": "Salon",
                "cards": [{"entities": [{"entity": "light.salon"}]}],
            },
        ],
    }
    pages = model.wire_pages(dashboard)
    assert pages[0]["title"] == "Salon"


def test_summary_counts_rows_and_pages():
    dashboard = {
        "name": "Maison",
        "pages": [
            {
                "title": "",
                "cards": [
                    {"entities": [{"entity": "light.a"}, {"entity": "light.b"}]},
                    {"entities": [{"entity": "sensor.c"}]},
                ],
            }
        ],
    }
    summary = model.dashboard_summary(3, dashboard)
    assert summary == {
        "id": "3",
        "name": "Maison",
        "page_count": 2,
        "row_count": 3,
    }


def test_label_limit_is_enforced_on_bytes():
    dashboard = model.clean_dashboard(
        {
            "name": "x" * 100,
            "pages": [{"cards": [{"entities": [{"entity": "light.a", "name": "y" * 90}]}]}],
        }
    )
    assert len(dashboard["name"]) == 40
    assert len(dashboard["pages"][0]["cards"][0]["entities"][0]["name"]) == 32


def test_page_over_row_limit_is_rejected():
    raw = {
        "pages": [
            {
                "cards": [
                    {"entities": [{"entity": f"light.e{i}"} for i in range(33)]},
                ]
            }
        ]
    }
    try:
        model.clean_dashboard(raw)
    except model.ModelError:
        return
    except Exception as error:
        raise AssertionError(f"unexpected: {error!r}")
    raise AssertionError("expected ModelError")


def test_json_round_trip_is_stable():
    dashboard = model.clean_dashboard(
        {
            "name": "D",
            "pages": [
                {
                    "title": "P",
                    "cards": [
                        {
                            "type": "entities",
                            "title": "C",
                            "entities": [{"entity": "light.a", "name": "A"}],
                        }
                    ],
                }
            ],
        }
    )
    assert model.clean_dashboard(json.loads(json.dumps(dashboard))) == dashboard


def test_empty_dashboard_survives_round_trip():
    created = model.clean_dashboard({"name": "Lunettes", "pages": []}, allow_empty=True)
    assert created == {"name": "Lunettes", "pages": []}
    assert model.clean_dashboard({"name": "x", "pages": []}) is None
    assert model.clean_dashboards([created]) == [created]
    assert model.wire_pages(created) == []
    assert model.dashboard_summary(0, created)["page_count"] == 0


def test_any_lovelace_card_type_is_kept():
    page = model.clean_page(
        {
            "cards": [
                {"type": "weather", "entity": "weather.maison"},
                {"type": "light", "entity": "light.cuisine"},
                {"type": "markdown", "content": "**Salut**"},
            ]
        }
    )
    assert [card["type"] for card in page["cards"]] == ["weather", "light", "markdown"]
    assert page["cards"][0]["entities"] == [{"entity": "weather.maison"}]
    assert page["cards"][2]["entities"] == []
    assert page["cards"][2]["config"]["content"] == "**Salut**"
