# MemoMind Glasses for Home Assistant

Compose dashboards for MemoMind glasses inside Home Assistant, then pick the one
to show from the MemoMind Home Assistant phone app.

The integration adds a **MemoMind Glasses** entry to the Home Assistant sidebar.
In that panel you build dashboards out of pages and cards, arrange them in the
order you want, and the phone app lists them so the wearer can switch with a
tap.

## Install

### HACS (custom repository)

1. HACS → Integrations → three-dot menu → **Custom repositories**.
2. Add `https://github.com/hemge-dynag/memomind-glasses-ha` as an
   **Integration**.
3. Install **MemoMind Glasses**, then restart Home Assistant.
4. Settings → Devices & services → **Add integration** → *MemoMind Glasses*.

### Manual

Copy `custom_components/memomind_glasses` into your Home Assistant `config`
directory and restart, then add the integration from the UI.

## Build a dashboard

1. Open **MemoMind Glasses** in the sidebar.
2. **+ Dashboard**, give it a name (for example "Maison").
3. **+ Page**, then **+ Card**, then **+ Entity**. A card is what the wearer
   sees as one screen on the glasses.
4. Reorder pages within a dashboard, cards within a page and entities within a
   card with the ↑ / ↓ buttons. The order in the panel is exactly the order the
   glasses render.
5. **Enregistrer**.

Entity rows show the entity name and value; pressing the glasses button runs
the entity's natural action (toggle a light or switch, turn on a scene or
script, press a button).

## Choose it on the phone

In the MemoMind Home Assistant phone app, the main screen has a
**Dashboard Home Assistant** section. It lists every dashboard published by the
integration; select one and the glasses switch to it immediately. Choosing
**Cartes locales** keeps the cards edited on the phone itself.

The phone talks to the integration through the Home Assistant REST API with the
same long-lived token it already uses, so no extra credential is needed.

## API

All endpoints live under `/api/memomind_glasses` and require the Home Assistant
token.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/memomind_glasses/dashboards` | list dashboards with page and row counts |
| GET | `/api/memomind_glasses/dashboards/<index>` | one dashboard, flattened into glasses pages |
| PUT | `/api/memomind_glasses/dashboards/<index>` | replace a dashboard (validated) |
| DELETE | `/api/memomind_glasses/dashboards/<index>` | delete a dashboard |
| POST | `/api/memomind_glasses/dashboards` | `{"action":"create","name":"..."}` or `{"action":"reorder","order":[...]}` |

A dashboard is stored as:

```json
{
  "name": "Maison",
  "pages": [
    {
      "title": "Rez-de-chaussée",
      "cards": [
        {
          "type": "entities",
          "title": "Salon",
          "entities": [
            {"entity": "light.salon", "name": "Salon", "icon": "lightbulb"}
          ]
        }
      ]
    }
  ]
}
```

`name`, `icon` and `action` are optional overrides. When `icon` is omitted the
phone uses the entity's own icon, then a default for its domain.

## Limits

Dashboard 32 max, pages per dashboard 24, rows per page 32, card row limit 32.
Labels are capped at 32 characters because that is what the glasses can show
without truncation.

## Tests

The data model has no Home Assistant imports and is tested on its own:

```bash
python -m pytest tests
```
