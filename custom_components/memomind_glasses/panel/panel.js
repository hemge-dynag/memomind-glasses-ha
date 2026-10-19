// hass.callApi() prefixes "/api/" itself, so the path must not include it.
const API_PATH = "memomind_glasses/dashboards";

class MemoMindGlassesPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._dashboards = [];
    this._selected = null;
    this._draft = null;
    this._busy = false;
    this._error = "";
    this._newName = "";
    this._entityInput = {};
    this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._reload();
  }

  connectedCallback() {
    this._render();
  }

  _describe(error) {
    if (!error) return "Erreur inconnue";
    if (typeof error === "string") return error;
    if (error.body && typeof error.body === "object") {
      const body = error.body;
      if (body.message) return String(body.message);
      if (body.error) return String(body.error);
      try {
        return JSON.stringify(body);
      } catch (_) {
        return "Erreur serveur";
      }
    }
    if (error.message) return String(error.message);
    if (error.body) return String(error.body);
    try {
      return JSON.stringify(error);
    } catch (_) {
      return "Erreur inconnue";
    }
  }

  async _call(method, path = "", body = undefined) {
    this._busy = true;
    this._error = "";
    this._render();
    try {
      if (!this._hass) throw new Error("Home Assistant non connecté");
      const result = await this._hass.callApi(method, `${API_PATH}${path}`, body);
      return result === undefined ? {} : result;
    } catch (error) {
      const status = error && error.status ? ` (${error.status})` : "";
      this._error = this._describe(error) + status;
      return null;
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _reload() {
    const result = await this._call("GET");
    this._dashboards = (result && result.dashboards) || [];
    if (this._selected !== null && this._selected >= this._dashboards.length) {
      this._selected = null;
      this._draft = null;
    }
    this._render();
  }

  async _open(index) {
    const result = await this._call("GET", `/${index}`);
    if (!result) return;
    this._selected = index;
    this._draft = JSON.parse(JSON.stringify(result.source || { pages: [] }));
    this._render();
  }

  async _create() {
    const name = (this._newName || "").trim() || "Lunettes";
    const result = await this._call("POST", "", { action: "create", name });
    if (!result) return;
    this._newName = "";
    this._selected = Number(result.id);
    this._draft = JSON.parse(
      JSON.stringify(result.source || result.dashboard || { name, pages: [] }),
    );
    await this._reload();
  }

  async _remove(index) {
    const dashboard = this._dashboards[index];
    const label = dashboard ? dashboard.name : "";
    if (!this._confirmDelete) {
      this._confirmDelete = index;
      this._render();
      return;
    }
    if (this._confirmDelete !== index) {
      this._confirmDelete = index;
      this._render();
      return;
    }
    this._confirmDelete = null;
    const result = await this._call("DELETE", `/${index}`);
    if (result === null) return;
    this._selected = null;
    this._draft = null;
    await this._reload();
  }

  async _save() {
    if (this._selected === null || !this._draft) return;
    const result = await this._call("PUT", `/${this._selected}`, this._draft);
    if (!result) return;
    this._draft = JSON.parse(
      JSON.stringify(result.dashboard || result.source || this._draft),
    );
    this._saved = true;
    await this._reload();
  }

  _dirty() {
    return this._draft !== null;
  }

  _entityRow(entity, path, index) {
    const row = document.createElement("div");
    row.className = "entity-row";

    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "Monter";
    up.onclick = () => this._move(path, index, -1);
    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "Descendre";
    down.onclick = () => this._move(path, index, 1);
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.title = "Retirer";
    remove.onclick = () => this._removeEntity(path, index);

    const id = document.createElement("code");
    id.textContent = entity.entity;
    const state = this._hass.states[entity.entity];
    const friendly = state ? state.attributes.friendly_name || "" : "entité inconnue";
    const info = document.createElement("span");
    info.className = "entity-info";
    info.textContent = friendly;

    const name = document.createElement("input");
    name.placeholder = "Nom affiché";
    name.value = entity.name || "";
    name.oninput = () => {
      entity.name = name.value;
      this._markDirty();
    };

    row.append(up, down, id, info, name, remove);
    return row;
  }

  _move(path, index, delta) {
    const list = this._listAt(path);
    const target = index + delta;
    if (!list || target < 0 || target >= list.length) return;
    const [item] = list.splice(index, 1);
    list.splice(target, 0, item);
    this._markDirty();
  }

  _removeEntity(path, index) {
    const list = this._listAt(path);
    if (!list) return;
    list.splice(index, 1);
    this._markDirty();
  }

  _listAt(path) {
    let node = this._draft;
    for (const step of path) {
      if (!node) return null;
      node = step === "cards" ? node.cards : node.pages[step];
    }
    return node && node.entities;
  }

  _markDirty() {
    this._render();
  }

  _addEntity(path) {
    const key = path.join("/");
    const raw = this._entityInput[key] || "";
    const entity = raw.trim();
    if (!entity.includes(".")) {
      this._error = "Entité invalide : utilise la forme domaine.objet (ex: light.salon)";
      this._render();
      return;
    }
    const list = this._listAt(path);
    if (!list) return;
    if (list.some((row) => row.entity === entity)) {
      this._error = `${entity} est déjà dans cette carte`;
      this._render();
      return;
    }
    list.push({ entity });
    this._entityInput[key] = "";
    this._markDirty();
  }

  _entitiesFor(card) {
    return (card.entities || []).map((entity) => entity.entity);
  }

  _cardConfig(card) {
    if (card.config && typeof card.config === "object") return card.config;
    const config = { type: card.type || "entities" };
    if (card.title) config.title = card.title;
    if (card.entities && card.entities.length) {
      config.entities = card.entities.map((row) =>
        row.name ? { entity: row.entity, name: row.name } : row.entity,
      );
    }
    return config;
  }

  _cardPreview(card, height) {
    const host = document.createElement("div");
    host.className = "preview";
    host.style.maxHeight = `${height}px`;
    const build = () => {
      const helpers = window.loadCardHelpers;
      if (typeof helpers !== "function") return null;
      return helpers()
        .then((loaded) => {
          if (!loaded || typeof loaded.createCardElement !== "function") return null;
          const element = loaded.createCardElement(this._cardConfig(card));
          element.hass = this._hass;
          return element;
        })
        .catch(() => null);
    };
    Promise.resolve(build()).then((element) => {
      if (!element) {
        const fallback = document.createElement("pre");
        fallback.className = "config-fallback";
        fallback.textContent = JSON.stringify(this._cardConfig(card), null, 2);
        host.append(fallback);
        return;
      }
      host.append(element);
    });
    return host;
  }

  _lovelaceConfig() {
    if (!this._lovelace) {
      this._lovelace = { config: { views: [] }, editMode: true };
    }
    return this._lovelace;
  }

  _cardNode(card, pageIndex, cardIndex) {
    const slot = document.createElement("div");
    slot.className = "card";
    slot.title = "Une carte = un écran sur les lunettes";

    const cardHead = document.createElement("div");
    cardHead.className = "card-head";
    const label = document.createElement("span");
    label.className = "card-type";
    label.textContent = card.type || "entities";
    const up = document.createElement("button");
    up.textContent = "←";
    up.title = "Déplacer à gauche";
    up.onclick = () => this._moveCard([pageIndex], cardIndex, -1);
    const down = document.createElement("button");
    down.textContent = "→";
    down.title = "Déplacer à droite";
    down.onclick = () => this._moveCard([pageIndex], cardIndex, 1);
    const edit = document.createElement("button");
    edit.textContent = "Modifier";
    edit.title = "Modifier la carte";
    edit.onclick = () => this._editCard(card);
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.title = "Retirer la carte";
    remove.onclick = () => {
      (this._draft.pages[pageIndex].cards || []).splice(cardIndex, 1);
      this._markDirty();
    };
    cardHead.append(label, up, down, edit, remove);
    slot.append(cardHead);

    slot.append(this._cardPreview(card, 280));
    return slot;
  }

  _editCard(card) {
    card._editing = true;
    card._step = card.config && card.config.type ? "configure" : "pick";
    card._pending = card.config
      ? JSON.parse(JSON.stringify(card.config))
      : { type: undefined };
    this._error = "";
    this._markDirty();
  }

  _pickerNode(card) {
    const box = document.createElement("div");
    box.className = "picker-box";
    const tag = customElements.get("hui-card-picker");
    if (!tag || !window.loadCardHelpers) {
      box.append(this._yamlNode(card));
      return box;
    }
    const picker = document.createElement("hui-card-picker");
    picker.hass = this._hass;
    picker.lovelace = this._lovelaceConfig();
    picker.addEventListener("config-changed", (event) => {
      const config = event.detail && event.detail.config;
      if (!config || !config.type) return;
      card._pending = config;
      card._step = "configure";
      this._markDirty();
    });
    box.append(picker);
    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    cancel.onclick = () => this._cancelCardEdit(card);
    box.append(cancel);
    return box;
  }

  _configureNode(card) {
    const box = document.createElement("div");
    box.className = "config-box";
    const tag = customElements.get("hui-card-element-editor");
    if (!tag) {
      card._yaml = JSON.stringify(card._pending || {}, null, 2);
      box.append(this._yamlNode(card));
      return box;
    }
    const editor = document.createElement("hui-card-element-editor");
    editor.hass = this._hass;
    editor.lovelace = this._lovelaceConfig();
    editor.value = card._pending;
    editor.addEventListener("config-changed", (event) => {
      if (event.detail && event.detail.config) {
        card._pending = event.detail.config;
      }
    });
    box.append(editor);
    const actions = document.createElement("div");
    actions.className = "bar";
    const back = document.createElement("button");
    back.textContent = "← Changer de type";
    back.onclick = () => {
      card._step = "pick";
      this._markDirty();
    };
    const save = document.createElement("button");
    save.className = "primary";
    save.textContent = "Ajouter la carte";
    save.onclick = () => this._saveCardConfig(card);
    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    cancel.onclick = () => this._cancelCardEdit(card);
    actions.append(back, save, cancel);
    box.append(actions);
    return box;
  }

  _saveCardConfig(card) {
    const config = JSON.parse(JSON.stringify(card._pending || {}));
    if (!config.type) {
      this._error = "Choisis d'abord un type de carte";
      this._render();
      return;
    }
    card.config = config;
    card.type = config.type;
    card.title = config.title || "";
    card.entities = [];
    card._editing = false;
    card._pending = null;
    card._yaml = null;
    this._error = "";
    this._markDirty();
  }

  _cancelCardEdit(card) {
    card._editing = false;
    card._pending = null;
    card._yaml = null;
    this._render();
  }

  _moveCard(path, index, delta) {
    let node = this._draft;
    for (const step of path) node = node.pages[step];
    const cards = node.cards || [];
    const target = index + delta;
    if (target < 0 || target >= cards.length) return;
    const [item] = cards.splice(index, 1);
    cards.splice(target, 0, item);
    this._markDirty();
  }

  _editCardYaml(card) {
    const config = this._cardConfig(card);
    card._editing = true;
    card._yaml = JSON.stringify(config, null, 2);
    this._markDirty();
  }

  _applyCardYaml(card) {
    let parsed;
    try {
      parsed = JSON.parse(card._yaml || "{}");
    } catch (error) {
      this._error = `JSON invalide : ${error.message}`;
      this._render();
      return;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.type) {
      this._error = "La carte doit contenir au moins \"type\"";
      this._render();
      return;
    }
    card.config = parsed;
    card.type = parsed.type;
    card.title = parsed.title || "";
    if (Array.isArray(parsed.entities)) {
      card.entities = parsed.entities
        .map((row) => (typeof row === "string" ? row : row && row.entity))
        .filter((id) => typeof id === "string" && id.includes("."))
        .map((id) => ({ entity: id }));
    }
    card._editing = false;
    card._yaml = null;
    this._error = "";
    this._markDirty();
  }

  _yamlNode(card) {
    const box = document.createElement("div");
    box.className = "yaml";
    const area = document.createElement("textarea");
    area.spellcheck = false;
    area.value = card._yaml || "";
    area.rows = 12;
    area.oninput = () => {
      card._yaml = area.value;
    };
    const apply = document.createElement("button");
    apply.className = "primary";
    apply.textContent = "Appliquer";
    apply.onclick = () => this._applyCardYaml(card);
    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    cancel.onclick = () => {
      card._editing = false;
      card._yaml = null;
      this._markDirty();
    };
    box.append(area, apply, cancel);
    return box;
  }

  _pageNode(page, pageIndex) {
    const box = document.createElement("section");
    box.className = "page";

    const head = document.createElement("header");
    const title = document.createElement("input");
    title.className = "page-title";
    title.placeholder = "Titre de la page";
    title.value = page.title || "";
    title.oninput = () => {
      page.title = title.value;
      this._markDirty();
    };
    const up = document.createElement("button");
    up.textContent = "↑";
    up.onclick = () => this._movePage(pageIndex, -1);
    const down = document.createElement("button");
    down.textContent = "↓";
    down.onclick = () => this._movePage(pageIndex, 1);
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.onclick = () => this._removePage(pageIndex);
    head.append(title, up, down, remove);
    box.append(head);

    const strip = document.createElement("div");
    strip.className = "strip";
    (page.cards || []).forEach((card, cardIndex) => {
      const wrapper = document.createElement("div");
      wrapper.className = "slot";
      if (card._editing) {
        wrapper.classList.add("editing");
        wrapper.append(
          card._step === "pick" ? this._pickerNode(card) : this._configureNode(card),
        );
      } else {
        wrapper.append(this._cardNode(card, pageIndex, cardIndex));
      }
      strip.append(wrapper);
    });
    const addCard = document.createElement("button");
    addCard.className = "ghost add-card";
    addCard.textContent = "+ Carte";
    addCard.onclick = () => {
      page.cards = page.cards || [];
      const card = { type: "", title: "", entities: [], config: null };
      page.cards.push(card);
      this._editCard(card);
    };
    strip.append(addCard);
    box.append(strip);
    return box;
  }

  _movePage(index, delta) {
    const pages = this._draft.pages || [];
    const target = index + delta;
    if (target < 0 || target >= pages.length) return;
    const [page] = pages.splice(index, 1);
    pages.splice(target, 0, page);
    this._markDirty();
  }

  _removePage(index) {
    (this._draft.pages || []).splice(index, 1);
    this._markDirty();
  }

  _render() {
    if (!this.shadowRoot) return;
    const root = this.shadowRoot;
    root.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; padding:16px; font-family: var(--ha-font-family-body, sans-serif); }
      h1 { font-size:1.4rem; margin:0 0 12px; }
      .bar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
      button { font:inherit; padding:6px 10px; border-radius:6px; border:1px solid var(--divider-color,#ccc); background:var(--card-background-color,#fff); cursor:pointer; }
      button.primary { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); border-color:transparent; }
      button.ghost { border-style:dashed; }
      button:disabled { opacity:.5; cursor:default; }
      .layout { display:grid; grid-template-columns:260px 1fr; gap:16px; }
      .list { display:flex; flex-direction:column; gap:6px; }
      .list button { text-align:left; }
      .list button.active { outline:2px solid var(--primary-color,#03a9f4); }
      .pages { display:flex; flex-direction:column; gap:14px; }
      .page, .card { border:1px solid var(--divider-color,#ddd); border-radius:10px; padding:10px; background:var(--card-background-color,#fff); }
      .page header, .card-head { display:flex; gap:6px; align-items:center; margin-bottom:8px; }
      input { font:inherit; padding:6px 8px; border-radius:6px; border:1px solid var(--divider-color,#ccc); background:transparent; color:inherit; min-width:0; }
      .page-title { flex:1; font-weight:600; }
      .card-head input { flex:1; }
      .entity-row { display:grid; grid-template-columns:auto auto minmax(120px,1fr) minmax(80px,1fr) minmax(100px,1fr) auto; gap:6px; align-items:center; padding:4px 0; }
      .entity-info { color:var(--secondary-text-color,#666); font-size:.9rem; }
      .error { color:var(--error-color,#c62828); margin-bottom:12px; white-space:pre-wrap; }
      button.danger { background:var(--error-color,#c62828); color:#fff; border-color:transparent; }
      .picker { display:flex; gap:6px; margin:6px 0 10px; }
      .picker input { flex:1; }
      .strip { display:flex; gap:14px; overflow-x:auto; overflow-y:hidden; padding-bottom:10px; align-items:flex-start; }
      .slot { flex:0 0 auto; width:340px; }
      .card { max-height:420px; overflow:hidden; display:flex; flex-direction:column; }
      .card .preview { overflow-y:auto; max-height:260px; padding:4px 0; }
      .card-type { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--secondary-text-color,#666); flex:1; }
      .add-card { flex:0 0 auto; align-self:stretch; min-height:120px; width:140px; }
      .yaml { display:flex; flex-direction:column; gap:8px; }
      .yaml textarea { width:100%; font-family:monospace; font-size:.85rem; padding:8px; border-radius:6px; border:1px solid var(--divider-color,#ccc); background:var(--card-background-color,#fff); color:inherit; }
      .config-fallback { font-size:.75rem; white-space:pre-wrap; margin:0; }
      .slot.editing { width:420px; }
      .picker-box, .config-box { display:flex; flex-direction:column; gap:10px; max-height:520px; overflow-y:auto; }
      .picker-box hui-card-picker { display:block; }
      .hint { color:var(--secondary-text-color,#666); font-size:.9rem; }
      @media (max-width:700px){ .layout{grid-template-columns:1fr;} .entity-row{grid-template-columns:auto auto 1fr auto;} .entity-info{display:none;} }
    `;
    root.append(style);

    const title = document.createElement("h1");
    title.textContent = "MemoMind Glasses";
    root.append(title);

    if (this._error) {
      const error = document.createElement("div");
      error.className = "error";
      error.textContent = this._error;
      root.append(error);
    }

    const bar = document.createElement("div");
    bar.className = "bar";
    const newName = document.createElement("input");
    newName.placeholder = "Nom du nouveau dashboard";
    newName.value = this._newName || "";
    newName.oninput = () => {
      this._newName = newName.value;
    };
    newName.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._create();
      }
    };
    const create = document.createElement("button");
    create.className = "primary";
    create.textContent = "+ Dashboard";
    create.disabled = this._busy;
    create.onclick = () => this._create();
    const reload = document.createElement("button");
    reload.textContent = "Recharger";
    reload.onclick = () => this._reload();
    bar.append(newName, create, reload);
    if (this._draft) {
      const save = document.createElement("button");
      save.className = "primary";
      save.textContent = "Enregistrer";
      save.disabled = this._busy;
      save.onclick = () => this._save();
      bar.append(save);
    }
    root.append(bar);

    const layout = document.createElement("div");
    layout.className = "layout";

    const list = document.createElement("div");
    list.className = "list";
    this._dashboards.forEach((dashboard, index) => {
      const button = document.createElement("button");
      button.textContent = `${dashboard.name} · ${dashboard.page_count} écran(s)`;
      button.className = index === this._selected ? "active" : "";
      button.onclick = () => this._open(index);
      list.append(button);
    });
    if (!this._dashboards.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Aucun dashboard. Crée-en un pour les lunettes.";
      list.append(hint);
    }
    layout.append(list);

    const detail = document.createElement("div");
    if (this._draft) {
      const head = document.createElement("div");
      head.className = "bar";
      const name = document.createElement("input");
      name.value = this._draft.name || "";
      name.placeholder = "Nom du dashboard";
      name.oninput = () => {
        this._draft.name = name.value;
      };
      const remove = document.createElement("button");
      const armed = this._confirmDelete === this._selected;
      remove.textContent = armed ? "Confirmer la suppression" : "Supprimer";
      if (armed) remove.className = "danger";
      remove.onclick = () => this._remove(this._selected);
      head.append(name, remove);
      detail.append(head);

      const pages = document.createElement("div");
      pages.className = "pages";
      (this._draft.pages || []).forEach((page, index) => {
        pages.append(this._pageNode(page, index));
      });
      const addPage = document.createElement("button");
      addPage.className = "ghost";
      addPage.textContent = "+ Page";
      addPage.onclick = () => {
        this._draft.pages = this._draft.pages || [];
        this._draft.pages.push({ title: "", cards: [] });
        this._markDirty();
      };
      pages.append(addPage);
      detail.append(pages);
    } else {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        "Sélectionne un dashboard pour composer ses pages et ses cartes. Une carte = un écran sur les lunettes.";
      detail.append(hint);
    }
    layout.append(detail);
    root.append(layout);
  }
}

customElements.define("memomind-glasses-panel", MemoMindGlassesPanel);
