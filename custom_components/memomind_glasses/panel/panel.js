// hass.callApi() prefixes "/api/" itself, so the path must not include it.
const API_PATH = "memomind_glasses/dashboards";
// Dialog geometry lives outside the shadow root, in the page itself: the
// overlay is portaled to <body> so Home Assistant's toolbar can never cover
// its buttons.
const DIALOG_CSS = `
  .dialog-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box; z-index:1000; font-family:var(--ha-font-family-body,sans-serif); }
  .dialog { background:var(--card-background-color,#fff); color:var(--primary-text-color,#111); border-radius:14px; padding:18px 20px; width:min(560px,100%); max-height:calc(100vh - 32px); box-sizing:border-box; overflow:auto; display:flex; flex-direction:column; gap:14px; box-shadow:0 12px 48px rgba(0,0,0,.45); }
  .dialog button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--divider-color,#ccc); background:var(--card-background-color,#fff); color:inherit; cursor:pointer; }
  .dialog button.primary { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); border-color:transparent; }
  .dialog-head { display:flex; justify-content:space-between; align-items:center; gap:12px; position:sticky; top:-18px; background:var(--card-background-color,#fff); padding:6px 0; z-index:2; }
  .dialog-head h2 { font-size:1.1rem; margin:0; }
  .dialog-head button { padding:2px 10px; font-size:1.1rem; line-height:1.4; }
  .gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:8px; }
  .gallery-item { padding:12px; text-align:left; border:1px solid var(--divider-color,#ccc); border-radius:8px; background:var(--secondary-background-color,#f3f3f3); }
  .fields { display:flex; flex-direction:column; gap:10px; }
  .field { display:flex; flex-direction:column; gap:4px; font-size:.9rem; }
  .field textarea { min-height:90px; }
  .dialog-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
  .yaml-input { width:100%; font-family:monospace; font-size:.85rem; padding:8px; border-radius:6px; border:1px solid var(--divider-color,#ccc); background:transparent; color:inherit; }
  .hint { color:var(--secondary-text-color,#666); font-size:.9rem; margin:0; }
  .dialog .error { color:var(--error-color,#c62828); font-size:.9rem; margin:0; }
`;

const PANEL_TAG = "memomind-glasses-panel";

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
    try {
      if (first) this._reload();
      if (changed) this._refreshPreviews();
    } catch (error) {
      console.error("MemoMind Glasses panel:", error);
    }
  }

  connectedCallback() {
    this._render();
  }

  _refreshPreviews() {
    this._previews = (this._previews || []).filter((element) => {
      try {
        if (!element.isConnected || !this.shadowRoot.contains(element)) return false;
        element.hass = this._hass;
        return true;
      } catch (_) {
        return false;
      }
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
    this._flushPending();
    this._autoSave();
    this._error = "";
    this._render();
  }

  _pageIndexOf(page) {
    const pages = (this._draft && this._draft.pages) || [];
    return pages.indexOf(page);
  }

  // Applies a card config saved by Home Assistant's own dialog. That callback
  // can arrive after a save reload replaced the draft, so the config is
  // replayed on the reloaded page and the card at the same position is
  // replaced in place — never appended as a second copy.
  _flushPending() {
    const pending = this._pending || [];
    this._pending = [];
    pending.forEach((item) => {
      const pages = (this._draft && this._draft.pages) || [];
      const page = pages[item.pageIndex];
      if (!page) return;
      /* The picker leaves an empty placeholder card at the target slot while
       * its dialog is open. Replacing that slot directly is what keeps an edit
       * from saving next to itself as a second card. */
      page.cards = page.cards || [];
      if (item.position >= 0 && item.position < page.cards.length) {
        const slot = page.cards[item.position];
        if (slot && !_isPlaceholder(slot)) {
          this._applyDialogConfig(page, slot, item.config, item.position);
          return;
        }
        page.cards.splice(item.position, 1);
      }
      this._applyDialogConfig(page, null, item.config, item.position);
    });
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
    edit.onclick = () => this._editCard(this._draft.pages[pageIndex].cards[cardIndex], cardIndex);
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

  _newCard(config, previous) {
    const clean = JSON.parse(JSON.stringify(config || {}));
    if (previous) {
      const old = previous.config && previous.config.type ? previous.config : {};
      Object.keys(old).forEach((key) => {
        if (!(key in clean)) clean[key] = old[key];
      });
      if (!clean.title && previous.title) clean.title = previous.title;
    }
    const label = String(clean.title ? clean.title : "").trim();
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
    const at = position === -1 ? (index === undefined ? page.cards.length : index) : position;
    const existing = this._cardConfig(card);
    this._openLovelaceDialog(page, existing && existing.type ? existing : null, at);
  }

  // Home Assistant's own card dialog, the one a dashboard uses. We open our
  // picker right away underneath it so the click is never silent, and we drop
  // ours as soon as HA raises its <dialog> above the panel.
  _openLovelaceDialog(page, existing, position) {
    this._openOwnDialog(page, position, existing);
    const token = this._dialog;
    const at = position === undefined ? page.cards.length : position;
    // The native dialog often calls back *after* our save reload rewrote the
    // draft: remember the config and apply it whenever that happens, so the
    // edit lands on the card it came from instead of adding a second one.
    const pageIndex = this._pageIndexOf(page);
    const queue = (config) => {
      if (!config || !config.type) return false;
      // A save reload already replaced `page` with its copy: keep the position
      // we were opened at so the replay still lands on the right page.
      this._pending = this._pending || [];
      this._pending.push({ pageIndex, position: at, config });
      return true;
    };
    if (existing) {
      this._fireDialog("hui-dialog-edit-card", {
        lovelaceConfig: this._virtualLovelace(page),
        saveCardConfig: (config) => {
          if (!config || !config.type) return;
          if (this._dialog === token) this._closeDialog();
          queue(config);
          if (_containsPage(this._draft, page)) this._applyDialogConfig(page, null, config, at);
        },
        cardConfig: JSON.parse(JSON.stringify(existing)),
        isNew: false,
      });
    } else {
      this._fireDialog("hui-dialog-create-card", {
        lovelaceConfig: this._virtualLovelace(page),
        saveConfig: (config) => {
          const cards =
            (config && config.views && config.views[0] && config.views[0].cards) ||
            page.cards ||
            [];
          const card = cards[at] || cards[cards.length - 1];
          if (!card || !card.type) return;
          if (this._dialog === token) this._closeDialog();
          queue(card);
          if (_containsPage(this._draft, page)) this._applyDialogConfig(page, null, card, at);
        },
        path: [0, "cards", at],
      });
    }
  }

  _virtualLovelace(page) {
    return {
      config: {
        views: [
          {
            title: page.title || "",
            path: "memo",
            cards: (page.cards || []).map((card) => this._cardConfig(card)),
          },
        ],
      },
      editMode: true,
    };
  }

  // HA's dialog manager listens for this event on <home-assistant>, composed,
  // and imports the chunk itself. Firing it is the only way in from a panel.
  _fireDialog(dialogTag, dialogParams) {
    try {
      // Walk up through light DOM, shadow roots and the panel container until
      // we reach HA's <home-assistant>, which owns the dialog manager.
      let node = this;
      for (let depth = 0; node && depth < 32; depth += 1) {
        if (node.tagName === "HOME-ASSISTANT") break;
        node = node.parentNode || node.parentElement || node.host || null;
      }
      if (!node || node.tagName !== "HOME-ASSISTANT") return;
      node.dispatchEvent(
        new CustomEvent("show-dialog", {
          bubbles: true,
          composed: true,
          cancelable: false,
          // `memomind` marks the event as ours, so nothing else can mistake
          // it for a dialog Home Assistant opened by itself.
          detail: { dialogTag, dialogParams, memomind: true },
        }),
      );
      this._watchDialog();
      return true;
    } catch (error) {
      console.warn("MemoMind Glasses: native dialog unavailable", error);
      return false;
    }
  }

  _watchDialog() {
    if (this._dialogWatch) clearInterval(this._dialogWatch);
    const started = Date.now();
    this._dialogWatch = setInterval(() => {
      // Custom element tags are lowercase in HTML; match with a selector for
      // the three ways HA names its card dialogs.
      const open =
        document.querySelector("hui-dialog-create-card, hui-dialog-edit-card") ||
        Array.from(document.body.children || []).find((node) =>
          /^(hui-dialog-|dialog-general$)/.test(String(node.localName || node.tagName || "").toLowerCase()),
        );
      if (open) {
        clearInterval(this._dialogWatch);
        this._dialogWatch = null;
        this._closeDialog();
        return;
      }
      if (Date.now() - started > 2500) {
        clearInterval(this._dialogWatch);
        this._dialogWatch = null;
      }
    }, 200);
  }


  _openOwnDialog(page, position, config) {
    if (this._dialogEl) this._dialogEl.remove();
    this._dialogEl = null;
    // One dialog at a time; a second click must not stack a second overlay.
    if (this._dialogWatch) {
      clearInterval(this._dialogWatch);
      this._dialogWatch = null;
    }
    this._dialog = { page, position, type: "entities", steps: [], index: 0 };
    this._dialogError = "";
    this._drawDialog();
    if (config && config.type) this._prefillDialog(config);
  }

  _prefillDialog(config) {
    const state = this._dialog;
    const entry = CARD_SUGGESTIONS.find((item) => item.type === config.type);
    if (!entry || !entry.template) return;
    state.type = entry.type;
    state.steps = [
      entry.template.map((field, index) => ({
        ...field,
        index,
        value: config[field.key] ?? field.value ?? field.default ?? "",
      })),
    ];
    state.index = 0;
    state.previous = config;
    this._dialogError = "";
    this._drawDialog();
  }

  _drawDialog() {
    try {
      this._drawDialogNow();
    } catch (error) {
      // A picker that silently stays closed is worse than a raw error.
      console.error("MemoMind Glasses card picker:", error);
      const node = document.createElement("div");
      node.className = "dialog-backdrop";
      const box = document.createElement("div");
      box.className = "dialog";
      const head = document.createElement("div");
      head.className = "dialog-head";
      const title = document.createElement("h2");
      title.textContent = "Ajouter une carte";
      const close = document.createElement("button");
      close.textContent = "✕";
      close.onclick = () => {
        node.remove();
        this._dialogEl = null;
      };
      head.append(title, close);
      const message = document.createElement("p");
      message.className = "error";
      message.textContent = `Erreur du sélecteur : ${error && error.message ? error.message : error}`;
      const fallback = document.createElement("div");
      fallback.className = "dialog-actions";
      const yaml = document.createElement("button");
      yaml.textContent = "Coller un YAML";
      yaml.onclick = () => {
        node.remove();
        this._dialogEl = null;
        const state = this._dialog;
        if (!state || !state.page) {
          this._dialog = null;
          this._dialogError = "";
          this._render();
          return;
        }
        state.steps = [
          [{ key: "yaml", name: "YAML de la carte", text: true, index: 0, value: "" }],
        ];
        state.yaml = true;
        state.blank = false;
        this._drawDialog();
      };
      fallback.append(yaml);
      box.append(head, message, fallback);
      node.append(box);
      document.body.append(node);
      this._dialogEl = node;
    }
  }

  _drawDialogNow() {
    if (this._dialogEl) this._dialogEl.remove();
    const state = this._dialog;
    if (!state) return;
    // The first click on the overlay starts a new interaction: never let a
    // press that began before the redraw close what was just rebuilt.
    this._guardUntil = Date.now() + 250;
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    backdrop.dataset.dialog = "card";
    const dialog = document.createElement("div");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");

    const head = document.createElement("div");
    head.className = "dialog-head";
    const title = document.createElement("h2");
    const slots = (state.page && state.page.cards) || [];
    title.textContent = state.position < slots.length ? "Modifier la carte" : "Ajouter une carte";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Fermer";
    close.onclick = () => this._closeDialog();
    head.append(title, close);
    dialog.append(head);

    if (state.blank) {
      const area = document.createElement("textarea");
      area.className = "yaml-input";
      area.rows = 10;
      area.placeholder = "type: entities\nentities:\n  - light.salon";
      area.dataset.key = "yaml";
      area.dataset.text = "1";
      if (state.yaml) area.value = state.yamlText || "";
      area.oninput = () => {
        state.yamlText = area.value;
      };
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        state.yamlError ||
        "Colle ici le YAML d'une carte (celui de Home Assistant → éditer une carte → CODE).";
      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      const back = document.createElement("button");
      back.textContent = "← Galerie";
      back.onclick = () => {
        state.blank = false;
        state.yaml = false;
        state.yamlError = "";
        this._dialogError = "";
        this._drawDialog();
      };
      const add = document.createElement("button");
      add.className = "primary";
      add.textContent = "Ajouter la carte";
      add.onclick = () => {
        const config = parseCardYaml(area.value || "");
        if (!config) {
          state.yamlError = "YAML invalide : il doit contenir au moins « type: ».";
          state.yamlText = area.value;
          this._drawDialog();
          return;
        }
        this._finishCard(state, config);
      };
      actions.append(back, add);
      dialog.append(hint, area, actions);
      backdrop.append(dialog);
      this._mountDialog(backdrop);
      return;
    }

    const gallery = document.createElement("div");
    gallery.className = "gallery";
    CARD_SUGGESTIONS.forEach((entry) => {
      const button = document.createElement("button");
      button.className = "gallery-item";
      button.textContent = entry.label;
      button.onclick = () => {
        if (entry.type === "blank") {
          state.blank = true;
          state.yaml = true;
          state.yamlText = "";
          state.yamlError = "";
          this._dialogError = "";
          this._drawDialog();
          return;
        }
        state.type = entry.type;
        state.blank = false;
        state.steps = entry.template
          ? [entry.template.map((field, index) => ({ ...field, index, value: field.value ?? field.default ?? "" }))]
          : [];
        state.index = 0;
        this._dialogError = "";
        this._drawDialog();
      };
      gallery.append(button);
    });
    dialog.append(gallery);

    if (state.steps.length) {
      const step = state.steps[state.index];
      const fields = document.createElement("div");
      fields.className = "fields";
      step.forEach((field) => {
        const label = document.createElement("label");
        label.className = "field";
        const text = document.createElement("span");
        text.textContent = field.name;
        let input;
        if (field.entities) {
          input = this._entityPicker(field.entities);
        } else if (field.text) {
          input = document.createElement("textarea");
          input.rows = 4;
        } else {
          input = document.createElement("input");
          input.type = "text";
          input.placeholder = field.placeholder || "";
        }
        if (typeof field.default === "string") input.value = field.default;
        input.dataset.key = field.key;
        input.dataset.text = field.text ? "1" : "";
        input.oninput = () => {
          step[field.index].value = input.value;
        };
        label.append(text, input);
        fields.append(label);
      });
      dialog.append(fields);

      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      if (state.index > 0) {
        const back = document.createElement("button");
        back.textContent = "← Retour";
        back.onclick = () => {
          state.index -= 1;
          this._drawDialog();
        };
        actions.append(back);
      }
      const next = document.createElement("button");
      next.className = "primary";
      next.textContent = state.index === state.steps.length - 1 ? "Ajouter la carte" : "Continuer";
      next.onclick = () => this._dialogNext();
      const cancel = document.createElement("button");
      cancel.textContent = "Annuler";
      cancel.onclick = () => this._closeDialog();
      actions.append(next, cancel);
      dialog.append(actions);
    }

    if (this._dialogError) {
      const error = document.createElement("div");
      error.className = "error";
      error.textContent = this._dialogError;
      dialog.append(error);
    }

    if (!state.steps.length) {
      const actions = document.createElement("div");
      actions.className = "dialog-actions";
      const toggle = document.createElement("button");
      toggle.textContent = "Coller un YAML";
      toggle.onclick = () => {
        const current = state.previous ? JSON.stringify(state.previous, null, 2) : "";
        state.steps = [[{ key: "yaml", name: "YAML de la carte", text: true, index: 0, value: current }]];
        state.yaml = true;
        this._dialogError = "";
        this._drawDialog();
      };
      actions.append(toggle);
      const cancel = document.createElement("button");
      cancel.textContent = "Fermer";
      cancel.onclick = () => this._closeDialog();
      actions.append(cancel);
      dialog.append(actions);
    }

    backdrop.append(dialog);
    this._mountDialog(backdrop);
  }

  _mountDialog(backdrop) {
    if (!backdrop) return;
    // Portal the dialog to <body> with its own <style>: inside the shadow
    // root it inherited the panel's scrolling box and ended up under HA's
    // toolbar, but a page-global adopted stylesheet is worse — it restyles
    // the whole app.
    const sheet = document.createElement("style");
    sheet.className = "memomind-dialog-style";
    sheet.textContent = DIALOG_CSS;
    // The dialog now lives outside the panel: its class carries the bits the
    // shadow root used to provide (see _drawDialogNow for the .embedded rule).
    backdrop.classList.add("portaled");
    backdrop.append(sheet);
    // Clicks inside the dialog never reach the panel or HA behind the
    // backdrop; only a press on the backdrop itself closes it.
    backdrop.addEventListener("click", (event) => {
      event.stopPropagation();
      if (Date.now() < (this._guardUntil || 0)) return;
      if (event.target === backdrop) this._closeDialog();
    });
    ["mousedown", "mouseup", "pointerdown", "pointerup"].forEach((type) => {
      backdrop.addEventListener(type, (event) => event.stopPropagation());
    });
    document.body.append(backdrop);
    this._dialogEl = backdrop;
    this._attachDialogWatch();
  }

  _attachDialogWatch() {
    if (!this._stopDialogWatch) {
      // The only trusted takeover signal is HA actually rendering its own
      // dialog: the MutationObserver below closes ours then. Event listeners
      // on the page were closing the picker while the user was still using
      // it (keyboard/IME presses do not always hit our backdrop), so nothing
      // is wired to window/document any more.
      this._observeDialogs();
      this._stopDialogWatch = () => {
        if (this._observer) this._observer.disconnect();
        this._observer = null;
        this._stopDialogWatch = null;
      };
    }
  }

  _observeDialogs() {
    if (this._observer || typeof MutationObserver !== "function") return;
    this._observer = new MutationObserver((records) => {
      if (!this._dialogEl) return;
      // HA does not always reuse its dialog element: a "close-dialog" event
      // followed by a new one must count as a takeover too.
      const yields = (name) => {
        const tag = String(name || "").toLowerCase();
        return tag.indexOf("hui-dialog-") === 0 || tag === "dialog-general" || tag === "ha-more-info-dialog";
      };
      for (const record of records) {
        for (const node of record.addedNodes || []) {
          const tag = (node && (node.localName || node.tagName)) || "";
          const kids = node ? Array.from(node.children || []) : [];
          if (yields(tag) || kids.some((child) => yields(child.localName || child.tagName))) {
            this._closeDialog();
            return;
          }
        }
      }
    });
    this._observer.observe(document.body, { childList: true });
  }

  _entityPicker(initial) {
    const wrap = document.createElement("div");
    wrap.className = "entity-picker";
    const chips = document.createElement("div");
    chips.className = "chips";
    const ids = initial.slice();
    const drawChips = () => {
      chips.innerHTML = "";
      ids.forEach((id, index) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        const state = this._hass.states[id];
        chip.textContent = state
          ? `${state.attributes.friendly_name || id} · ${state.state}`
          : id;
        const remove = document.createElement("button");
        remove.textContent = "✕";
        remove.onclick = () => {
          ids.splice(index, 1);
          drawChips();
        };
        chip.append(remove);
        chips.append(chip);
      });
    };
    drawChips();
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Filtrer les entités…";
    input.oninput = () => {
      list.innerHTML = "";
      const query = input.value.trim().toLowerCase();
      Object.values(this._hass.states)
        .filter((state) => state && state.entity_id)
        .filter((state) => {
          if (!query) return false;
          const name = String(state.attributes.friendly_name || "").toLowerCase();
          return state.entity_id.includes(query) || name.includes(query);
        })
        .slice(0, 40)
        .forEach((state) => {
          const item = document.createElement("button");
          item.className = "option";
          item.textContent = `${state.attributes.friendly_name || state.entity_id}`;
          const small = document.createElement("small");
          small.textContent = state.entity_id;
          item.append(small);
          item.onclick = () => {
            ids.push(state.entity_id);
            drawChips();
            input.value = "";
            list.innerHTML = "";
          };
          list.append(item);
        });
      wrap.dataset.value = JSON.stringify(ids);
    };
    const list = document.createElement("div");
    list.className = "options";
    wrap.append(chips, input, list);
    wrap.value = () => {
      const rows = ids.map((id) => {
        const state = this._hass.states[id];
        const name = state ? String(state.attributes.friendly_name || "") : "";
        return name ? { entity: id, name } : id;
      });
      return rows;
    };
    return wrap;
  }

  _dialogValues() {
    const state = this._dialog;
    const values = {};
    if (!state || !this._dialogEl) return values;
    this._dialogEl.querySelectorAll("[data-key]").forEach((node) => {
      const raw = typeof node.value === "function" ? node.value() : node.value;
      values[node.dataset.key] =
        node.dataset && node.dataset.text ? String(raw || "") : raw;
    });
    return values;
  }

  _dialogNext() {
    const state = this._dialog;
    if (!state) return;
    const token = this._draft;
    const values = this._dialogValues();
    const step = state.steps[state.index];
    step.forEach((field) => {
      if (field.key in values) field.value = values[field.key];
    });
    const missing = step.find((field) => {
      if (!field.required) return false;
      const value = field.value;
      if (Array.isArray(value)) return !value.length;
      return !String(value || "").trim();
    });
    if (missing) {
      this._dialogError = `Renseigne « ${missing.name} ».`;
      this._drawDialog();
      return;
    }
    if (state.index < state.steps.length - 1) {
      state.index += 1;
      this._dialogError = "";
      this._drawDialog();
      return;
    }
    let config;
    if (state.yaml) {
      const values = this._dialogValues();
      config = parseCardYaml(values.yaml || "");
      if (!config) {
        this._dialogError = "YAML de carte invalide (il doit contenir au moins « type: »).";
        this._drawDialog();
        return;
      }
    } else {
      config = buildSuggestionConfig(state);
    }
    this._finishCard(state, config);
  }

  _finishCard(state, config) {
    const card = { type: "", title: "", entities: [], config: null };
    const token = this._draft;
    const position = state.position;
    let page = state.page;
    if (!page || !_containsPage(this._draft, page)) {
      // The draft was replaced while the form was open: retarget the page the
      // user is actually looking at, or say so instead of saving nowhere.
      const pages = (this._draft && this._draft.pages) || [];
      const seen = token && token.pages ? token.pages.indexOf(state.page) : -1;
      page = pages[seen >= 0 && seen < pages.length ? seen : 0] || null;
    }
    if (!page) {
      this._closeDialog();
      this._error = "La page n'existe plus : rouvre « + Carte ».";
      this._render();
      return;
    }
    this._closeDialog();
    this._applyDialogConfig(page, card, config, position);
  }

  _closeDialog() {
    if (this._stopDialogWatch) this._stopDialogWatch();
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this._dialogEl) this._dialogEl.remove();
    this._dialogEl = null;
    this._dialog = null;
    this._dialogError = "";
  }

  _applyDialogConfig(page, card, config, position) {
    page.cards = page.cards || [];
    const index = card ? page.cards.indexOf(card) : -1;
    const at = index === -1
      ? Math.min(position === undefined ? page.cards.length : position, page.cards.length)
      : index;
    const previous = index !== -1 ? page.cards[index] : page.cards[at];
    const next = this._newCard(config, previous);
    if (index !== -1) page.cards.splice(index, 1);
    page.cards.splice(at, 0, next);
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
        const cards = page.cards || [];
      page._fallback = null;
      this._openLovelaceDialog(page, null, cards.length);
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
      this._renderedOnce = true;
    } catch (error) {
      console.error("MemoMind Glasses panel:", error);
      // An empty shadow root on a dark theme reads as a black page. Say what
      // happened instead of leaving the user with nothing.
      this._showCrash(error);
    } finally {
      this._rendering = false;
    }
    if (this._pendingRender) {
      this._pendingRender = false;
      setTimeout(() => this._render(), 0);
    }
  }

  _showCrash(error) {
    const root = this.shadowRoot;
    if (!root) return;
    try {
      root.innerHTML = "";
      const box = document.createElement("div");
      box.style.padding = "16px";
      box.style.color = "var(--primary-text-color,#111)";
      const title = document.createElement("h2");
      title.textContent = "MemoMind Glasses n'a pas pu s'afficher";
      const detail = document.createElement("p");
      const text = error && error.message ? error.message : String(error);
      detail.textContent = `Détail technique : ${text}`;
      const hint = document.createElement("p");
      hint.textContent = "Recharge la page (Ctrl+Maj+R). Si ça persiste, dis-le à Memo.";
      box.append(title, detail, hint);
      root.append(box);
    } catch (_) {
      /* nothing else we can do */
    }
  }

  _draw() {
    const root = this.shadowRoot;
    // Drop inline styles left behind by an earlier build. The stylesheet now
    // owns the dialog geometry, and an inline `position:fixed` from before
    // would keep it glued to the top-left corner. `document.body.children` is
    // an HTMLCollection: it has no `.filter`, and turning it into an array
    // must never be able to blank the panel.
    const portaled = Array.from(document.body.children || []).filter(
      (node) => node && node.className === "dialog-backdrop" && node.parentNode === document.body,
    );
    portaled.forEach((node) => {
      if (this._dialogEl !== node) node.remove();
      else node.removeAttribute("style");
    });
    // Services re-run async_setup_entry on every reload; the browser then
    // defines the panel class a second time and the old one starts rendering
    // an empty element. Keep the newest instance and remove the ghosts.
    if (window.__memoMindPanel && window.__memoMindPanel !== this) {
      try {
        window.__memoMindPanel.remove();
      } catch (_) {
        /* ignore */
      }
    }
    window.__memoMindPanel = this;
    const active = root.activeElement;
    const caret =
      active && typeof active.selectionStart === "number"
        ? { key: active.dataset.field, start: active.selectionStart, end: active.selectionEnd }
        : null;
    root.replaceChildren();
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
      .strip { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:14px; overflow:visible; padding-bottom:10px; align-items:start; }
      @media (max-width:700px){ .strip{grid-template-columns:minmax(0,1fr);} }
      .slot { min-width:0; }
      .card { max-height:420px; overflow:hidden; display:flex; flex-direction:column; }
      .card .preview { overflow-y:auto; max-height:260px; padding:4px 0; }
      .card-type { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--secondary-text-color,#666); flex:1; }
      .add-card { align-self:stretch; min-height:120px; }
      .yaml { display:flex; flex-direction:column; gap:8px; }
      .yaml textarea { width:100%; font-family:monospace; font-size:.85rem; padding:8px; border-radius:6px; border:1px solid var(--divider-color,#ccc); background:var(--card-background-color,#fff); color:inherit; }
      .config-fallback { font-size:.75rem; white-space:pre-wrap; margin:0; }
      .slot.editing { grid-column:1 / -1; }
      .card-head .card-type { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hint { color:var(--secondary-text-color,#666); font-size:.9rem; }
      .save-state { align-self:center; font-size:.85rem; color:var(--secondary-text-color,#666); }
      .dialog-head h2 { font-size:1.1rem; margin:0; }
      .gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:8px; }
      .gallery-item { padding:12px; text-align:left; border:1px solid var(--divider-color,#ccc); border-radius:8px; background:var(--secondary-background-color,#f3f3f3); }
      .fields { display:flex; flex-direction:column; gap:10px; }
      .field { display:flex; flex-direction:column; gap:4px; font-size:.9rem; }
      .dialog-actions { display:flex; gap:8px; justify-content:flex-end; }
      .yaml-input { width:100%; font-family:monospace; font-size:.85rem; padding:8px; border-radius:6px; border:1px solid var(--divider-color,#ccc); background:transparent; color:inherit; }
      .entity-picker { display:flex; flex-direction:column; gap:6px; }
      .chips { display:flex; flex-wrap:wrap; gap:6px; }
      .chip { background:var(--secondary-background-color,#eee); border-radius:999px; padding:4px 10px; font-size:.85rem; display:inline-flex; gap:6px; align-items:center; }
      .chip button { border:none; background:transparent; padding:0 2px; }
      .options { display:flex; flex-direction:column; max-height:180px; overflow-y:auto; }
      .options .option { display:flex; flex-direction:column; text-align:left; border:none; border-radius:0; }
      .options .option small { color:var(--secondary-text-color,#666); }
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

if (!customElements.get("memomind-glasses-panel")) {
  customElements.define(PANEL_TAG, MemoMindGlassesPanel);
}

const CARD_SUGGESTIONS = [
  {
    type: "entities",
    label: "Entités (liste)",
    template: [
      { key: "title", name: "Titre", placeholder: "Salon" },
      { key: "entities", name: "Entités", entities: [], required: true },
    ],
  },
  {
    type: "gauge",
    label: "Jauge",
    template: [
      { key: "entity", name: "Entité (sensor)", placeholder: "sensor.temperature", required: true },
      { key: "name", name: "Nom (optionnel)", placeholder: "" },
      { key: "unit", name: "Unité (optionnel)", placeholder: "°C" },
    ],
  },
  {
    type: "thermostat",
    label: "Thermostat",
    template: [
      { key: "entity", name: "Entité climate", placeholder: "climate.salon", required: true },
    ],
  },
  {
    type: "markdown",
    label: "Texte / Markdown",
    template: [
      { key: "title", name: "Titre", placeholder: "" },
      { key: "content", name: "Contenu", text: true, required: true },
    ],
  },
  {
    type: "tile",
    label: "Tuile (une entité)",
    template: [
      { key: "entity", name: "Entité", placeholder: "light.salon", required: true },
    ],
  },
];
CARD_SUGGESTIONS.push(
  { type: "blank", label: "Autre carte (Home Assistant)", template: null },
);

// A slot card the picker created but never filled: an entities card with no
// row and no Lovelace config of its own.
function _isPlaceholder(card) {
  if (!card) return true;
  const type = card.type || card.config?.type || "entities";
  if (type !== "entities") return false;
  if ((card.entities || []).length) return false;
  const config = card.config && typeof card.config === "object" ? card.config : {};
  return !Object.keys(config).some((key) => key !== "type");
}

function _containsPage(draft, page) {
  return Boolean(draft && draft.pages && draft.pages.indexOf(page) !== -1);
}

function buildSuggestionConfig(state) {
  const config = {};
  if (state.previous && state.previous.type === state.type) {
    Object.assign(config, state.previous);
  }
  config.type = state.type;
  state.steps.forEach((step) => {
    step.forEach((field) => {
      if (field.key === "entities") {
        if (Array.isArray(field.value) && field.value.length) config.entities = field.value;
        return;
      }
      if (field.value === undefined || field.value === "") return;
      config[field.key] = field.value;
    });
  });
  if (config.type === "gauge" && !config.severity) {
    if (config.unit === "%" || config.unit === "") {
      config.min = 0;
      config.max = 100;
    }
  }
  return config;
}

function loadScriptOnce(url) {
  if (typeof document === "undefined") return Promise.resolve(false);
  const existing = document.querySelector(`script[data-memomind="${url}"]`);
  if (existing) {
    return new Promise((resolve) => {
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener("error", () => resolve(false), { once: true });
    });
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = url;
    script.dataset.memomind = url;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.append(script);
  });
}

function parseCardYaml(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line, number) => ({ line: line.replace(/\r$/, ""), number }))
    .filter((entry) => entry.line.trim() && !entry.line.trim().startsWith("#"));
  if (!lines.length) return null;

  let position = 0;
  const indentOf = (entry) => entry.line.length - entry.line.trimStart().length;


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

  // YAML lets a block sequence sit at the same indentation as its parent key,
  // so a dash right after "key:" belongs to that key and not to the map.
  const parseChild = (indent) => {
    if (position >= lines.length) return {};
    const next = lines[position];
    if (next.line.trim().startsWith("- ")) return parseList(indentOf(next));
    if (indentOf(next) > indent) return parseBlock(indentOf(next));
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
