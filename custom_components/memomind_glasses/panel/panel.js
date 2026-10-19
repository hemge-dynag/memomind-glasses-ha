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
    this._filling = false;
    this._rendering = false;
    this._pendingRender = false;
    this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    const first = !this._hass;
    const changed = Boolean(this._hass) && this._hass.states !== hass.states;
    this._hass = hass;
    if (first) this._reload();
    if (changed) this._refreshPreviews();
  }

  connectedCallback() {
    this._render();
  }

  _refreshPreviews() {
    this._previews = (this._previews || []).filter((element) => {
      if (!element.isConnected || !this.shadowRoot.contains(element)) return false;
      element.hass = this._hass;
      return true;
    });
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
    this._autoSave();
    this._error = "";
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
    if (this._selected === null || !this._draft || this._saving) return;
    this._saving = true;
    this._busy = true;
    try {
      if (!this._hass) throw new Error("Home Assistant non connecté");
      const result = await this._hass.callApi(
        "PUT",
        `${API_PATH}/${this._selected}`,
        this._draft,
      );
      this._error = "";
      this._saved = Boolean(result);
    } catch (error) {
      const status = error && error.status ? ` (${error.status})` : "";
      this._error = this._describe(error) + status;
    } finally {
      this._saving = false;
      this._busy = false;
      this._filling = false;
      this._updateStatus();
    }
  }

  _updateStatus() {
    const node = this.shadowRoot && this.shadowRoot.querySelector(".save-state");
    if (node) {
      node.textContent = this._filling
        ? "Enregistrement…"
        : this._error
          ? "Non enregistré"
          : this._saved
            ? "Enregistré"
            : "";
    }
  }

  _dirty() {
    return this._draft !== null;
  }

  _autoSave() {
    if (this._selected === null || !this._draft) return;
    if (this._finalTimer) clearTimeout(this._finalTimer);
    if (this._fillingTimer) clearTimeout(this._fillingTimer);
    this._filling = true;
    this._updateStatus();
    if (this._fillingTimer) clearTimeout(this._fillingTimer);
    this._fillingTimer = setTimeout(() => {
      this._filling = false;
      this._updateStatus();
    }, 900);
    if (this._finalTimer) clearTimeout(this._finalTimer);
    this._finalTimer = setTimeout(() => this._save(), 1600);
  }

  _markDirty() {
    this._render();
    this._autoSave();
  }

  _changed() {
    this._autoSave();
  }

  _cardConfig(card) {
    if (card.config && typeof card.config === "object" && card.config.type) {
      return card.config;
    }
    const config = { type: card.type || "entities" };
    if (card.title) config.title = card.title;
    if (card.entities && card.entities.length) {
      config.entities = card.entities.map((row) =>
        row.name ? { entity: row.entity, name: row.name } : row.entity,
      );
    }
    return config;
  }

  async _helpers() {
    if (this._cardHelpers !== undefined) return this._cardHelpers;
    this._cardHelpers = null;
    if (typeof window.loadCardHelpers !== "function") return null;
    try {
      const loaded = await window.loadCardHelpers();
      if (loaded && typeof loaded.createCardElement === "function") {
        this._cardHelpers = loaded;
      }
    } catch (_) {
      this._cardHelpers = null;
    }
    return this._cardHelpers;
  }

  _cardPreview(card, height) {
    const host = document.createElement("div");
    host.className = "preview";
    host.style.maxHeight = `${height}px`;
    this._helpers().then((helpers) => {
      if (!helpers) {
        const fallback = document.createElement("pre");
        fallback.className = "config-fallback";
        fallback.textContent = JSON.stringify(this._cardConfig(card), null, 2);
        host.append(fallback);
        return;
      }
      let element;
      try {
        element = helpers.createCardElement(this._cardConfig(card));
      } catch (error) {
        const fallback = document.createElement("div");
        fallback.className = "config-fallback";
        fallback.textContent = `${this._describe(error)} : carte ${card.type}`;
        host.append(fallback);
        return;
      }
      element.hass = this._hass;
      this._previews = this._previews || [];
      this._previews.push(element);
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
    const labelText = String(card._label || "").trim();
    const position = `Écran ${this._screenNumber(pageIndex, cardIndex)}`;
    slot.title = labelText
      ? `${position} sur les lunettes : ${labelText}`
      : `${position} sur les lunettes`;

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
    label.textContent = [card.type || "entities", card.title].filter(Boolean).join(" · ");
    cardHead.append(label, up, down, edit, remove);
    slot.append(cardHead);

    slot.append(this._cardPreview(card, 280));
    return slot;
  }

  _screenNumber(pageIndex, cardIndex) {
    let number = 0;
    (this._draft.pages || []).forEach((page, index) => {
      if (index < pageIndex) number += (page.cards || []).length;
    });
    return number + cardIndex + 1;
  }

  _pageOf(card) {
    for (const page of this._draft.pages || []) {
      const index = (page.cards || []).indexOf(card);
      if (index !== -1) return { page, index };
    }
    return { page: null, index: -1 };
  }

  _newCard(config) {
    const clean = JSON.parse(JSON.stringify(config || {}));
    const label = String(config && config.title ? config.title : "").trim();
    return {
      type: clean.type || "entities",
      title: "",
      entities: [],
      config: clean,
      _label: label,
    };
  }

  _editCard(card, index) {
    const { page, index: position } = this._pageOf(card);
    if (!page) return;
    this._openLovelaceDialog(
      page,
      card,
      position === -1 ? (index === undefined ? page.cards.length : index) : position,
    );
  }

  async _element(name) {
    if (customElements.get(name)) return true;
    try {
      if (typeof window.loadCardHelpers === "function") await window.loadCardHelpers();
    } catch (_) {
      /* ignore */
    }
    if (customElements.get(name)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return Boolean(customElements.get(name));
  }

  async _openLovelaceDialog(page, card, position) {
    const existing = card && card.config && card.config.type ? card.config : null;
    if (!existing) {
      if (!(await this._openCreateDialog(page, card, position))) {
        this._fallbackCard(page, card, position);
      }
      return;
    }
    const readyEdit = await this._element("hui-dialog-edit-card");
    if (readyEdit) {
      const dialog = document.createElement("hui-dialog-edit-card");
      dialog.hass = this._hass;
      dialog.lovelaceConfig = this._lovelaceConfig();
      dialog.cardConfig = JSON.parse(JSON.stringify(existing));
      dialog.saveCardConfig = (config) => {
        if (!config || !config.type) return;
        this._applyDialogConfig(page, card, config, position);
      };
      document.body.append(dialog);
      dialog.addEventListener("dialog-closed", () => dialog.remove(), { once: true });
      if (typeof dialog.show === "function") dialog.show();
      return;
    }
    if (await this._openCreateDialog(page, card, position)) return;
    this._fallbackCard(page, card, position);
  }

  async _openCreateDialog(page, card, position) {
    if (!(await this._element("hui-dialog-create-card"))) return false;
    const dialog = document.createElement("hui-dialog-create-card");
    dialog.hass = this._hass;
    dialog.lovelaceConfig = this._lovelaceConfig();
    dialog.saveConfig = (config) => {
      if (!config || !config.type) return;
      this._applyDialogConfig(page, card, config, position);
    };
    document.body.append(dialog);
    dialog.addEventListener("dialog-closed", () => dialog.remove(), { once: true });
    const path = page.cards.indexOf(card);
    dialog.showDialog({ path: path === -1 ? [] : [path] });
    return true;
  }

  _fallbackCard(page, card, position) {
    const cards = page.cards || [];
    const index = cards.indexOf(card);
    if (index !== -1) cards.splice(index, 1);
    this._error =
      "Le sélecteur de cartes de Home Assistant n'est pas disponible ici. " +
      "Ouvre l'onglet Carte d'un dashboard Lovelace, ajoute ta carte, colle son YAML ci-dessous.";
    page._fallback = {
      at: index === -1 ? (position === undefined ? cards.length : position) : index,
      text: "",
    };
    this._markDirty();
  }

  _fallbackNode(page) {
    const box = document.createElement("div");
    box.className = "yaml";
    const area = document.createElement("textarea");
    area.spellcheck = false;
    area.rows = 10;
    area.placeholder =
      "type: entities\nentities:\n  - light.salon\n  - sensor.temperature";
    area.value = page._fallback.text || "";
    area.oninput = () => {
      page._fallback.text = area.value;
    };
    const apply = document.createElement("button");
    apply.className = "primary";
    apply.textContent = "Ajouter la carte";
    apply.onclick = () => {
      const parsed = parseCardYaml(area.value);
      if (!parsed) {
        this._error = "YAML de carte invalide.";
      } else {
        page.cards = page.cards || [];
        page.cards.splice(
          Math.min(page._fallback.at, page.cards.length),
          0,
          this._newCard(parsed),
        );
        page._fallback = null;
        this._error = "";
      }
      this._markDirty();
    };
    const cancel = document.createElement("button");
    cancel.textContent = "Annuler";
    cancel.onclick = () => {
      page._fallback = null;
      this._error = "";
      this._markDirty();
    };
    box.append(area, apply, cancel);
    return box;
  }

  _applyDialogConfig(page, card, config, position) {
    page.cards = page.cards || [];
    const index = page.cards.indexOf(card);
    const at = index === -1 ? (position === undefined ? page.cards.length : position) : index;
    if (index !== -1) page.cards.splice(index, 1);
    page.cards.splice(at, 0, this._newCard(config));
    this._error = "";
    this._markDirty();
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

  _pageNode(page, pageIndex) {
    const box = document.createElement("section");
    box.className = "page";

    const head = document.createElement("header");
    const title = document.createElement("input");
    title.className = "page-title";
    title.placeholder = "Titre de la page";
    title.value = page.title || "";
    title.dataset.field = "page-title";
    title.oninput = () => {
      page.title = title.value;
      this._changed();
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
      wrapper.append(this._cardNode(card, pageIndex, cardIndex));
      strip.append(wrapper);
    });
    if (page._fallback) {
      const wrapper = document.createElement("div");
      wrapper.className = "slot editing";
      wrapper.append(this._fallbackNode(page));
      strip.append(wrapper);
    }
    const addCard = document.createElement("button");
    addCard.className = "ghost add-card";
    addCard.textContent = "+ Carte";
    addCard.onclick = () => {
      page.cards = page.cards || [];
      page._fallback = null;
      const card = { type: "", title: "", entities: [], config: null };
      this._openLovelaceDialog(page, card, page.cards.length);
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
    if (this._rendering) {
      this._pendingRender = true;
      return;
    }
    if (!this.shadowRoot) return;
    this._rendering = true;
    try {
      this._draw();
    } finally {
      this._rendering = false;
      if (this._pendingRender) {
        this._pendingRender = false;
        this._render();
      }
    }
  }

  _draw() {
    const root = this.shadowRoot;
    const active = root.activeElement;
    const caret =
      active && typeof active.selectionStart === "number"
        ? { key: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
        : null;
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
      .card-head .card-type { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hint { color:var(--secondary-text-color,#666); font-size:.9rem; }
      .save-state { align-self:center; font-size:.85rem; color:var(--secondary-text-color,#666); }
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
      name.dataset.field = "dashboard-name";
      name.oninput = () => {
        this._draft.name = name.value;
        this._changed();
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
      if (!(this._draft.pages || []).length) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = "Aucune page. Clique sur « + Page », puis sur « + Carte » pour ouvrir le sélecteur de cartes de Home Assistant.";
        pages.append(hint);
      }
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

    if (caret) {
      const field = root.querySelector(`[data-field="${caret.key}"]`);
      if (field) {
        field.focus();
        try {
          field.setSelectionRange(caret.start, caret.end);
        } catch (_) {
          /* not a text field */
        }
      }
    }
    this._updateStatus();
  }
}

customElements.define("memomind-glasses-panel", MemoMindGlassesPanel);

function parseCardYaml(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line, number) => ({ line: line.replace(/\r$/, ""), number }))
    .filter((entry) => entry.line.trim() && !entry.line.trim().startsWith("#"));
  if (!lines.length) return null;

  let position = 0;
  const indentOf = (entry) => entry.line.length - entry.line.trimStart().length;

  const nextSignificant = () => lines[position + 1];
  const opensList = () => {
    const next = nextSignificant();
    return Boolean(next) && next.line.trim().startsWith("- ");
  };

  const parseBlock = (indent) => {
    const first = lines[position];
    const isList = first.line.trim().startsWith("- ");
    return isList ? parseList(indent) : parseMap(indent);
  };

  const parseMap = (indent) => {
    const out = {};
    while (position < lines.length) {
      const entry = lines[position];
      if (indentOf(entry) < indent) break;
      if (indentOf(entry) > indent) throw new Error(`indentation ligne ${entry.number + 1}`);
      const body = entry.line.trim();
      if (body.startsWith("- ")) break;
      const separator = body.indexOf(":");
      if (separator <= 0) throw new Error(`clé attendue ligne ${entry.number + 1}`);
      const key = body.slice(0, separator).trim().replace(/^["']|["']$/g, "");
      const rest = body.slice(separator + 1).trim();
      position += 1;
      if (rest !== "") {
        out[key] = scalar(rest);
      } else {
        out[key] = parseChild(indent);
      }
    }
    return out;
  };

  const parseChild = (indent) => {
    if (position >= lines.length) return {};
    if (indentOf(lines[position]) > indent) {
      return parseBlock(indentOf(lines[position]));
    }
    if (opensList()) {
      const next = lines[position];
      if (next && indentOf(next) > indent) return parseList(indentOf(next));
      return parseList(indent + 2);
    }
    return {};
  };

  const parseList = (indent) => {
    const out = [];
    while (position < lines.length) {
      const entry = lines[position];
      if (indentOf(entry) < indent) break;
      if (indentOf(entry) > indent) throw new Error(`indentation ligne ${entry.number + 1}`);
      const body = entry.line.trim();
      if (!body.startsWith("- ")) break;
      const rest = body.slice(2).trim();
      const separator = rest.indexOf(":");
      if (separator > 0 && !/^["'[{]/.test(rest)) {
        const key = rest.slice(0, separator).trim();
        const value = rest.slice(separator + 1).trim();
        const item = {};
        if (value !== "") {
          item[key] = scalar(value);
          position += 1;
        } else {
          position += 1;
          item[key] = parseChild(indent + 2);
        }
        const next = lines[position];
        if (next && !next.line.trim().startsWith("- ")) {
          if (indentOf(next) > indent) {
            Object.assign(item, parseMap(indentOf(next)));
          } else {
            Object.assign(item, parseMap(indent + 2));
          }
        }
        out.push(item);
      } else {
        position += 1;
        out.push(scalar(rest));
      }
    }
    return out;
  };

  try {
    const parsed = parseBlock(indentOf(lines[0]));
    return parsed && typeof parsed === "object" && parsed.type ? parsed : null;
  } catch (_) {
    return null;
  }
}

function scalar(value) {
  const text = String(value);
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return JSON.parse(text.replace(/'/g, '"'));
    } catch (_) {
      return text;
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text.slice(1, -1);
    }
  }
  return text;
}
