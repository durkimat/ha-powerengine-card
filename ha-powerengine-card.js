/*
 * PowerEngine config card for Home Assistant.
 *
 * Edits PowerEngine's input mappings, solar plants, features and operation
 * mode. Reads the input catalogue from the app (sensor.pe_map_catalogue), so
 * descriptions, units and sign conventions live in one place. Saves by firing
 * an HA event; the app validates, writes config.yaml (with a backup) and
 * reports the result.
 */
const CARD_VERSION = "0.8.7";
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
  ["auto_cheap_threshold", "Automatic cheap threshold", "Work out what counts as cheap from the prices ahead (the bottom fifth of the range, and only if storing it pays), capped by the Cheap import threshold setting."],
  ["fill_when_cheap", "Top up when cheap", "Charge to the grid-charge target in every cheap slot, not just what the forecast needs. A buffer in case the forecast is wrong."],
  ["smart_charge_optimisation", "Smart-charge optimisation", "Ask EDF for extra smart-charge slots by changing the car's ready-by time when it's worth it, with back-off and at most 6 requests a day. Replaces the fixed daily triggers. Sends nothing in Passive mode."],
  ["arbitrage", "Energy arbitrage", "Sell stored energy just before a cheap refill when it pays after losses and wear, keeping enough for the house. In Passive mode this only plans and simulates it, so you can see what it would earn.",
    "Check your export tariff terms first: some only pay for exported solar, not energy bought from the grid."],
  ["axle", "Axle VPP events", "Force-discharge during Axle events and hold charge beforehand."],
  ["free_power_days", "Free-power sessions", "Make full use of EDF free-electricity sessions."],
  ["optimised_plan", "Optimised planning", "The optimiser chooses each half-hour's action for the lowest cost (arbitrage band and safety rules included), with plain-English reasons. Off: the simpler rule-based planner."],
  ["learn_taper", "Learn: charge slow-down near full", "Plan with how much charging slows from 90% and 95%, as seen, so the overnight charge starts early enough to finish. Health tab, Learned from use, shows each learned figure and how many half-hours it's based on."],
  ["learn_reserve", "Learn: where discharging stops", "Plan with the charge level where the battery has been seen to stop supplying the house. Only ever raises the Minimum reserve, never lowers it."],
  ["learn_export", "Learn: export ceiling", "If selling is seen to top out below the battery's own rate (a grid limit), plan with that ceiling."],
  ["learn_car", "Learn: car charge rate", "Plan the car's share of smart-charge slots with its real charging kW instead of Car charger power."],
  ["cold_caution", "Cold battery caution", "Plan a slower charge when the battery is likely to be cold, estimated from the outside temperature (Open-Meteo forecast for your home's location) with a lag, so a cold spell is expected to chill it gradually and it stays cautious until the weather has been milder for a while. Settings under Cold battery."],
  ["cold_learning", "Learn cold behaviour", "Adjust the cold threshold and rate from what's seen: charging slowed at 5°C raises the threshold; charging normally at 3°C lowers it to 3°C."],
  ["tariff_simulator", "Tariff simulator", "Each night at 01:30, compare your recorded days on current Octopus and EDF tariffs (fetched from their public tariff lists) and notify you if one would save noticeably. Reads only; changes nothing."],
];
const NOTIFY_EVENTS = [
  ["health", "Health problems", "When the Health tab finds a problem (checked after start-up and each night).", true],
  ["inputs", "Inputs not working", "When a required input has been unavailable or stale for 15 minutes.", true],
  ["axle", "Axle events", "When an Axle event is scheduled, with its time.", true],
  ["free_power", "Free-power sessions", "When a free-electricity session is announced.", true],
  ["daily", "Daily summary", "Each morning at 08:00: yesterday's cost and savings.", false],
  ["simulator", "Tariff opportunities", "When the overnight Simulator finds a tariff that would have cost noticeably less (at least £5 and 5% a month), or new tariffs appear.", true],
];
const FEATURE_DEFAULTS = { auto_cheap_threshold: true, fill_when_cheap: true, smart_charge_optimisation: true, arbitrage: false, axle: true, free_power_days: true, tariff_simulator: true, optimised_plan: true,
  learn_taper: true, learn_reserve: true, learn_export: true, learn_car: true, cold_caution: true, cold_learning: true };

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
const BATTERY_PAIR = ["battery_charge_power", "battery_discharge_power"];

/** A role as it applies now: with the battery pair mapped, the single sensor is unused and the pair is required. */
function effectiveRole(role, pairMapped) {
  if (!pairMapped) return role;
  if (role.key === "battery_power") return Object.assign({}, role, { required: "unused" });
  if (BATTERY_PAIR.includes(role.key)) return Object.assign({}, role, { required: "yes" });
  return role;
}

// --- Config page layout: one section per topic, holding its switches, inputs, settings and learning ---------
// Anything the app adds that isn't listed here still appears, in "Other".
const TOPICS = [
  { key: "battery", title: "Battery",
    roles: ["battery_soc", "battery_power", "battery_charge_power", "battery_discharge_power", "battery_capacity",
      "battery_max_charge_power", "battery_max_discharge_power", "battery_charge_today", "battery_discharge_today",
      "battery_round_trip", "battery_soh", "inverter_min_soc"],
    settings: ["min_reserve_soc", "grid_charge_target_soc", "charge_hysteresis_soc"],
    learning: ["learn_taper", "learn_reserve"] },
  { key: "grid", title: "Grid and house",
    roles: ["grid_power", "grid_import_today", "grid_export_today", "house_load_power", "house_load_today"],
    settings: ["main_fuse_a"], system: ["house_load_includes_ev"] },
  { key: "solar", title: "Solar", roles: ["solar_forecast_today", "solar_forecast_tomorrow", "solar_forecast_day3"],
    plants: true },
  { key: "tariff", title: "Tariff and planning",
    roles: ["import_rate_now", "import_rates_today", "import_rates_tomorrow", "export_rate", "standing_charge", "offpeak_now"],
    features: ["optimised_plan", "auto_cheap_threshold", "fill_when_cheap"],
    settings: ["cheap_threshold_p", "window_switch_cost_p"] },
  { key: "car", title: "Car and EDF smart charge",
    roles: ["ev_plug_status", "ev_charger_status", "ev_charge_power", "ev_energy_today", "ev_charge_mode",
      "ev_session_energy", "smart_dispatches", "smart_state", "smart_target_soc", "smart_target_time"],
    features: ["smart_charge_optimisation"], settings: ["ev_charger_kw"], learning: ["learn_car"] },
  { key: "selling", title: "Selling (arbitrage and export)", features: ["arbitrage"],
    settings: ["export_limit_kw", "battery_wear_p", "arbitrage_min_margin_p", "arbitrage_min_soc", "arbitrage_max_soc",
      "arbitrage_band_penalty_p"],
    roles: ["inverter_export_limit"], learning: ["learn_export"] },
  { key: "axle", title: "Axle events", main: "axle", features: ["axle"],
    roles: ["axle_event_active", "axle_event_start", "axle_event_end", "axle_direction"],
    settings: ["pre_axle_lookahead_h", "axle_margin_soc"] },
  { key: "free", title: "Free-power sessions", main: "free_power_days", features: ["free_power_days"],
    roles: ["free_power_active", "free_power_next_start", "free_power_next_end"] },
  { key: "cold", title: "Cold battery", main: "cold_caution", features: ["cold_caution"], learning: ["cold_learning"],
    system: ["battery_location"],
    settings: ["cold_caution_temp_c", "cold_charge_pct", "cold_release_c", "battery_temp_lag_h"],
    roles: ["outside_temperature", "battery_temperature"] },
  { key: "control", title: "Inverter control (needed to go live)",
    note: "Written only when PowerEngine is live. Map them now so it can show what it would set (Health tab) and count your current setup's writes. Windows 2 and 3 are found from window 1's entities.",
    roles: ["timed_charge_start_hour", "timed_charge_start_minute", "timed_charge_end_hour", "timed_charge_end_minute",
      "timed_charge_current", "timed_discharge_start_hour", "timed_discharge_start_minute", "timed_discharge_end_hour",
      "timed_discharge_end_minute", "timed_discharge_current", "timed_update_button", "storage_mode",
      "inverter_clock", "inverter_clock_sync", "guard_read_only", "guard_off_1", "guard_off_2"],
    settings: ["max_writes_per_day"] },
  { key: "simulator", title: "Tariff simulator", main: "tariff_simulator", features: ["tariff_simulator"] },
];
// needed before PowerEngine can go live (the rest of the control group is optional)
const GO_LIVE = ["timed_charge_start_hour", "timed_charge_start_minute", "timed_charge_end_hour", "timed_charge_end_minute",
  "timed_charge_current", "timed_discharge_start_hour", "timed_discharge_start_minute", "timed_discharge_end_hour",
  "timed_discharge_end_minute", "timed_discharge_current", "timed_update_button", "storage_mode", "guard_read_only"];
const NEEDED_FOR = { axle: "axle", free_power: "free_power_days" };
const ROLE_FEATURE = { smart_target_soc: "smart_charge_optimisation", smart_target_time: "smart_charge_optimisation" };

/** Where every role, setting and feature goes: TOPICS with anything unlisted gathered into "Other". */
function topicPlan(roleKeys, settingKeys, featureKeys, systemKeys) {
  const used = { roles: new Set(), settings: new Set(), features: new Set(), system: new Set() };
  const topics = TOPICS.map((t) => {
    const pick = (list, have, kind) => (list || []).filter((k) => have.includes(k) && !used[kind].has(k) && used[kind].add(k));
    return Object.assign({}, t, {
      roles: pick(t.roles, roleKeys, "roles"), settings: pick(t.settings, settingKeys, "settings"),
      features: pick(t.features, featureKeys, "features"), learning: pick(t.learning, featureKeys, "features"),
      system: pick(t.system, systemKeys, "system") });
  });
  const other = { key: "other", title: "Other",
    roles: roleKeys.filter((k) => !used.roles.has(k)), settings: settingKeys.filter((k) => !used.settings.has(k)),
    features: featureKeys.filter((k) => !used.features.has(k)), learning: [],
    system: systemKeys.filter((k) => !used.system.has(k)) };
  if (other.roles.length || other.settings.length || other.features.length || other.system.length) topics.push(other);
  return topics;
}

/** How much a role matters right now: "req" (required), "cond" (required only for something not in use),
 *  "opt" (optional) or "unused"; with the badge text. */
function roleNeed(role, draft, pairMapped) {
  const r = effectiveRole(role, pairMapped);
  const features = (draft && draft.features) || {};
  const live = ((draft && draft.operation) || {}).mode === "active";
  if (r.required === "unused") return { level: "unused", badge: "Not used" };
  if (r.required === "yes") return { level: "req", badge: "Required" };
  const f = NEEDED_FOR[r.required] || ROLE_FEATURE[r.key];
  if (f) {
    const label = (FEATURES.find((x) => x[0] === f) || [0, f])[1];
    return features[f] ? { level: "req", badge: `Required for ${label}` } : { level: "cond", badge: `Needed for ${label}` };
  }
  if (GO_LIVE.includes(r.key)) return live ? { level: "req", badge: "Required to go live" } : { level: "cond", badge: "Needed to go live" };
  return { level: "opt", badge: "Optional" };
}

/** Does a row's text match the search (every word, any order, ignoring case)? */
function matchesSearch(text, query) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(text || "").toLowerCase();
  return words.every((w) => t.includes(w));
}

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
  const n = draft.notifications || {};
  const events = {};
  NOTIFY_EVENTS.forEach(([k, , , d]) => { events[k] = (n.events || {})[k] !== undefined ? !!n.events[k] : d; });
  draft.notifications = { service: n.service || "", events };
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

/** "(18.08 kWh measured)" / "(not measured yet)" for a measurable input, from PowerEngine's diagnostic sensor. */
function measuredText(hass, key) {
  const src = {
    battery_capacity: ["sensor.pe_diag_battery_capacity", (st) => `${Number(st.state).toFixed(2)} kWh`],
    battery_round_trip: ["sensor.pe_diag_battery_efficiency", (st) => st.attributes.measured_round_trip != null
      ? `${Number(st.attributes.measured_round_trip).toFixed(1)}%` : null],
  }[key];
  const learnedKw = (field) => {
    const st = hass && hass.states["sensor.pe_diag_learned"];
    const v = st && st.attributes && st.attributes.raw ? st.attributes.raw[field] : null;
    return v != null ? `${Number(v).toFixed(2)} kW` : null;
  };
  if (key === "battery_max_charge_power" || key === "battery_max_discharge_power") {
    const text = learnedKw(key === "battery_max_charge_power" ? "max_charge_kw" : "max_discharge_kw");
    return text ? `(${text} measured)` : "(not measured yet)";
  }
  const st = hass && src && hass.states[src[0]];
  const text = st && st.attributes && st.attributes.measured ? src[1](st) : null;
  return text ? `(${text} measured)` : "(not measured yet)";
}

/** The config object to save: drop empty inputs, keep everything else. */
function buildConfig(draft) {
  const inputs = {};
  Object.entries(draft.inputs || {}).forEach(([k, spec]) => {
    if (!spec) return;
    if (spec.value !== undefined && spec.value !== "") {
      inputs[k] = { value: toNumber(spec.value) ?? spec.value };
      if (typeof spec.use_measured === "boolean") inputs[k].use_measured = spec.use_measured;
    }
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
  if (draft.notifications && draft.notifications.service) {
    out.notifications = { service: draft.notifications.service, events: Object.assign({}, draft.notifications.events) };
  }
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
    // roles leave out "required" when it is "yes" (keeps the published catalogue under HA's 16 KB limit)
    this._catalogue = Object.assign({}, cat.attributes,
      { roles: (cat.attributes.roles || []).map((r) => Object.assign({ required: "yes" }, r)) });
    const mapping = s[MAPPING_SENSOR];
    this._saved = ((mapping && mapping.attributes) || {}).config || {};
    // settings moved to their own sensor in app 0.5.3 (older apps sent them inside the catalogue)
    const settingsSensor = s["sensor.pe_map_settings"];
    this._settings = this._catalogue.settings || (settingsSensor && settingsSensor.attributes) || {};
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
      .suggest { font-size: .85em; color: var(--secondary-text-color); margin-top: 4px; }
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
      h4.sub { margin: 14px 0 2px; font-size: .8em; text-transform: uppercase; letter-spacing: .05em; color: var(--secondary-text-color); }
      .toolbar { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 8px; }
      input.search { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 18px; }
      .chips { display: flex; gap: 6px; flex-wrap: wrap; }
      .chip { padding: 3px 10px; border-radius: 14px; font-size: .85em; }
      .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
      .toolrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
      .toolrow .tools { margin: 0; }
      button.summary { background: none; border: none; padding: 2px 0; font-weight: 500; text-align: left; }
      button.summary.good { color: var(--success-color, #43a047); cursor: default; }
      button.summary.bad { color: var(--error-color, #db4437); }
      .nomatch { padding: 8px 0; }
      .row { border-left: 4px solid transparent; padding-left: 10px; }
      .row.plain { border-left: none; padding-left: 0; }
      .row.req-ok { border-left-color: var(--success-color, #43a047); }
      .row.req-bad { border-left-color: var(--error-color, #db4437); background: rgba(219, 68, 55, .06); }
      .row.cond { border-left-color: var(--warning-color, #ffa000); }
      .row.opt, .row.unused { border-left-color: var(--divider-color); }
      .row.unused { opacity: .6; }
      .row.feature { border-left-color: var(--primary-color); }
      .badge.req { background: var(--error-color, #db4437); color: #fff; }
      .row.req-ok .badge.req { background: var(--success-color, #43a047); }
      .badge.cond { background: rgba(255, 160, 0, .18); color: var(--warning-color, #b26a00); }
      .badge.opt { background: none; border: 1px solid var(--divider-color); }
      .badge.sw { background: none; border: 1px solid var(--primary-color); color: var(--primary-color); }
      details.section .count.good { color: var(--success-color, #43a047); }
      details.section.off > summary .title { color: var(--secondary-text-color); }
      .offnote { color: var(--secondary-text-color); font-style: italic; font-size: .9em; margin: 6px 0; }
      details.section.off .row:not(.feature) { opacity: .55; }
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

    // search, filters and the overall status
    this._items = [];                                      // every row, for search and filters
    this._query = this._query || "";
    this._filter = this._filter || "all";
    const search = el("input", { type: "search", class: "search", placeholder: "Search settings and inputs (name, description or entity)",
      value: this._query, oninput: (ev) => { this._query = ev.target.value; this._applyFilter(); } });
    const chips = el("div", { class: "chips" });
    [["all", "All"], ["attention", "Needs attention"], ["req", "Required"], ["opt", "Optional"]].forEach(([k, label]) => {
      chips.append(el("button", { class: `chip${this._filter === k ? " on" : ""}`, "data-k": k, onclick: () => {
        this._filter = k;
        chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.k === k));
        this._applyFilter();
      } }, label));
    });
    this._summary = el("button", { class: "summary", onclick: () => this._jumpToProblem() });
    this._noMatch = el("div", { class: "muted nomatch" }, "Nothing matches.");
    const tools = el("div", { class: "tools" },
      el("button", { class: "link", onclick: () => this._toggleAll(true) }, "Expand all"),
      el("button", { class: "link", onclick: () => this._toggleAll(false) }, "Collapse all"));
    content.append(el("div", { class: "toolbar" }, search, chips, el("div", { class: "toolrow" }, this._summary, tools)), this._noMatch);

    // collapsible sections (open state kept across rebuilds and page loads)
    this._sections = {};
    const section = (key, title, note) => {
      const count = el("span", { class: "count" });
      const body = el("div", { class: "body" });
      const d = el("details", { class: "section" }, el("summary", {}, el("span", { class: "title" }, title), count), body);
      d.open = this._openSections().has(key);
      d.addEventListener("toggle", () => { if (!this._filtering) this._rememberOpen(key, d.open); });
      if (note) body.append(el("div", { class: "desc" }, note));
      this._sections[key] = { details: d, count, problems: 0, unsaved: 0, req: 0, reqOk: 0, opt: 0, body };
      this._currentSection = key;
      content.append(d);
      return body;
    };
    const track = (node, kind, text) => {
      node.dataset.kind = kind;
      this._items.push({ node, kind, text: text.toLowerCase(), section: this._currentSection });
      return node;
    };
    const featureRow = (key) => {
      const f = FEATURES.find((x) => x[0] === key);
      if (!f) return null;
      const [, label, desc, warning] = f;
      const cb = el("input", { type: "checkbox", onchange: (ev) => { this._draft.features[key] = ev.target.checked; this._refresh(); } });
      cb.checked = !!this._draft.features[key];
      return track(el("div", { class: "row feature" }, el("label", { class: "head" }, cb, el("span", { class: "label" }, label),
        el("span", { class: "badge sw" }, "Switch")), el("div", { class: "desc" }, desc),
        warning ? el("div", { class: "warning" }, `⚠ ${warning}`) : null), "feature", `${label} ${desc} ${key}`);
    };
    const systemRow = (key) => {
      const st = (this._settings.system || []).find((x) => x.key === key);
      if (!st) return null;
      if (st.options) return track(this._choiceRow(st), "setting", `${st.label} ${st.help} ${key}`);
      const cb = el("input", { type: "checkbox", onchange: (ev) => { this._draft.system[st.key] = ev.target.checked; this._refresh(); } });
      cb.checked = !!this._draft.system[st.key];
      return track(el("div", { class: "row" }, el("label", { class: "head" }, cb, el("span", { class: "label" }, st.label)),
        el("div", { class: "desc" }, st.help)), "setting", `${st.label} ${st.help} ${key}`);
    };
    const sub = (body, title) => { const h = el("h4", { class: "sub" }, title); body.append(h); return h; };

    // operation
    let body = section("operation", "Operation");
    const activeWarn = el("div", { class: "warning" }, "⚠ Live: PowerEngine writes the inverter's timed charge and discharge settings (and, with smart-charge optimisation on, asks EDF for slots). It only goes live when every handover guard is safe. Normally set by the Battery controller panel above; pause any time from the Monitoring tab.");
    const modeSel = el("select", { onchange: (ev) => {
      this._draft.operation.mode = ev.target.value;
      activeWarn.style.display = ev.target.value === "active" ? "" : "none";
      this._refresh();
    } },
      el("option", { value: "passive" }, "Passive: monitor and simulate, never control"),
      el("option", { value: "active" }, "Active: PowerEngine controls the inverter"));
    modeSel.value = this._draft.operation.mode === "active" ? "active" : "passive";
    activeWarn.style.display = modeSel.value === "active" ? "" : "none";
    body.append(track(el("div", { class: "row" }, el("div", { class: "head" }, el("span", { class: "label" }, "Operation mode")),
      el("div", { class: "ctl" }, modeSel), activeWarn), "setting", "operation mode passive active live"));

    // one section per topic
    const roles = this._catalogue.roles;
    const byKey = Object.fromEntries(roles.map((r) => [r.key, r]));
    const allSettings = this._settings.safety || [];
    const settingByKey = Object.fromEntries(allSettings.map((x) => [x.key, x]));
    this._settingRows = [];
    const plan = topicPlan(roles.map((r) => r.key), allSettings.map((x) => x.key), FEATURES.map((f) => f[0]),
      (this._settings.system || []).map((x) => x.key));
    plan.forEach((t) => {
      const body = section(`topic_${t.key}`, t.title, t.note);
      this._sections[`topic_${t.key}`].main = t.main;
      t.features.forEach((k) => { const r = featureRow(k); if (r) body.append(r); });
      if (t.main) body.append(this._sections[`topic_${t.key}`].offNote = el("div", { class: "offnote" },
        "Switched off: the inputs and settings below aren't used."));
      const inTopic = t.roles.map((k) => byKey[k]).filter(Boolean);
      const pair = BATTERY_PAIR.every((k) => (this._draft.inputs[k] || {}).entity);
      const need = (r) => roleNeed(r, this._draft, pair).level;
      const firstly = inTopic.filter((r) => need(r) !== "opt");
      const optional = inTopic.filter((r) => need(r) === "opt");
      const suggestable = inTopic.filter((r) => this._suggestion(r));
      if (suggestable.length > 1 && !this._readOnly) {
        body.append(el("div", { class: "row plain" }, el("button", { onclick: () => this._useSuggestions(suggestable) },
          `Use all ${suggestable.length} suggested entities`), el("span", { class: "muted" }, " (then check each and Save)")));
      }
      if (firstly.length) {
        sub(body, t.key === "control" ? "Needed to go live" : "Inputs");
        firstly.forEach((r) => body.append(this._roleRow(r)));
      }
      if (optional.length) {
        sub(body, "Optional inputs");
        optional.forEach((r) => body.append(this._roleRow(r)));
      }
      if (t.plants) { sub(body, "Solar plants"); body.append(track(this._plantsSection(), "setting", "solar plants array power energy forecast")); }
      const sets = t.settings.map((k) => settingByKey[k]).filter(Boolean);
      if (sets.length || t.system.length) {
        sub(body, "Settings");
        t.system.forEach((k) => { const r = systemRow(k); if (r) body.append(r); });
        sets.forEach((st) => body.append(track(this._settingRow(st), "setting", `${st.label} ${st.help} ${st.key}`)));
      }
      if (t.learning.length) {
        sub(body, "Learning");
        t.learning.forEach((k) => { const r = featureRow(k); if (r) body.append(r); });
      }
    });

    // phone notifications
    const nb = section("notifications", "Notifications",
      "Sent to your phone through the Home Assistant companion app. Nothing is sent until you choose a notify service.");
    const services = Object.keys((this._hass.services || {}).notify || {}).sort();
    const svcSel = el("select", { onchange: (ev) => { this._draft.notifications.service = ev.target.value ? `notify.${ev.target.value}` : ""; this._refresh(); } },
      el("option", { value: "" }, "Off (no notifications)"),
      services.map((s) => el("option", { value: s }, s)));
    const curSvc = (this._draft.notifications.service || "").replace(/^notify\./, "");
    if (curSvc && !services.includes(curSvc)) svcSel.append(el("option", { value: curSvc }, `${curSvc} (not found)`));
    svcSel.value = curSvc;
    nb.append(track(el("div", { class: "row" }, el("div", { class: "head" }, el("span", { class: "label" }, "Send to")),
      el("div", { class: "desc" }, "Your phone's notify service, usually notify.mobile_app_<phone name>."), el("div", { class: "ctl" }, svcSel)),
      "setting", "notifications send to notify service phone"));
    NOTIFY_EVENTS.forEach(([key, label, desc]) => {
      const cb = el("input", { type: "checkbox", onchange: (ev) => { this._draft.notifications.events[key] = ev.target.checked; this._refresh(); } });
      cb.checked = !!this._draft.notifications.events[key];
      nb.append(track(el("div", { class: "row" }, el("label", { class: "head" }, cb, el("span", { class: "label" }, label)), el("div", { class: "desc" }, desc)),
        "setting", `notification ${label} ${desc}`));
    });
    this._currentSection = null;

    // actions
    this._saveBtn = el("button", { class: "primary", onclick: () => this._save() }, "Save");
    this._resetBtn = el("button", { onclick: () => { this._built = false; this._maybeBuild(); } }, "Discard changes");
    content.append(el("div", { class: "actions" }, el("span", { class: "muted" }, `Card v${CARD_VERSION}`), this._resetBtn, this._saveBtn));

    root.append(this._style(), el("ha-card", { header: "PowerEngine configuration" }, content));
    if (this._readOnly) {
      content.querySelectorAll("input:not(.search), select, button:not(.link):not(.chip):not(.summary)").forEach((n) => { n.disabled = true; });
      this._pickers.forEach((pk) => { pk.disabled = true; });
    }
    this._refresh();
    // open any section that needs attention
    Object.values(this._sections).forEach((s) => { if (s.problems) s.details.open = true; });
    this._applyFilter();
  }

  /** Search and filter chips: show matching rows only, opening their sections; restore when cleared. */
  _applyFilter() {
    const q = (this._query || "").trim();
    const f = this._filter || "all";
    const active = !!q || f !== "all";
    const shown = {};
    (this._items || []).forEach((it) => {
      const n = it.node;
      const kindOk = f === "all" || (f === "attention" && n.classList.contains("req-bad"))
        || (f === "req" && (it.kind === "req" || it.kind === "cond")) || (f === "opt" && it.kind === "opt");
      const ok = kindOk && (!q || matchesSearch(`${it.text} ${n.dataset.entity || ""}`, q));
      n.style.display = ok ? "" : "none";
      if (ok) shown[it.section] = (shown[it.section] || 0) + 1;
    });
    this._filtering = true;
    Object.entries(this._sections || {}).forEach(([key, s]) => {
      s.details.style.display = !active || shown[key] ? "" : "none";
      s.body.querySelectorAll("h4.sub").forEach((h) => { h.style.display = active ? "none" : ""; });
      if (active) s.details.open = !!shown[key];
      else s.details.open = this._openSections().has(key) || !!s.problems;
    });
    this._filtering = false;
    if (this._noMatch) this._noMatch.style.display = active && !Object.keys(shown).length ? "" : "none";
  }

  _jumpToProblem() {
    const first = (this._items || []).find((it) => it.node.classList.contains("req-bad"));
    if (!first) return;
    const s = this._sections[first.section];
    if (s) s.details.open = true;
    first.node.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  _choiceRow(st) {
    const sel = el("select", { onchange: (ev) => { this._draft.system[st.key] = ev.target.value; this._refresh(); } });
    st.options.forEach(([value, label]) => sel.append(el("option", { value }, label)));
    sel.value = this._draft.system[st.key] !== undefined ? this._draft.system[st.key] : st.default;
    return el("div", { class: "row" },
      el("div", { class: "head" }, el("span", { class: "label" }, st.label)),
      el("div", { class: "desc" }, st.help), el("div", { class: "ctl" }, sel));
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

  /** The pre-filled suggestion for an unmapped role (entity id), or "". */
  _suggestion(role) {
    const cur = this._draft.inputs[role.key];
    if (cur && (cur.entity || cur.value !== undefined) || role.kind === "static") return "";
    return suggestEntity(role, Object.keys(this._hass.states));
  }

  _useSuggestions(roles) {
    roles.forEach((r) => { const id = this._suggestion(r); if (id) this._draft.inputs[r.key] = { entity: id }; });
    this._build();                                        // redraw with the new values (open sections are kept)
  }

  _roleRow(role) {
    const spec = () => this._draft.inputs[role.key];
    const set = (v) => { if (v) this._draft.inputs[role.key] = v; else delete this._draft.inputs[role.key]; this._refresh(); };
    const row = el("div", { class: "row" });
    const badgeBox = el("span", {});
    const item = { node: row, kind: "opt", text: `${role.label} ${role.description} ${role.key}`.toLowerCase(),
      section: this._currentSection };
    (this._items = this._items || []).push(item);
    row.append(el("div", { class: "head" }, el("span", { class: "label" }, role.label), badgeBox));
    row.append(el("div", { class: "desc" }, role.description));
    const ctl = el("div", { class: "ctl" });
    const cur = spec() || {};
    const isStatic = role.kind === "static" || (role.static_ok && cur.value !== undefined);

    const staticInput = el("input", { type: "number", step: "any", value: cur.value !== undefined ? cur.value : "", onchange: (ev) => {
      const prev = spec() || {};
      set(ev.target.value === "" ? null : Object.assign({ value: ev.target.value }, typeof prev.use_measured === "boolean" ? { use_measured: prev.use_measured } : {}));
    } });
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

    if (role.measurable) {
      // PowerEngine measures this (e.g. usable capacity); ticked = use the measured figure once there is one
      const cb = el("input", { type: "checkbox", onchange: (ev) => {
        const s = spec();
        if (s && s.value !== undefined) s.use_measured = ev.target.checked;
        else {                                   // no figure entered yet: keep the default alongside the choice
          set({ value: role.suggest_static, use_measured: ev.target.checked });
          staticInput.value = role.suggest_static;
        }
        this._refresh();
      } });
      cb.checked = cur.use_measured !== false;
      ctl.append(el("label", { title: "Once PowerEngine has measured it (Health tab), use the measured figure instead of this one" }, cb, " Use measured ",
        el("span", { class: "muted" }, measuredText(this._hass, role.key))));
    }

    let invertCb = null;
    if (role.signed) {
      invertCb = el("input", { type: "checkbox", onchange: (ev) => { const s = spec(); if (s && s.entity) { s.invert = ev.target.checked; if (!s.invert) delete s.invert; this._refresh(); } } });
      invertCb.checked = !!cur.invert;
      ctl.append(el("label", {}, invertCb, " Invert"));
    }
    row.append(ctl);
    const hint = this._suggestion(role);
    if (hint && !this._readOnly) {
      row.append(el("div", { class: "suggest" }, "Suggested: ",
        el("button", { class: "link", onclick: () => this._useSuggestions([role]) }, hint)));
    }
    let signNote = null;
    if (role.signed) {
      const w = parseSignNote(role.sign_note);
      signNote = el("div", { class: "sign" }, `PowerEngine expects: + = ${w.pos}, − = ${w.neg}. Tick Invert if your entity reports it the other way round.`);
      row.append(signNote);
    }
    const live = el("div", { class: "live" });
    const problem = el("div", { class: "problem" });
    const status = el("div", { class: "status" });
    row.append(live, problem, status);
    this._rows.push({ role, spec, live, problem, status, section: this._currentSection, badgeBox, signNote, invertCb, row, item });
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
    Object.values(secs).forEach((s) => { s.problems = 0; s.unsaved = 0; s.req = 0; s.reqOk = 0; s.opt = 0; s.cond = 0; s.condOk = 0; });
    let reqBad = 0;
    const tally = (key, field) => { if (key && secs[key]) secs[key][field]++; };
    // separate charging/discharging sensors replace an unsigned battery power sensor (and become required)
    const pair = BATTERY_PAIR.every((k) => (this._draft.inputs[k] || {}).entity);
    this._rows.forEach(({ role: baseRole, spec, live, problem, status, section, badgeBox, signNote, invertCb, row, item }) => {
      const s = spec();
      const need = roleNeed(baseRole, this._draft, pair);
      const role = Object.assign({}, effectiveRole(baseRole, pair), need.level === "req" ? { required: "yes" } : {});
      const unused = need.level === "unused";
      badgeBox.replaceChildren(el("span", { class: `badge ${need.level}` }, need.badge));
      if (item) item.kind = need.level === "unused" ? "opt" : need.level;
      if (row) row.dataset.entity = (s && s.entity) || "";
      if (signNote) signNote.style.display = unused ? "none" : "";
      if (invertCb) invertCb.parentElement.style.display = unused ? "none" : "";
      if (unused) {
        live.textContent = "Not used: Battery charging power and Battery discharging power are mapped, so PowerEngine uses those.";
        problem.textContent = "";
        status.textContent = "";
        if (row) row.className = "row unused";
        return;
      }
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
      const bad = !!p || (c && same && c.status !== "ok" && c.status !== "unmapped");
      if (bad) tally(section, "problems");
      if (!same) tally(section, "unsaved");
      const mapped = !!(s && (s.entity || s.value !== undefined));
      if (need.level === "req") { tally(section, "req"); if (mapped && !bad) tally(section, "reqOk"); else reqBad++; }
      else if (need.level === "cond") { tally(section, "cond"); if (mapped && !bad) tally(section, "condOk"); }
      else tally(section, "opt");
      if (row) row.dataset.kind = item ? item.kind : "";
      if (row) row.className = `row ${need.level === "req" ? (mapped && !bad ? "req-ok" : "req-bad")
        : need.level === "cond" ? (bad ? "req-bad" : "cond") : (bad ? "req-bad" : "opt")}`;
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
      if (s.req) parts.push(s.reqOk === s.req ? `${s.req} required ✓` : `${s.reqOk} of ${s.req} required set`);
      if (s.cond) parts.push(s.condOk === s.cond ? `${s.cond} for going live ✓` : `${s.cond - s.condOk} of ${s.cond} for going live not set`);
      if (s.opt) parts.push(`${s.opt} optional`);
      if (s.unsaved) parts.push(`${s.unsaved} unsaved`);
      const off = s.main && !this._draft.features[s.main];
      if (off) parts.unshift("off");
      s.count.textContent = parts.join(" · ");
      s.count.className = s.problems || s.reqOk < s.req ? "count bad" : (s.req && !off ? "count good" : "count");
      s.details.classList.toggle("off", !!off);
      if (s.offNote) s.offNote.style.display = off ? "" : "none";
    });
    if (this._summary) {
      this._summary.textContent = reqBad ? `⚠ ${reqBad} required input${reqBad === 1 ? " needs" : "s need"} attention: show` : "✓ All required inputs are set";
      this._summary.className = reqBad ? "summary bad" : "summary good";
    }
    if (this._filter === "attention" || this._query) this._applyFilter();
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

/* ------------------------------------------------------------ toggle card
 * A small, discreet header row for PowerEngine dashboards: an optional title on the left and a compact switch
 * on the right. No card box. Used for the Costs tab's number alignment.
 *   type: custom:powerengine-toggle-card
 *   title: Costs
 *   entity: switch.pe_ui_right_align
 *   name: Alignment
 *   icon_on: mdi:format-align-right     (optional)
 *   icon_off: mdi:format-align-left     (optional)
 */
class PowerEngineToggleCard extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {
  setConfig(config) {
    if (!config || !config.entity) throw new Error("entity is required");
    this._config = config;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() { return 1; }

  getGridOptions() { return { columns: "full", rows: 1, min_rows: 1 }; }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const c = this._config;
    const st = this._hass && this._hass.states[c.entity];
    const on = !!st && st.state === "on";
    const icon = on ? (c.icon_on || "mdi:format-align-right") : (c.icon_off || "mdi:format-align-left");
    if (!this._built) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          .bar { display: flex; align-items: center; justify-content: space-between; min-height: 40px; }
          .title { font-size: var(--ha-font-size-xl, 1.3em); color: var(--primary-text-color); }
          .ctl { display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 8px; border-radius: 16px;
                 color: var(--secondary-text-color); font-size: .9em; cursor: pointer; user-select: none; }
          .ctl:hover { background: var(--secondary-background-color); }
          ha-icon { --mdc-icon-size: 18px; }
          .sw { position: relative; width: 30px; height: 16px; border-radius: 8px; background: var(--disabled-color, #bdbdbd);
                transition: background .15s; flex: none; }
          .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
                       background: #fff; transition: left .15s; }
          .sw.on { background: var(--primary-color); }
          .sw.on::after { left: 16px; }
        </style>
        <div class="bar"><span class="title"></span>
          <span class="ctl" role="switch" tabindex="0"><ha-icon></ha-icon><span class="name"></span><span class="sw"></span></span>
        </div>`;
      const ctl = this.shadowRoot.querySelector(".ctl");
      const toggle = () => {
        if (!this._hass) return;
        const cur = this._hass.states[this._config.entity];
        const svc = cur && cur.state === "on" ? "turn_off" : "turn_on";
        this._hass.callService(this._config.entity.split(".")[0], svc, { entity_id: this._config.entity });
      };
      ctl.addEventListener("click", toggle);
      ctl.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
      this._built = true;
    }
    this.shadowRoot.querySelector(".title").textContent = c.title || "";
    this.shadowRoot.querySelector(".name").textContent = c.name || "";
    this.shadowRoot.querySelector("ha-icon").setAttribute("icon", icon);
    const sw = this.shadowRoot.querySelector(".sw");
    sw.className = on ? "sw on" : "sw";
    const ctl = this.shadowRoot.querySelector(".ctl");
    ctl.setAttribute("aria-checked", on ? "true" : "false");
    ctl.title = st ? `${c.name || c.entity}: ${on ? "on" : "off"}` : `${c.entity} not found`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("powerengine-toggle-card")) {
  customElements.define("powerengine-toggle-card", PowerEngineToggleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "powerengine-toggle-card", name: "PowerEngine toggle", description: "A discreet title + switch row." });
}

// --- Battery controller handover ---------------------------------------------------------------------------
// Switches between Predbat and PowerEngine through input_select.battery_controller (docs/ha/
// powerengine_handover.yaml runs the handover scripts). Shows what each related entity should be for the chosen
// controller, so a half-finished or manually undone handover is obvious and can be re-applied.
const HANDOVER_DEFAULTS = {
  selector: "input_select.battery_controller",
  read_only: "switch.predbat_set_read_only",
  pause: "switch.pe_ctl_pause",
  mode: "sensor.pe_state_operation_mode",
  scripts: { PowerEngine: "script.battery_handover_to_powerengine", Predbat: "script.battery_handover_to_predbat" },
  legacy: [
    "automation.charge_house_battery_on", "automation.charge_house_battery_off",
    "automation.discharge_house_battery_on", "automation.discharge_house_battery_off",
    "automation.house_battery_start_charging", "automation.house_battery_stop_charging",
    "automation.house_battery_start_charging_2", "automation.house_battery_stop_charging_2",
  ],
};
const CONTROLLERS = ["Predbat", "PowerEngine"];
const HANDOVER_STEPS = {
  PowerEngine: "Predbat goes read-only, the legacy automations stay off, and PowerEngine is set to Active and " +
    "un-paused. About 20 seconds. PowerEngine is then live; you'll get a notification saying so, or why not.",
  Predbat: "PowerEngine is set to Passive and closes its inverter windows (Self-Use), then Predbat leaves read-only " +
    "and takes over at its next update. About 30 seconds. Predbat is then live.",
};

// Rows of {label, want, have, ok, note} for the controller currently selected (ok null = not a fault / unknown),
// plus a one-line status: live, paused (for testing) or not live.
function handoverRows(states, cfg) {
  const c = Object.assign({}, HANDOVER_DEFAULTS, cfg || {});
  const st = (id) => (states && states[id]) || null;
  const val = (id) => (st(id) ? st(id).state : "missing");
  const sel = val(c.selector);
  const toPE = sel === "PowerEngine";
  const rows = [];
  const add = (label, want, have, ok, note) => rows.push({ label, want, have, ok, note: note || "" });
  const known = (v) => !["missing", "unknown", "unavailable"].includes(v);

  const ro = val(c.read_only);
  if (!known(ro) && toPE) {
    // Predbat isn't connected to HA, so it can't be controlling the inverter: PowerEngine counts this as safe
    add("Predbat read-only", "on", ro, true, "Predbat isn't connected to Home Assistant right now, so it can't be " +
      "controlling the inverter; PowerEngine carries on. Restart the Predbat add-on to bring it back.");
  } else {
    add("Predbat read-only", toPE ? "on" : "off", ro, known(ro) ? ro === (toPE ? "on" : "off") : null,
      known(ro) ? "" : "Home Assistant doesn't have this entity right now (Predbat not running, or still starting).");
  }

  const on = c.legacy.filter((id) => val(id) === "on");
  const found = c.legacy.filter((id) => st(id));
  add("Legacy automations", "all off", found.length ? (on.length ? `${on.length} on` : "all off") : "not found",
      found.length ? on.length === 0 : null,
      on.length ? on.map((id) => id.replace("automation.", "")).join(", ") : "");

  const pz = val(c.pause);
  const paused = toPE && pz === "on";
  add("PowerEngine paused", "off", pz, paused ? null : (known(pz) ? pz === "off" : null),
      paused ? "Paused for testing: nothing is driving the battery (Self-Use). Resume to go live again." : "");

  const m = val(c.mode);
  const reason = (st(c.mode) && st(c.mode).attributes && st(c.mode).attributes.reason) || "";
  if (toPE) {
    add("PowerEngine mode", "active", m, paused && m === "paused" ? null : (known(m) ? m === "active" : null),
        m === "active" || m === "paused" ? "" : reason);
  } else {
    add("PowerEngine mode", "passive", m, known(m) ? !["active", "paused"].includes(m) : null,
        m === "active" ? reason : "");
  }
  // a row we can't read (entity missing or unavailable) means we can't vouch for the handover: not live
  const bad = rows.some((r) => r.ok === false || (r.ok === null && !(paused && r.label.startsWith("PowerEngine"))));
  const status = bad ? "not_live" : paused ? "paused" : "live";
  return { selected: sel, rows, allOk: !bad, paused, status };
}

class PowerEngineHandoverCard extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {
  setConfig(config) {
    this._config = config || {};
    this._c = Object.assign({}, HANDOVER_DEFAULTS, this._config);
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() { return 5; }

  _busy() {
    const s = this._hass && this._hass.states;
    return !!s && Object.values(this._c.scripts).some((id) => s[id] && s[id].state === "on");
  }

  async _switch(target) {
    this._confirm = null;
    try {
      await this._hass.callService("input_select", "select_option", { entity_id: this._c.selector, option: target });
      this._msg = "";
    } catch (err) {
      this._msg = "Could not switch: " + ((err && err.message) || err);
    }
    this._render();
  }

  async _pause(on) {
    try {
      await this._hass.callService("switch", on ? "turn_on" : "turn_off", { entity_id: this._c.pause });
      this._msg = "";
    } catch (err) {
      this._msg = "Could not change pause: " + ((err && err.message) || err);
    }
    this._render();
  }

  async _reapply(sel) {
    try {
      await this._hass.callService("script", "turn_on", { entity_id: this._c.scripts[sel] });
      this._msg = "";
    } catch (err) {
      this._msg = "Could not re-apply: " + ((err && err.message) || err);
    }
    this._render();
  }

  _render() {
    if (!this.shadowRoot || !this._c) return;
    if (!this._built) {
      this.shadowRoot.innerHTML = `
        <style>
          ha-card { padding: 16px; }
          h2 { margin: 0 0 8px; font-size: 1.2em; font-weight: 500; }
          p { margin: 4px 0 10px; color: var(--secondary-text-color); }
          .seg { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 18px; overflow: hidden; }
          .seg button { font: inherit; padding: 6px 16px; border: 0; background: none; color: var(--primary-text-color);
                        cursor: pointer; }
          .seg button.on { background: var(--primary-color); color: var(--text-primary-color, #fff); cursor: default; }
          .seg button:disabled:not(.on) { opacity: .5; cursor: default; }
          .confirm { margin: 10px 0; padding: 10px; border-radius: 8px; background: var(--secondary-background-color); }
          .btn { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--divider-color);
                 background: var(--primary-color); color: var(--text-primary-color, #fff); cursor: pointer; margin-right: 6px; }
          .btn.plain { background: none; color: var(--primary-text-color); }
          table { border-collapse: collapse; width: 100%; margin-top: 10px; }
          td, th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--divider-color); vertical-align: top; }
          th { font-weight: 500; color: var(--secondary-text-color); }
          .ok { color: var(--success-color, #43a047); } .bad { color: var(--error-color, #db4437); }
          .note { color: var(--secondary-text-color); font-size: .9em; }
          .msg { color: var(--error-color, #db4437); margin-top: 8px; }
          .status { margin: 10px 0 0; font-weight: 500; }
          .status.live { color: var(--success-color, #43a047); } .status.not_live { color: var(--error-color, #db4437); }
          .status.paused, .status.busy, .warn { color: var(--warning-color, #ffa000); }
        </style>
        <ha-card><div class="body"></div></ha-card>`;
      this.shadowRoot.addEventListener("click", (ev) => {
        const b = ev.target.closest("button");
        if (!b || b.disabled) return;
        if (b.dataset.pick) { this._confirm = b.dataset.pick; this._render(); }
        else if (b.dataset.go) this._switch(b.dataset.go);
        else if (b.dataset.cancel !== undefined) { this._confirm = null; this._render(); }
        else if (b.dataset.reapply) this._reapply(b.dataset.reapply);
        else if (b.dataset.pause) this._pause(b.dataset.pause === "on");
      });
      this._built = true;
    }
    const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const body = this.shadowRoot.querySelector(".body");
    const states = this._hass ? this._hass.states : {};
    const title = `<h2>${esc(this._config.title || "Battery controller")}</h2>`;
    if (!states[this._c.selector]) {
      body.innerHTML = title + `<p>${esc(this._c.selector)} not found. Install docs/ha/powerengine_handover.yaml as a ` +
        `package (see INSTALL.md), check the config and restart Home Assistant.</p>`;
      return;
    }
    const h = handoverRows(states, this._config);
    const busy = this._busy();
    const seg = CONTROLLERS.map((c) => `<button class="${c === h.selected ? "on" : ""}" ${busy || c === h.selected ? "disabled" : ""}
        data-pick="${c}">${c}</button>`).join("");
    const line = busy ? "Switching…" : h.status === "live" ? `${h.selected} is live.`
      : h.status === "paused" ? "PowerEngine is paused for testing: nothing is driving the battery (Self-Use)."
      : `${h.selected} is selected but not fully live: see ✗ below.`;
    let html = title + `<p>Which system drives the battery. Switching hands over and leaves the chosen one fully
      live.</p><div><span class="seg">${seg}</span></div>
      <div class="status ${busy ? "busy" : h.status}">${esc(line)}</div>`;
    if (this._confirm && this._confirm !== h.selected && !busy) {
      html += `<div class="confirm"><b>Hand control to ${esc(this._confirm)}?</b><p>${esc(HANDOVER_STEPS[this._confirm])}</p>
        <button class="btn" data-go="${esc(this._confirm)}">Switch to ${esc(this._confirm)}</button>
        <button class="btn plain" data-cancel>Cancel</button></div>`;
    }
    html += `<table><tr><th></th><th>Should be</th><th>Is</th></tr>` + h.rows.map((r) => {
      const mark = r.ok === true ? '<span class="ok">✓</span>' : r.ok === false ? '<span class="bad">✗</span>'
        : (h.paused ? '<span class="warn">‖</span>' : "?");
      return `<tr><td>${mark} ${esc(r.label)}${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}</td>` +
        `<td>${esc(r.want)}</td><td>${esc(r.have)}</td></tr>`;
    }).join("") + `</table>`;
    if (h.status === "not_live" && !busy && this._c.scripts[h.selected]) {
      html += `<p>Something doesn't match ${esc(h.selected)} (changed by hand, or a handover didn't finish).</p>
        <button class="btn" data-reapply="${esc(h.selected)}">Re-apply ${esc(h.selected)} handover</button>`;
    }
    if (h.selected === "PowerEngine" && !busy) {
      html += h.paused
        ? `<p><button class="btn" data-pause="off">Resume PowerEngine (go live)</button></p>`
        : `<p><button class="btn plain" data-pause="on">Pause for testing</button>
           <span class="note">Stops PowerEngine and returns the inverter to Self-Use; Predbat stays read-only.
           Needed for the supervised tests.</span></p>`;
    }
    if (this._msg) html += `<div class="msg">${esc(this._msg)}</div>`;
    body.innerHTML = html;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("powerengine-handover-card")) {
  customElements.define("powerengine-handover-card", PowerEngineHandoverCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "powerengine-handover-card", name: "PowerEngine handover",
    description: "Switch battery control between Predbat and PowerEngine." });
}

// --- Supervised test writes -------------------------------------------------------------------------------
// Admin only (HA only lets admins fire events). Writes one action's settings to the inverter for a few
// minutes, reads them back, then returns the inverter to Self-Use. The app refuses unless the handover guards
// are safe and PowerEngine isn't in control.
const TEST_EVENT = "pe_test_write";
const TEST_ENTITY = "sensor.pe_diag_test_write";
const TEST_ACTIONS = [
  ["hold", "Hold (0 A charge window)"],
  ["charge", "Grid charge"],
  ["discharge", "Force discharge"],
  ["self_use", "Self-Use (windows closed)"],
];

function testSummary(st) {
  if (!st || ["unknown", "unavailable"].includes(st.state)) return { status: "idle", problems: [], lines: [] };
  const a = st.attributes || {};
  const lines = (a.steps || []).map((s) => {
    const t = (s.time || "").slice(11, 19);
    const bits = [];
    if (s.ok === true) bits.push("OK");
    if (s.ok === false) bits.push("MISMATCH: " + (s.mismatched || []).join(", "));
    if (s.writes) bits.push(`${s.writes.length} write${s.writes.length === 1 ? "" : "s"}`);
    if (s.soc !== undefined && s.soc !== null) bits.push(`SoC ${Math.round(s.soc)}%`);
    if (s.battery_w !== undefined && s.battery_w !== null) bits.push(`battery ${Math.round(s.battery_w)} W`);
    return `${t} ${s.what}${bits.length ? ": " + bits.join(", ") : ""}`;
  });
  return { status: st.state, action: a.action, minutes: a.minutes, problems: a.problems || [], lines };
}

class PowerEngineTestCard extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {
  setConfig(config) {
    this._config = config || {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() { return 4; }

  async _fire(data) {
    try {
      await this._hass.callWS({ type: "fire_event", event_type: TEST_EVENT, event_data: data });
      this._msg = "";
    } catch (err) {
      this._msg = "Could not start: " + ((err && err.message) || err) + " (admin users only)";
    }
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!this._built) {
      this.shadowRoot.innerHTML = `
        <style>
          ha-card { padding: 16px; }
          h2 { margin: 0 0 8px; font-size: 1.2em; font-weight: 500; }
          p { margin: 4px 0 10px; color: var(--secondary-text-color); }
          .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
          select, input { font: inherit; padding: 4px 6px; }
          input[type=number] { width: 6em; }
          button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--divider-color);
                   background: var(--primary-color); color: var(--text-primary-color, #fff); cursor: pointer; }
          button.stop { background: var(--error-color, #db4437); }
          button:disabled { opacity: .5; cursor: default; }
          .status { font-weight: 500; }
          .passed { color: var(--success-color, #43a047); }
          .failed, .refused { color: var(--error-color, #db4437); }
          pre { background: var(--secondary-background-color); padding: 8px; border-radius: 6px; overflow-x: auto;
                font-size: .85em; margin: 8px 0 0; white-space: pre-wrap; }
          .msg { color: var(--error-color, #db4437); }
        </style>
        <ha-card>
          <h2>Supervised inverter test</h2>
          <p>Writes one action to the inverter for a few minutes while you watch, reads the settings back, then
             returns the inverter to Self-Use. Needs the handover guards to be safe (Predbat read-only, legacy
             automations off) and PowerEngine not in control. Watch the inverter and battery power while it runs.</p>
          <div class="row">
            <select class="action">${TEST_ACTIONS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
            <label>Minutes <input class="minutes" type="number" min="1" max="10" value="5"></label>
            <label>Power (W) <input class="power" type="number" min="100" max="6000" step="100" placeholder="max"></label>
          </div>
          <div class="row">
            <label><input class="confirm" type="checkbox"> I'm watching and other control is handed over</label>
          </div>
          <div class="row">
            <button class="start">Start test</button>
            <button class="stop">Stop and revert</button>
            <span class="msg"></span>
          </div>
          <div class="row"><span>Status:</span><span class="status"></span></div>
          <pre class="log"></pre>
        </ha-card>`;
      const q = (sel) => this.shadowRoot.querySelector(sel);
      q(".start").addEventListener("click", () => {
        const data = { action: q(".action").value, minutes: Number(q(".minutes").value), confirm: q(".confirm").checked };
        const power = q(".power").value;
        if (power) data.power_w = Number(power);
        this._fire(data);
        q(".confirm").checked = false;
      });
      q(".stop").addEventListener("click", () => this._fire({ action: "stop" }));
      q(".confirm").addEventListener("change", () => this._render());
      this._built = true;
    }
    const q = (sel) => this.shadowRoot.querySelector(sel);
    const sum = testSummary(this._hass && this._hass.states[TEST_ENTITY]);
    const running = sum.status === "running" || sum.status === "reverting";
    q(".status").textContent = sum.status + (sum.action && sum.status !== "idle" ? ` (${sum.action}${sum.minutes ? ", " + sum.minutes + " min" : ""})` : "");
    q(".status").className = "status " + sum.status;
    q(".log").textContent = [...sum.problems.map((p) => "Problem: " + p), ...sum.lines].join("\n") || "No test run yet.";
    q(".start").disabled = running || !q(".confirm").checked;
    q(".stop").disabled = !running;
    q(".msg").textContent = this._msg || "";
  }
}

if (typeof customElements !== "undefined" && !customElements.get("powerengine-test-card")) {
  customElements.define("powerengine-test-card", PowerEngineTestCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "powerengine-test-card", name: "PowerEngine supervised test", description: "Run a short, supervised inverter write test." });
}

// --- Simulator card: history import (automatic) and heat-pump settings ---------------------------------------
// HA only lets admins read long-term statistics and fire events, so this runs in an admin's browser. When the app
// asks for months of history, the card reads them (hourly energy per sensor) one month at a time and hands each to
// the app. The heat-pump form saves its settings to the app, which uses them in the next overnight run.
const SIM_ENTITY = "sensor.pe_cost_simulator";
const HP_FIELDS = [
  ["gas_kwh_year", "Gas used in a year", "kWh", "From your gas bills (all gas, heating + hot water). Used to work out how much heat the house needs."],
  ["boiler_efficiency", "Boiler efficiency", "%", "About 85% for a modern condensing boiler, 70-75% for an older one."],
  ["heat_loss_kw", "Heat loss (survey)", "kW", "Optional: the heat-loss figure from a survey (at -3 °C). Replaces the gas estimate when set."],
  ["hot_water_kwh_day", "Hot water heat per day", "kWh", "About 5-8 kWh for a family."],
  ["tank_litres", "Hot water tank", "litres", "For the notes; hot water is heated in the day's cheapest hours."],
  ["cop_cold", "Efficiency (COP) at -3 °C", "", "From the pump's datasheet at 45 °C flow; about 2.5 if unknown."],
  ["cop_mild", "Efficiency (COP) at 12 °C", "", "About 4.5 if unknown."],
  ["max_kw", "Pump size", "kW heat", "Heat output; anything beyond it is counted as an electric immersion (COP 1)."],
  ["preheat_h", "Pre-heating allowed", "hours", "How far ahead heating may run in cheaper hours (0-6)."],
  ["gas_price_p", "Gas unit price", "p/kWh", "For the keep-gas comparison."],
  ["gas_standing_p", "Gas standing charge", "p/day", "Saved if the gas supply is removed."],
  ["install_cost", "Installed cost after grants", "£", "For payback in years (shown once there's a year of history)."],
];

const EQ_GROUPS = [
  ["battery_enabled", "Bigger battery (replacing yours)", [
    ["battery_kwh", "Usable capacity", "kWh"], ["battery_kw", "Charge/discharge power", "kW"], ["battery_cost", "Cost", "£"]]],
  ["solar_enabled", "More solar (same roof direction)", [
    ["solar_current_kwp", "Your solar now", "kWp"], ["solar_extra_kwp", "Extra panels", "kWp"], ["solar_cost", "Cost", "£"]]],
  ["ev2_enabled", "A second car", [
    ["ev2_miles_year", "Miles a year", ""], ["ev2_kwh_per_mile", "kWh per mile", ""], ["ev2_charger_kw", "Charger", "kW"]]],
];
const EQ_DEFAULTS = { ev2_kwh_per_mile: 0.3, ev2_charger_kw: 7.4 };

function simHistoryPlan(state) {
  const a = (state && state.attributes) || {};
  const req = a.history_request || {};
  return { months: req.months || [], entities: req.entities || {}, imported: req.imported || [] };
}

function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - 86400000);
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) + 86400000);
  return { start: start.toISOString(), end: end.toISOString() };
}

class PowerEngineSimCard extends (typeof HTMLElement !== "undefined" ? HTMLElement : class {}) {
  setConfig(config) {
    this._config = config || {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._build();
    this._render();
    this._maybeImport();
  }

  getCardSize() { return 6; }

  _admin() { return !!(this._hass && this._hass.user && this._hass.user.is_admin); }

  async _maybeImport() {
    if (this._importing || !this._admin()) return;
    const plan = simHistoryPlan(this._hass.states[SIM_ENTITY]);
    const month = plan.months.find((m) => !(this._tried || new Set()).has(m));
    if (!month) return;
    const ids = [...new Set(Object.values(plan.entities).flat())];
    if (!ids.length) return;
    this._importing = true;
    this._tried = this._tried || new Set();
    this._tried.add(month);
    this._status = `Reading ${month} from Home Assistant's statistics…`;
    this._render();
    try {
      const { start, end } = monthRange(month);
      const stats = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: start, end_time: end,
        statistic_ids: ids, period: "hour", types: ["change"] });
      const compact = {};                                  // [start, change] pairs keep the event small
      Object.entries(stats || {}).forEach(([id, rows]) => { compact[id] = rows.map((r) => [r.start, r.change]); });
      await this._hass.callWS({ type: "fire_event", event_type: "pe_sim_history", event_data: { month, stats: compact } });
      this._status = `Imported ${month}.`;
    } catch (err) {
      this._status = `Couldn't import ${month}: ${(err && err.message) || err}`;
    }
    this._importing = false;
    this._render();
    setTimeout(() => this._maybeImport(), 1500);            // next month, once the app has recorded this one
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 16px; }
        h2 { margin: 0 0 6px; font-size: 1.2em; font-weight: 500; }
        h3 { margin: 16px 0 6px; font-size: 1.05em; font-weight: 500; }
        p, .muted { color: var(--secondary-text-color); margin: 4px 0; }
        .grid { display: grid; grid-template-columns: minmax(160px, 1fr) 120px; gap: 6px 12px; align-items: center; }
        .grid .help { grid-column: 1 / -1; font-size: .85em; color: var(--secondary-text-color); margin-top: -4px; }
        input[type=number] { font: inherit; padding: 4px 6px; width: 100%; box-sizing: border-box; }
        button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--divider-color);
                 background: var(--primary-color); color: var(--text-primary-color, #fff); cursor: pointer; margin-top: 10px; }
        button:disabled { opacity: .5; cursor: default; }
        .msg { margin-left: 8px; }
        .ok { color: var(--success-color, #43a047); } .bad { color: var(--error-color, #db4437); }
      </style>
      <ha-card>
        <h2>Simulator set-up</h2>
        <h3>A year of history</h3>
        <p class="hist"></p>
        <h3>Heat pump</h3>
        <p>Adds a heat pump to your tariff, the heat-pump tariffs and the five best others, and compares each with keeping gas. Saved settings are used in the next overnight run.</p>
        <label><input type="checkbox" class="hp_on"> Include a heat pump</label>
        <div class="grid">${HP_FIELDS.map(([k, label, unit, help]) => `
          <label for="f_${k}">${label}${unit ? ` (${unit})` : ""}</label><input type="number" step="any" id="f_${k}" data-k="${k}">
          <div class="help">${help}</div>`).join("")}
        </div>
        <h3>Equipment</h3>
        <p>Each ticked item (and all of them together) is run on your tariff and the best other tariff, and compared with the same tariff without it. Payback appears once there's a year of history.</p>
        ${EQ_GROUPS.map(([flag, title, fields]) => `
          <label><input type="checkbox" data-e="${flag}"> ${title}</label>
          <div class="grid">${fields.map(([k, label, unit]) => `
            <label for="e_${k}">${label}${unit ? ` (${unit})` : ""}</label><input type="number" step="any" id="e_${k}" data-e="${k}">`).join("")}
          </div>`).join("")}
        <button class="save">Save simulator settings</button><span class="msg"></span>
      </ha-card>`;
    this.shadowRoot.querySelector(".save").addEventListener("click", () => this._save());
    this._fill();
  }

  _fill() {
    const a = ((this._hass.states[SIM_ENTITY] || {}).attributes || {});
    const s = (a.settings || {}).heat_pump || {};
    const defaults = { boiler_efficiency: 85, hot_water_kwh_day: 6, tank_litres: 200, cop_cold: 2.5, cop_mild: 4.5, max_kw: 8, preheat_h: 2, gas_price_p: 6, gas_standing_p: 30 };
    this.shadowRoot.querySelector(".hp_on").checked = !!s.enabled;
    const e = (a.settings || {}).equipment || {};
    this.shadowRoot.querySelectorAll("[data-e]").forEach((inp) => {
      const k = inp.dataset.e;
      if (inp.type === "checkbox") inp.checked = !!e[k];
      else { const v = e[k] ? e[k] : EQ_DEFAULTS[k]; inp.value = v === undefined ? "" : v; }
    });
    this.shadowRoot.querySelectorAll("input[data-k]").forEach((inp) => {
      const k = inp.dataset.k;
      const v = s[k] !== undefined && s[k] !== 0 ? s[k] : defaults[k];
      inp.value = v === undefined ? "" : v;
    });
    this._filled = !!a.settings;
  }

  async _save() {
    const hp = { enabled: this.shadowRoot.querySelector(".hp_on").checked };
    this.shadowRoot.querySelectorAll("input[data-k]").forEach((inp) => { hp[inp.dataset.k] = inp.value === "" ? 0 : Number(inp.value); });
    const equipment = {};
    this.shadowRoot.querySelectorAll("[data-e]").forEach((inp) => {
      equipment[inp.dataset.e] = inp.type === "checkbox" ? inp.checked : (inp.value === "" ? 0 : Number(inp.value));
    });
    const msg = this.shadowRoot.querySelector(".msg");
    try {
      const unsub = await this._hass.connection.subscribeEvents((ev) => {
        msg.textContent = ev.data.message; msg.className = "msg " + (ev.data.ok ? "ok" : "bad"); unsub();
      }, "pe_sim_result");
      await this._hass.callWS({ type: "fire_event", event_type: "pe_sim_settings", event_data: { heat_pump: hp, equipment } });
      msg.textContent = "Saving…"; msg.className = "msg";
    } catch (err) {
      msg.textContent = "Couldn't save: " + ((err && err.message) || err) + " (admin users only)"; msg.className = "msg bad";
    }
  }

  _render() {
    if (!this.shadowRoot || !this._hass) return;
    const st = this._hass.states[SIM_ENTITY];
    if (!this._filled && st && st.attributes && st.attributes.settings) this._fill();
    const plan = simHistoryPlan(st);
    const el = this.shadowRoot.querySelector(".hist");
    let text;
    if (!st) text = "Waiting for PowerEngine.";
    else if (!plan.months.length) text = plan.imported.length ? `Imported ${plan.imported.length} month${plan.imported.length === 1 ? "" : "s"} of history from Home Assistant's statistics (hourly energy). The Simulator uses them from the next overnight run.` : "Nothing to import.";
    else if (!this._admin()) text = `${plan.months.length} month(s) of history can be imported from Home Assistant's statistics. Open this page as an admin user and it happens automatically.`;
    else text = `Importing ${plan.months.length} month(s) of hourly energy from Home Assistant's statistics while this page is open (each month takes a few seconds).`;
    el.textContent = text + (this._status ? " " + this._status : "");
    this.shadowRoot.querySelector(".save").disabled = !this._admin();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("powerengine-sim-card")) {
  customElements.define("powerengine-sim-card", PowerEngineSimCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "powerengine-sim-card", name: "PowerEngine simulator set-up", description: "Imports a year of history for the Simulator and holds its heat-pump settings." });
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
  module.exports = { FEATURES, FEATURE_DEFAULTS, parseSignNote, readout, instantProblem, effectiveRole, suggestEntity, initialDraft, buildConfig, slugify, summariseAttribute, settingProblem, testSummary, measuredText, simHistoryPlan, monthRange, handoverRows, topicPlan, roleNeed, matchesSearch, TOPICS, CARD_VERSION };
}
