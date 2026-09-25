/*
 * PowerEngine config card for Home Assistant.
 *
 * Edits PowerEngine's input mappings, solar plants, features and operation
 * mode. Reads the input catalogue from the app (sensor.pe_map_catalogue), so
 * descriptions, units and sign conventions live in one place. Saves by firing
 * an HA event; the app validates, writes config.yaml (with a backup) and
 * reports the result.
 */
const CARD_VERSION = "0.4.4";
const VERSION_SENSOR = "sensor.pe_diag_version";
const MODE_SENSOR = "sensor.pe_state_operation_mode";
const CATALOGUE_SENSOR = "sensor.pe_map_catalogue";
const MAPPING_SENSOR = "sensor.pe_map_config";
const SAVE_EVENT = "pe_config_save";
const RESULT_EVENT = "pe_config_result";

const MAIN_PLANT_SUGGEST = {
  power: [/^sensor\.solis_pv_total_power$/],
  energy_today: [/^sensor\.solis_power_generation_today$/],
};
const FEATURES = [
  ["fill_when_cheap", "Top up when cheap", "Charge to the grid-charge target in every cheap slot, not just what the forecast needs. A buffer in case the forecast is wrong."],
  ["smart_charge_optimisation", "Smart-charge optimisation", "Request EDF smart-charge slots dynamically (replaces the fixed daily triggers)."],
  ["arbitrage", "Energy arbitrage", "Buy cheap and sell back when the spread is worth it (not built yet: turning it on has no effect).",
    "Check your export tariff terms first: some only pay for exported solar, not energy bought from the grid."],
  ["axle", "Axle VPP events", "Force-discharge during Axle events and hold charge beforehand."],
  ["free_power_days", "Free-power sessions", "Make full use of EDF free-electricity sessions."],
];
const FEATURE_DEFAULTS = { fill_when_cheap: true, smart_charge_optimisation: true, arbitrage: false, axle: true, free_power_days: true };

/* ------------------------------------------------------------------ helpers
 * Pure functions (no DOM), exported for tests at the bottom of the file.
 */

function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v === null || v === undefined ? "" : v).trim();
  if (t === "") return null;
  const n = Number(t);            // whole string must be numeric: "11:00" is not 11
  return Number.isFinite(n) ? n : null;
}

function fmtNumber(n, digits) {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits === undefined ? 2 : digits });
}

/** Split "+ discharging, - charging" into { pos: "discharging", neg: "charging" }. */
function parseSignNote(note) {
  const out = { pos: "positive", neg: "negative" };
  String(note || "").split(",").forEach((part) => {
    const p = part.trim();
    if (p.startsWith("+")) out.pos = p.slice(1).trim();
    if (p.startsWith("-") || p.startsWith("−")) out.neg = p.slice(1).trim();
  });
  return out;
}

function currentItem(items, now) {
  const t = now.getTime();
  return (items || []).find((it) => {
    const s = Date.parse(it.start || it.period_start);
    const e = Date.parse(it.end) || s + 30 * 60 * 1000;
    return s <= t && t < e;
  });
}

function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function summariseAttribute(attr, value, now) {
  if (!Array.isArray(value)) return `${attr}: present`;
  if (attr === "rates") {
    const cur = currentItem(value, now);
    const price = cur ? toNumber(cur.value_inc_vat !== undefined ? cur.value_inc_vat : cur.value) : null;
    return `${value.length} half-hour rates` + (price !== null ? `, now ${fmtNumber(price * 100, 2)}p` : "");
  }
  if (attr === "detailedForecast") {
    const kwh = value.reduce((s, it) => s + (toNumber(it.pv_estimate) || 0) * 0.5, 0);
    return `${value.length} half-hours, ${fmtNumber(kwh, 1)} kWh forecast`;
  }
  if (attr === "planned_dispatches") {
    if (!value.length) return "no planned slots";
    return `${value.length} planned slot(s), next ${fmtTime(value[0].start)}`;
  }
  return `${value.length} items`;
}

/**
 * What to show next to an input: the raw value, and for signed inputs how
 * PowerEngine will read it after the optional invert.
 */
function readout(role, spec, stateObj, now) {
  now = now || new Date();
  if (!spec) return { text: "", readsAs: "" };
  if (spec.value !== undefined && spec.value !== "") {
    return { text: `Fixed: ${spec.value} ${role.static_unit || ""}`.trim(), readsAs: "" };
  }
  if (!stateObj) return { text: "", readsAs: "" };
  const attrs = stateObj.attributes || {};
  const attr = spec.attribute || role.attribute;
  if (attr) {
    if (!(attr in attrs)) return { text: `No '${attr}' attribute`, readsAs: "" };
    return { text: summariseAttribute(attr, attrs[attr], now), readsAs: "" };
  }
  if (role.kind === "control" && stateObj.entity_id && stateObj.entity_id.startsWith("button.")) {
    return { text: "Button (no value to show)", readsAs: "" };
  }
  const unit = attrs.unit_of_measurement || "";
  const num = toNumber(stateObj.state);
  let text = num !== null ? `${fmtNumber(num)} ${unit}`.trim() : String(stateObj.state);
  if (num !== null && role.kind === "rate" && /GBP|\u00a3/.test(unit)) text = `${fmtNumber(num * 100, 2)}p/kWh`;
  if (num !== null && role.kind === "money" && /GBP|\u00a3/.test(unit)) text = `\u00a3${fmtNumber(num, 2)}${role.key === "standing_charge" ? " per day" : ""}`;
  if (role.kind === "timestamp") text = ["unknown", "unavailable", ""].includes(stateObj.state) ? "none scheduled" : `${fmtTime(stateObj.state)}`;
  let readsAs = "";
  if (role.signed && num !== null) {
    const v = spec.invert ? -num : num;
    const words = parseSignNote(role.sign_note);
    const mag = Math.abs(v);
    const shown = unit === "W" && mag >= 1000 ? `${fmtNumber(mag / 1000, 2)} kW` : `${fmtNumber(mag)} ${unit}`.trim();
    readsAs = v === 0 ? "reads as: idle (0)" : `reads as: ${v > 0 ? words.pos : words.neg} ${shown}`;
  }
  return { text, readsAs };
}

const UNITS = {
  power: ["W", "kW"], energy: ["kWh", "Wh"], percent: ["%"],
  rate: ["GBP/kWh", "£/kWh", "p/kWh"], money: ["GBP", "GBP/day", "£"],
};

/** Instant client-side problem for an input, or "" if it looks fine. */
function instantProblem(role, spec, stateObj) {
  if (!spec) return role.required === "yes" ? "Required" : "";
  if (spec.value !== undefined) {
    if (!role.static_ok) return "Must be an entity";
    return toNumber(spec.value) === null ? "Enter a number" : "";
  }
  const id = spec.entity || "";
  if (!id) return role.required === "yes" ? "Required" : "";
  const domain = id.split(".")[0];
  if (role.kind === "control" && /bump|boost/i.test(id)) return "Never allowed: bump/boost charging";
  if (!(role.domains || ["sensor"]).includes(domain)) return `Must be a ${(role.domains || ["sensor"]).join(" or ")} entity`;
  if (!stateObj) return "Entity not found";
  if (["unavailable"].includes(stateObj.state)) return "Entity is unavailable";
  const attr = spec.attribute || role.attribute;
  if (attr && !(attr in (stateObj.attributes || {}))) return `No '${attr}' attribute`;
  const allowed = UNITS[role.kind];
  if (allowed && !attr) {
    const unit = (stateObj.attributes || {}).unit_of_measurement;
    if (!allowed.includes(unit)) return `Unit is ${unit || "none"}, expected ${allowed.join(" or ")}`;
  }
  return "";
}

/** Problem with a numeric setting, or "". */
function settingProblem(setting, value) {
  const n = toNumber(value);
  if (n === null) return "Enter a number";
  if (n < setting.min || n > setting.max) return `Must be between ${setting.min} and ${setting.max}`;
  return "";
}

function suggestEntity(role, entityIds) {
  const pats = (role.suggest || []).map((p) => new RegExp(p));
  const nots = (role.suggest_not || []).map((p) => new RegExp(p));
  return entityIds.find((id) => pats.some((p) => p.test(id)) && !nots.some((p) => p.test(id))) || "";
}

function settingDefaults(list) {
  const out = {};
  (list || []).forEach((s) => { out[s.key] = s.default; });
  return out;
}

function initialDraft(saved, roles, entityIds, settings) {
  const draft = JSON.parse(JSON.stringify(saved || {}));
  settings = settings || {};
  draft.inputs = draft.inputs || {};
  draft.features = Object.assign({}, FEATURE_DEFAULTS, draft.features || {});
  draft.operation = Object.assign({ mode: "passive" }, draft.operation || {});
  draft.safety = Object.assign(settingDefaults(settings.safety), draft.safety || {});
  draft.system = Object.assign(settingDefaults(settings.system), draft.system || {});
  const fresh = !saved || !saved.inputs || !Object.keys(saved.inputs).length;
  if (fresh) {
    roles.forEach((r) => {
      if (r.kind === "static" && r.suggest_static !== undefined) draft.inputs[r.key] = { value: r.suggest_static };
      else {
        const id = suggestEntity(r, entityIds);
        if (id) draft.inputs[r.key] = { entity: id };
      }
    });
    if (!draft.solar_plants || !draft.solar_plants.length) {
      const find = (pats) => entityIds.find((id) => pats.some((p) => p.test(id))) || "";
      draft.solar_plants = [{
        id: "main", name: "Main", forecast: "solcast_site",
        power: { entity: find(MAIN_PLANT_SUGGEST.power) },
        energy_today: { entity: find(MAIN_PLANT_SUGGEST.energy_today) },
      }];
    }
  }
  draft.solar_plants = draft.solar_plants || [];
  return { draft, fresh };
}

function slugify(name, taken) {
  let base = String(name || "plant").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 20) || "plant";
  if (!/^[a-z]/.test(base)) base = "p_" + base;
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}

/** The config object to save: drop empty inputs, keep everything else. */
function buildConfig(draft) {
  const inputs = {};
  Object.entries(draft.inputs || {}).forEach(([k, spec]) => {
    if (!spec) return;
    if (spec.value !== undefined && spec.value !== "") inputs[k] = { value: toNumber(spec.value) ?? spec.value };
    else if (spec.entity) inputs[k] = spec.invert ? { entity: spec.entity, invert: true } : { entity: spec.entity };
  });
  const plants = (draft.solar_plants || []).filter((p) => p.power && p.power.entity && p.energy_today && p.energy_today.entity)
    .map((p) => ({ id: p.id, name: p.name || p.id, power: { entity: p.power.entity }, energy_today: { entity: p.energy_today.entity },
      forecast: p.forecast || "none", enabled: p.enabled !== false }));
  const out = { schema_version: 1, inputs, solar_plants: plants, features: draft.features, operation: { mode: (draft.operation || {}).mode || "passive" } };
  const safety = {};
  Object.entries(draft.safety || {}).forEach(([k, v]) => { const n = toNumber(v); if (n !== null) safety[k] = n; });
  if (Object.keys(safety).length) out.safety = safety;
  if (draft.system && Object.keys(draft.system).length) out.system = Object.assign({}, draft.system);
  if (draft.remove_entities) out.remove_entities = true;
  return out;
}

/* --------------------------------------------------------------------- card */

async function ensureEntityPicker() {
  if (typeof customElements === "undefined") return false;
  if (customElements.get("ha-entity-picker")) return true;
  try {
    const helpers = await window.loadCardHelpers();
    const card = await helpers.createCardElement({ type: "entities", entities: [] });
    if (card && card.constructor && card.constructor.getConfigElement) await card.constructor.getConfigElement();
  } catch (e) { /* fall back to a plain input */ }
  await Promise.race([customElements.whenDefined("ha-entity-picker"), new Promise((r) => setTimeout(r, 3000))]);
  return !!customElements.get("ha-entity-picker");
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  });
  children.flat().forEach((c) => { if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c))); });
  return node;
}

class PowerEngineConfigCard extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {
  setConfig(config) {
    this._config = config || {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._rows = [];
    this._pickers = [];
  }

  getCardSize() { return 12; }

  set hass(hass) {
    this._hass = hass;
    (this._pickers || []).forEach((p) => { p.hass = hass; });
    if (!this._built) this._maybeBuild();
    else this._refresh();
  }

  async _maybeBuild() {
    if (this._building) return;
    const s = this._hass.states;
    const ver = s[VERSION_SENSOR];
    const cat = s[CATALOGUE_SENSOR];
    if (!ver || ver.state === "unavailable" || !cat || !(cat.attributes || {}).roles) {
      this._renderMessage("PowerEngine app not detected. Check it is installed and AppDaemon's MQTT plugin is set up (install guide, Step 3).");
      return;
    }
    this._building = true;
    this._usePicker = await ensureEntityPicker();
    this._catalogue = cat.attributes;
    const mapping = s[MAPPING_SENSOR];
    this._saved = ((mapping && mapping.attributes) || {}).config || {};
    this._settings = this._catalogue.settings || {};
    this._readOnly = !(this._hass.user && this._hass.user.is_admin);
    const { draft, fresh } = initialDraft(this._saved, this._catalogue.roles, Object.keys(s).sort(), this._settings);
    this._draft = draft;
    this._prefilled = fresh;
    this._build();
    this._built = true;
    this._building = false;
    this._subscribe();
  }

  async _subscribe() {
    try {
      this._unsub = await this._hass.connection.subscribeEvents((ev) => {
        const d = ev.data || {};
        this._saving = false;
        this._setBanner(d.ok ? "ok" : "error", d.ok ? `Saved. PowerEngine is reloading. ${d.message || ""}` : `Not saved: ${d.message}`);
        this._refresh();
      }, RESULT_EVENT);
    } catch (e) { /* non-admin users can't subscribe; saving is admin-only anyway */ }
  }

  disconnectedCallback() { if (this._unsub) { this._unsub(); this._unsub = null; } }

  _renderMessage(text) {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = "";
    this.shadowRoot.append(this._style(), el("ha-card", { header: "PowerEngine configuration" }, el("div", { class: "content" }, el("p", {}, text))));
  }

  _style() {
    return el("style", {}, `
      .content { padding: 0 16px 16px; }
      .banner { padding: 8px 12px; border-radius: 6px; margin: 8px 0; }
      .banner.info { background: var(--secondary-background-color); }
      .banner.ok { background: rgba(67,160,71,.15); }
      .banner.error { background: rgba(219,68,55,.15); }
      h3 { margin: 20px 0 4px; font-size: 1.05em; }
      .row { border-top: 1px solid var(--divider-color); padding: 10px 0; }
      .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
      .label { font-weight: 500; }
      .badge { font-size: .75em; padding: 1px 6px; border-radius: 8px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
      .badge.req { background: var(--primary-color); color: var(--text-primary-color, #fff); }
      .desc { color: var(--secondary-text-color); font-size: .9em; margin: 2px 0 6px; }
      .ctl { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .ctl ha-entity-picker, .ctl input[type=text] { flex: 1 1 260px; min-width: 200px; }
      input[type=text], input[type=number], select { padding: 6px; border-radius: 4px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
      .live { font-size: .9em; margin-top: 4px; }
      .reads { color: var(--primary-color); margin-left: 6px; }
      .sign { font-size: .85em; color: var(--secondary-text-color); }
      .problem { color: var(--error-color); font-size: .9em; }
      .warning { color: var(--warning-color, #b26a00); font-size: .9em; margin-top: 4px; }
      .status { font-size: .85em; color: var(--secondary-text-color); }
      .status.ok { color: var(--success-color, #43a047); }
      .plant { border: 1px solid var(--divider-color); border-radius: 8px; padding: 8px; margin: 8px 0; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; position: sticky; bottom: 0; background: var(--card-background-color); padding: 8px 0; }
      button { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); cursor: pointer; }
      button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border: none; }
      button:disabled { opacity: .5; cursor: default; }
      .muted { color: var(--secondary-text-color); font-size: .85em; }
      .tools { display: flex; gap: 12px; justify-content: flex-end; margin-bottom: 4px; }
      button.link { background: none; border: none; padding: 2px 0; color: var(--primary-color); cursor: pointer; font-size: .9em; }
      details.section { border: 1px solid var(--divider-color); border-radius: 8px; margin: 8px 0; }
      details.section > summary { cursor: pointer; padding: 10px 12px; display: flex; gap: 8px; align-items: baseline; list-style: none; }
      details.section > summary::-webkit-details-marker { display: none; }
      details.section > summary::before { content: "▸"; color: var(--secondary-text-color); transition: transform .15s; display: inline-block; }
      details.section[open] > summary::before { transform: rotate(90deg); }
      details.section > summary .title { font-weight: 500; font-size: 1.05em; }
      details.section .count { margin-left: auto; font-size: .85em; color: var(--secondary-text-color); }
      details.section .count.bad { color: var(--error-color); }
      details.section > .body { padding: 0 12px 8px; }
      h4 { margin: 8px 0 4px; }
    `);
  }

  _entityInput(value, domains, onChange, label) {
    if (this._usePicker) {
      const p = document.createElement("ha-entity-picker");
      p.hass = this._hass;
      p.value = value || "";
      p.includeDomains = domains;
      p.allowCustomEntity = true;
      if (label) p.label = label;
      p.addEventListener("value-changed", (ev) => onChange(ev.detail.value || ""));
      this._pickers.push(p);
      return p;
    }
    const listId = `pe-list-${Math.random().toString(36).slice(2)}`;
    const ids = Object.keys(this._hass.states).filter((id) => domains.includes(id.split(".")[0])).sort();
    const input = el("input", { type: "text", value: value || "", list: listId, placeholder: label || "entity id", onchange: (ev) => onChange(ev.target.value.trim()) });
    return [input, el("datalist", { id: listId }, ids.map((id) => el("option", { value: id })))];
  }

  _build() {
    const root = this.shadowRoot;
    root.innerHTML = "";
    this._rows = [];
    this._pickers = [];
    const content = el("div", { class: "content" });
    this._banner = el("div", { class: "banner info" });
    content.append(this._banner);
    this._setBanner("info", this._readOnly
      ? "View only: log in as an admin to change PowerEngine's configuration."
      : this._prefilled
        ? "Suggested entities have been pre-filled from your system. Check each live value below, then Save."
        : "Change any input, check its live value, then Save.");

    // collapsible sections (open state kept across rebuilds and page loads)
    this._sections = {};
    const tools = el("div", { class: "tools" },
      el("button", { class: "link", onclick: () => this._toggleAll(true) }, "Expand all"),
      el("button", { class: "link", onclick: () => this._toggleAll(false) }, "Collapse all"));
    content.append(tools);
    const section = (key, title, note) => {
      const count = el("span", { class: "count" });
      const body = el("div", { class: "body" });
      const d = el("details", { class: "section" }, el("summary", {}, el("span", { class: "title" }, title), count), body);
      d.open = this._openSections().has(key);
      d.addEventListener("toggle", () => this._rememberOpen(key, d.open));
      if (note) body.append(el("div", { class: "desc" }, note));
      this._sections[key] = { details: d, count, problems: 0, unsaved: 0 };
      this._currentSection = key;
      content.append(d);
      return body;
    };

    // operation + features
    let body = section("operation", "Operation and features");
    body.append(el("h4", {}, "Operation"));
    const modeSel = el("select", { onchange: (ev) => { this._draft.operation.mode = ev.target.value; this._refresh(); } },
      el("option", { value: "passive" }, "Passive: monitor and simulate, never control"),
      el("option", { value: "active", disabled: true }, "Active: in control (not available in this build)"));
    modeSel.value = this._draft.operation.mode === "active" ? "active" : "passive";
    body.append(el("div", { class: "row" }, el("div", { class: "ctl" }, modeSel)));
    body.append(el("h4", {}, "Features"));
    FEATURES.forEach(([key, label, desc, warning]) => {
      const cb = el("input", { type: "checkbox", onchange: (ev) => { this._draft.features[key] = ev.target.checked; this._refresh(); } });
      cb.checked = !!this._draft.features[key];
      body.append(el("div", { class: "row" }, el("label", { class: "head" }, cb, el("span", { class: "label" }, label)), el("div", { class: "desc" }, desc),
        warning ? el("div", { class: "warning" }, `⚠ ${warning}`) : null));
    });

    // numeric settings, by section (older apps send no sections: one "Settings" section)
    this._settingRows = [];
    const allSettings = this._settings.safety || [];
    const groups = (this._settings.sections && this._settings.sections.length)
      ? this._settings.sections.map((s) => ({ key: `settings_${s.key}`, label: s.label, items: allSettings.filter((x) => s.keys.includes(x.key)) }))
      : [{ key: "settings", label: "Safety, limits and thresholds", items: allSettings }];
    groups.forEach((g) => {
      if (!g.items.length) return;
      const sbody = section(g.key, g.label);
      g.items.forEach((st) => sbody.append(this._settingRow(st)));
    });

    // inputs by group
    const roles = this._catalogue.roles;
    this._catalogue.groups.forEach((g) => {
      const inGroup = roles.filter((r) => r.group === g.key);
      if (!inGroup.length) return;
      const note = g.key === "controls" ? "Mapped now so Passive mode can show exactly what it would set. PowerEngine never writes to these in Passive mode." : null;
      const gbody = section(`inputs_${g.key}`, `Inputs: ${g.label}`, note);
      if (g.key === "grid") {
        (this._settings.system || []).forEach((st) => {
          const cb = el("input", { type: "checkbox", onchange: (ev) => { this._draft.system[st.key] = ev.target.checked; this._refresh(); } });
          cb.checked = !!this._draft.system[st.key];
          gbody.append(el("div", { class: "row" }, el("label", { class: "head" }, cb, el("span", { class: "label" }, st.label)), el("div", { class: "desc" }, st.help)));
        });
      }
      inGroup.forEach((role) => gbody.append(this._roleRow(role)));
      if (g.key === "grid") section("plants", "Solar plants").append(this._plantsSection());
    });
    this._currentSection = null;

    // actions
    this._saveBtn = el("button", { class: "primary", onclick: () => this._save() }, "Save");
    this._resetBtn = el("button", { onclick: () => { this._built = false; this._maybeBuild(); } }, "Discard changes");
    content.append(el("div", { class: "actions" }, el("span", { class: "muted" }, `Card v${CARD_VERSION}`), this._resetBtn, this._saveBtn));

    root.append(this._style(), el("ha-card", { header: "PowerEngine configuration" }, content));
    if (this._readOnly) {
      content.querySelectorAll("input, select, button:not(.link)").forEach((n) => { n.disabled = true; });
      this._pickers.forEach((pk) => { pk.disabled = true; });
    }
    this._refresh();
    // open any section that needs attention
    Object.values(this._sections).forEach((s) => { if (s.problems) s.details.open = true; });
  }

  _settingRow(st) {
    const input = el("input", { type: "number", step: "any", min: st.min, max: st.max, value: this._draft.safety[st.key],
      onchange: (ev) => { this._draft.safety[st.key] = ev.target.value; this._refresh(); } });
    const problem = el("div", { class: "problem" });
    this._settingRows.push({ st, problem, section: this._currentSection });
    return el("div", { class: "row" },
      el("div", { class: "head" }, el("span", { class: "label" }, st.label), el("span", { class: "badge" }, `default ${st.default}${st.unit ? " " + st.unit : ""}`)),
      el("div", { class: "desc" }, st.help),
      el("div", { class: "ctl" }, input, el("span", { class: "muted" }, st.unit || "")), problem);
  }

  _openSections() {
    if (!this._open) {
      try { this._open = new Set(JSON.parse(window.localStorage.getItem("powerengine-config-open") || "[]")); } catch (e) { this._open = new Set(); }
    }
    return this._open;
  }

  _rememberOpen(key, open) {
    const s = this._openSections();
    if (open) s.add(key); else s.delete(key);
    try { window.localStorage.setItem("powerengine-config-open", JSON.stringify([...s])); } catch (e) { /* private mode */ }
  }

  _toggleAll(open) {
    Object.entries(this._sections || {}).forEach(([key, s]) => { s.details.open = open; this._rememberOpen(key, open); });
  }

  _badge(role) {
    if (role.required === "yes") return el("span", { class: "badge req" }, "Required");
    if (role.required === "no") return el("span", { class: "badge" }, "Optional");
    const f = { axle: "axle", free_power: "free_power_days" }[role.required];
    const label = (FEATURES.find((x) => x[0] === f) || [0, role.required])[1];
    return el("span", { class: "badge" }, `Needed for ${label}`);
  }

  _roleRow(role) {
    const spec = () => this._draft.inputs[role.key];
    const set = (v) => { if (v) this._draft.inputs[role.key] = v; else delete this._draft.inputs[role.key]; this._refresh(); };
    const row = el("div", { class: "row" });
    row.append(el("div", { class: "head" }, el("span", { class: "label" }, role.label), this._badge(role)));
    row.append(el("div", { class: "desc" }, role.description));
    const ctl = el("div", { class: "ctl" });
    const cur = spec() || {};
    const isStatic = role.kind === "static" || (role.static_ok && cur.value !== undefined);

    const staticInput = el("input", { type: "number", step: "any", value: cur.value !== undefined ? cur.value : "", onchange: (ev) => set(ev.target.value === "" ? null : { value: ev.target.value }) });
    const unit = el("span", { class: "muted" }, role.static_unit || "");
    const entityBox = el("span", { style: "display:contents" }, this._entityInput(cur.entity, role.domains || ["sensor"], (v) => {
      const prev = spec() || {};
      set(v ? Object.assign({ entity: v }, prev.invert ? { invert: true } : {}) : null);
    }, role.label));

    if (role.kind === "static") {
      ctl.append(staticInput, unit);
    } else if (role.static_ok) {
      const modeSel = el("select", { onchange: (ev) => {
        if (ev.target.value === "fixed") { set(null); staticInput.value = ""; } else set(null);
        showMode(ev.target.value);
      } }, el("option", { value: "entity" }, "Entity"), el("option", { value: "fixed" }, "Fixed value"));
      modeSel.value = isStatic ? "fixed" : "entity";
      const showMode = (m) => { entityBox.style.display = m === "entity" ? "contents" : "none"; staticInput.style.display = unit.style.display = m === "fixed" ? "" : "none"; };
      ctl.append(modeSel, entityBox, staticInput, unit);
      showMode(modeSel.value);
    } else {
      ctl.append(entityBox);
    }

    let invertCb = null;
    if (role.signed) {
      invertCb = el("input", { type: "checkbox", onchange: (ev) => { const s = spec(); if (s && s.entity) { s.invert = ev.target.checked; if (!s.invert) delete s.invert; this._refresh(); } } });
      invertCb.checked = !!cur.invert;
      ctl.append(el("label", {}, invertCb, " Invert"));
    }
    row.append(ctl);
    if (role.signed) {
      const w = parseSignNote(role.sign_note);
      row.append(el("div", { class: "sign" }, `PowerEngine expects: + = ${w.pos}, − = ${w.neg}. Tick Invert if your entity reports it the other way round.`));
    }
    const live = el("div", { class: "live" });
    const problem = el("div", { class: "problem" });
    const status = el("div", { class: "status" });
    row.append(live, problem, status);
    this._rows.push({ role, spec, live, problem, status, section: this._currentSection });
    return row;
  }

  _plantsSection() {
    const wrap = el("div", {});
    const draw = () => {
      wrap.innerHTML = "";
      wrap.append(el("div", { class: "desc" }, "Every solar array PowerEngine should count. The main plant is the one on the hybrid inverter; add others as you install them."));
      this._draft.solar_plants.forEach((p, i) => {
        const box = el("div", { class: "plant" });
        const name = el("input", { type: "text", value: p.name || "", placeholder: "Name", onchange: (ev) => { p.name = ev.target.value; this._refresh(); } });
        const fc = el("select", { onchange: (ev) => { p.forecast = ev.target.value; this._refresh(); } },
          el("option", { value: "none" }, "Forecast: none (actuals only)"),
          el("option", { value: "solcast_site" }, "Forecast: Solcast site"),
          el("option", { value: "scaled" }, "Forecast: scaled from main"));
        fc.value = p.forecast || "none";
        const en = el("input", { type: "checkbox", onchange: (ev) => { p.enabled = ev.target.checked; this._refresh(); } });
        en.checked = p.enabled !== false;
        const head = el("div", { class: "ctl" }, name, fc, el("label", {}, en, " Enabled"));
        if (i > 0) head.append(el("button", { onclick: () => { this._draft.solar_plants.splice(i, 1); draw(); this._refresh(); } }, "Remove"));
        box.append(head);
        p.power = p.power || {}; p.energy_today = p.energy_today || {};
        box.append(el("div", { class: "desc" }, "Live solar power"), el("div", { class: "ctl" }, this._entityInput(p.power.entity, ["sensor"], (v) => { p.power.entity = v; this._refresh(); }, "Power (W)")));
        box.append(el("div", { class: "desc" }, "Solar energy today"), el("div", { class: "ctl" }, this._entityInput(p.energy_today.entity, ["sensor"], (v) => { p.energy_today.entity = v; this._refresh(); }, "Energy today (kWh)")));
        const live = el("div", { class: "live" });
        box.append(live);
        p._live = live;
        wrap.append(box);
      });
      wrap.append(el("button", { onclick: () => {
        const taken = this._draft.solar_plants.map((x) => x.id);
        this._draft.solar_plants.push({ id: slugify(`plant ${taken.length + 1}`, taken), name: `Plant ${taken.length + 1}`, forecast: "none", enabled: true, power: {}, energy_today: {} });
        draw(); this._refresh();
      } }, "+ Add solar plant"));
    };
    draw();
    return wrap;
  }

  _refresh() {
    if (!this._built && !this._rows.length) return;
    const states = this._hass.states;
    const mapping = states[MAPPING_SENSOR];
    const checks = ((mapping && mapping.attributes) || {}).checks || {};
    const saved = ((mapping && mapping.attributes) || {}).config || {};
    const savedInputs = saved.inputs || {};
    let blocking = 0;
    const secs = this._sections || {};
    Object.values(secs).forEach((s) => { s.problems = 0; s.unsaved = 0; });
    const tally = (key, field) => { if (key && secs[key]) secs[key][field]++; };
    this._rows.forEach(({ role, spec, live, problem, status, section }) => {
      const s = spec();
      const st = s && s.entity ? states[s.entity] : null;
      const r = readout(role, s, st);
      live.textContent = "";
      if (r.text) live.append("Now: " + r.text);
      if (r.readsAs) live.append(el("span", { class: "reads" }, `(${r.readsAs})`));
      const p = role.required === "yes" || s ? instantProblem(role, s, st) : "";
      problem.textContent = p;
      if (p && (s && (s.value !== undefined || /bump|boost/.test(s.entity || "")))) blocking++;
      const same = JSON.stringify(savedInputs[role.key] || null) === JSON.stringify(s ? JSON.parse(JSON.stringify(buildConfig({ inputs: { [role.key]: s }, features: {}, operation: {} }).inputs[role.key] || null)) : null);
      const c = checks[role.key];
      status.className = "status";
      if (!same) status.textContent = "Unsaved change";
      else if (c) { status.textContent = `PowerEngine check: ${c.message}`; if (c.status === "ok") status.className = "status ok"; }
      else status.textContent = "";
      if (p || (c && same && c.status !== "ok" && c.status !== "unmapped")) tally(section, "problems");
      if (!same) tally(section, "unsaved");
    });
    (this._draft.solar_plants || []).forEach((p) => {
      if (!p._live) return;
      const pw = p.power && states[p.power.entity];
      const en = p.energy_today && states[p.energy_today.entity];
      const f = (x) => (x ? `${x.state} ${(x.attributes || {}).unit_of_measurement || ""}`.trim() : "not set");
      p._live.textContent = `Now: ${f(pw)} · today ${f(en)}`;
    });
    const savedSafety = saved.safety || {};
    (this._settingRows || []).forEach(({ st, problem, section }) => {
      const p = settingProblem(st, this._draft.safety[st.key]);
      problem.textContent = p;
      if (p) { blocking++; tally(section, "problems"); }
      const was = savedSafety[st.key] !== undefined ? savedSafety[st.key] : st.default;
      if (Number(this._draft.safety[st.key]) !== Number(was)) tally(section, "unsaved");
    });
    Object.values(secs).forEach((s) => {
      const parts = [];
      if (s.problems) parts.push(`${s.problems} to check`);
      if (s.unsaved) parts.push(`${s.unsaved} unsaved`);
      s.count.textContent = parts.join(" · ");
      s.count.className = s.problems ? "count bad" : (s.unsaved ? "count" : "count");
    });
    const dirty = JSON.stringify(buildConfig(this._draft)) !== JSON.stringify(buildConfig(initialDraft(saved, [], [], this._settings).draft));
    if (this._saveBtn) {
      this._saveBtn.disabled = this._readOnly || blocking > 0 || this._saving || !dirty;
      this._saveBtn.textContent = this._saving ? "Saving…" : "Save";
    }
    if (this._resetBtn) this._resetBtn.disabled = this._readOnly || !dirty || this._saving;
  }

  _setBanner(kind, text) {
    if (!this._banner) return;
    this._banner.className = `banner ${kind}`;
    this._banner.textContent = text;
  }

  async _save() {
    this._saving = true;
    this._refresh();
    try {
      await this._hass.callWS({ type: "fire_event", event_type: SAVE_EVENT, event_data: { config: buildConfig(this._draft) } });
      this._setBanner("info", "Sent to PowerEngine; waiting for it to check and save…");
      setTimeout(() => { if (this._saving) { this._saving = false; this._setBanner("error", "No reply from PowerEngine. Check the AppDaemon log."); this._refresh(); } }, 15000);
    } catch (e) {
      this._saving = false;
      this._setBanner("error", `Could not send: ${e.message || e}. Saving needs an admin user.`);
      this._refresh();
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("powerengine-config-card")) {
  customElements.define("powerengine-config-card", PowerEngineConfigCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "powerengine-config-card",
    name: "PowerEngine configuration",
    description: "Configure the PowerEngine app (inputs, solar plants, features, mode).",
  });
  console.info(`%c POWERENGINE-CARD %c v${CARD_VERSION} `, "background:#1f6feb;color:#fff", "");
}

if (typeof module !== "undefined") {
  module.exports = { parseSignNote, readout, instantProblem, suggestEntity, initialDraft, buildConfig, slugify, summariseAttribute, settingProblem, CARD_VERSION };
}
