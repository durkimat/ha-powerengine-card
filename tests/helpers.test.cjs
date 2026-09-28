const test = require("node:test");
const assert = require("node:assert");
const h = require("../ha-powerengine-card.js");

const battery = { key: "battery_power", kind: "power", signed: true, sign_note: "+ discharging, - charging", domains: ["sensor"], required: "yes" };
const grid = { key: "grid_power", kind: "power", signed: true, sign_note: "+ importing, - exporting", domains: ["sensor"], required: "yes" };
const soc = { key: "battery_soc", kind: "percent", domains: ["sensor"], required: "yes", suggest: ["^sensor\\.solis_battery_soc$"] };
const rates = { key: "import_rates_today", kind: "list", attribute: "rates", domains: ["event", "sensor"], required: "yes" };
const cap = { key: "battery_capacity", kind: "static", static_ok: true, static_unit: "kWh", suggest_static: 18, required: "yes" };
const ctl = { key: "smart_target_soc", kind: "control", domains: ["number"], required: "no" };
const rateNow = { key: "import_rate_now", kind: "rate", domains: ["sensor"], required: "yes",
  suggest: ["^sensor\\.edf_energy_electricity_.*_current_rate$"], suggest_not: ["export"] };

const W = (v) => ({ state: String(v), attributes: { unit_of_measurement: "W" } });

test("sign notes parse", () => {
  assert.deepStrictEqual(h.parseSignNote("+ discharging, - charging"), { pos: "discharging", neg: "charging" });
});

test("battery reads as discharging, and invert flips it", () => {
  assert.match(h.readout(battery, { entity: "sensor.b" }, W(1040)).readsAs, /discharging 1\.04 kW/);
  assert.match(h.readout(battery, { entity: "sensor.b", invert: true }, W(1040)).readsAs, /charging 1\.04 kW/);
});

test("grid meter that reports export as negative needs invert", () => {
  // Solis meter: -240 W while exporting
  assert.match(h.readout(grid, { entity: "sensor.g" }, W(-240)).readsAs, /exporting 240 W/);
  assert.match(h.readout(grid, { entity: "sensor.g", invert: true }, W(-240)).readsAs, /importing 240 W/);
});

test("rate list summary shows count and the current rate in pence", () => {
  const now = new Date("2026-09-22T17:10:00+01:00");
  const items = [];
  for (let i = 0; i < 48; i++) {
    const s = new Date(Date.parse("2026-09-22T00:00:00+01:00") + i * 1800e3);
    items.push({ start: s.toISOString(), end: new Date(s.getTime() + 1800e3).toISOString(), value_inc_vat: i < 10 ? 0.06993 : 0.302831 });
  }
  const r = h.readout(rates, { entity: "event.r" }, { state: "x", attributes: { rates: items } }, now);
  assert.match(r.text, /48 half-hour rates, now 30\.28p/);
});

test("static values show and validate", () => {
  assert.strictEqual(h.readout(cap, { value: 18 }).text, "Fixed: 18 kWh");
  assert.strictEqual(h.instantProblem(cap, { value: "lots" }), "Enter a number");
});

test("instant problems", () => {
  assert.strictEqual(h.instantProblem(soc, { entity: "sensor.x" }, { state: "71", attributes: { unit_of_measurement: "%" } }), "");
  assert.match(h.instantProblem(soc, { entity: "sensor.x" }, { state: "71", attributes: { unit_of_measurement: "W" } }), /Unit is W/);
  assert.strictEqual(h.instantProblem(soc, { entity: "sensor.x" }, undefined), "Entity not found");
  assert.match(h.instantProblem(ctl, { entity: "number.edf_x_intelligent_bump_charge" }, {}), /Never allowed/);
  assert.strictEqual(h.instantProblem(soc, null), "Required");
});

test("suggestions respect exclusions", () => {
  const ids = ["sensor.edf_energy_electricity_1_export_current_rate", "sensor.edf_energy_electricity_1_current_rate"];
  assert.strictEqual(h.suggestEntity(rateNow, ids), "sensor.edf_energy_electricity_1_current_rate");
});

test("first use pre-fills suggestions and a main plant", () => {
  const ids = ["sensor.solis_battery_soc", "sensor.solis_pv_total_power", "sensor.solis_power_generation_today"];
  const { draft, fresh } = h.initialDraft({}, [soc, cap], ids);
  assert.ok(fresh);
  assert.deepStrictEqual(draft.inputs.battery_soc, { entity: "sensor.solis_battery_soc" });
  assert.deepStrictEqual(draft.inputs.battery_capacity, { value: 18 });
  assert.strictEqual(draft.solar_plants[0].power.entity, "sensor.solis_pv_total_power");
  assert.strictEqual(draft.operation.mode, "passive");
});

test("saved config is not overwritten by suggestions", () => {
  const saved = { inputs: { battery_soc: { entity: "sensor.other" } } };
  const { draft, fresh } = h.initialDraft(saved, [soc], ["sensor.solis_battery_soc"]);
  assert.ok(!fresh);
  assert.strictEqual(draft.inputs.battery_soc.entity, "sensor.other");
});

test("buildConfig drops empty inputs and incomplete plants, keeps invert", () => {
  const out = h.buildConfig({
    inputs: { a: { entity: "sensor.a" }, b: {}, g: { entity: "sensor.g", invert: true }, c: { value: "18" } },
    solar_plants: [{ id: "main", name: "Main", power: { entity: "sensor.p" }, energy_today: { entity: "sensor.e" } }, { id: "x", power: {}, energy_today: {} }],
    features: { axle: true }, operation: { mode: "passive" },
  });
  assert.deepStrictEqual(Object.keys(out.inputs).sort(), ["a", "c", "g"]);
  assert.strictEqual(out.inputs.c.value, 18);
  assert.strictEqual(out.inputs.g.invert, true);
  assert.strictEqual(out.solar_plants.length, 1);
  assert.strictEqual(out.solar_plants[0].forecast, "none");
});

test("plant ids are unique slugs", () => {
  assert.strictEqual(h.slugify("Garage roof", ["main"]), "garage_roof");
  assert.strictEqual(h.slugify("Garage roof", ["garage_roof"]), "garage_roof_2");
  assert.strictEqual(h.slugify("2nd array", []), "p_2nd_array");
});

test("rates show in pence, money in pounds, times are not numbers", () => {
  const rate = { key: "import_rate_now", kind: "rate", domains: ["sensor"] };
  const sc = { key: "standing_charge", kind: "money", domains: ["sensor"] };
  const t = { key: "smart_target_time", kind: "control", domains: ["select"] };
  assert.strictEqual(h.readout(rate, { entity: "s.r" }, { state: "0.302831", attributes: { unit_of_measurement: "GBP/kWh" } }).text, "30.28p/kWh");
  assert.strictEqual(h.readout(sc, { entity: "s.s" }, { state: "0.570969", attributes: { unit_of_measurement: "GBP" } }).text, "\u00a30.57 per day");
  assert.strictEqual(h.readout(t, { entity: "select.t" }, { state: "11:00", attributes: {} }).text, "11:00");
});

test("settings defaults, validation and saving", () => {
  const settings = { safety: [{ key: "min_reserve_soc", default: 12, min: 0, max: 100 }, { key: "cheap_threshold_p", default: 10, min: 0, max: 100 }],
                     system: [{ key: "house_load_includes_ev", default: true }] };
  const { draft } = h.initialDraft({ safety: { cheap_threshold_p: 8 } }, [], [], settings);
  assert.strictEqual(draft.safety.min_reserve_soc, 12);
  assert.strictEqual(draft.safety.cheap_threshold_p, 8);
  assert.strictEqual(draft.system.house_load_includes_ev, true);
  assert.strictEqual(h.settingProblem(settings.safety[0], "150"), "Must be between 0 and 100");
  assert.strictEqual(h.settingProblem(settings.safety[0], "abc"), "Enter a number");
  draft.safety.min_reserve_soc = "15";
  const out = h.buildConfig(draft);
  assert.strictEqual(out.safety.min_reserve_soc, 15);
  assert.strictEqual(out.system.house_load_includes_ev, true);
});

test("battery pair replaces the single battery power sensor", () => {
  const { effectiveRole } = require("../ha-powerengine-card.js");
  const single = { key: "battery_power", required: "yes" };
  const inRole = { key: "battery_charge_power", required: "no" };
  assert.equal(effectiveRole(single, false).required, "yes");
  assert.equal(effectiveRole(single, true).required, "unused");
  assert.equal(effectiveRole(inRole, true).required, "yes");
  assert.equal(effectiveRole(inRole, false).required, "no");
});

test("notifications default to HA's notification area; off and phone are saved", () => {
  const { initialDraft, buildConfig } = require("../ha-powerengine-card.js");
  const { draft } = initialDraft({ inputs: { a: { entity: "sensor.a" } } }, [], [], {});
  assert.equal(draft.notifications.service, "persistent_notification");
  assert.equal(draft.notifications.events.health, true);
  assert.equal(draft.notifications.events.daily, false);
  assert.equal(buildConfig(draft).notifications.service, "persistent_notification");
  draft.notifications.service = "notify.mobile_app_pixel";
  draft.notifications.events.daily = true;
  assert.deepEqual(buildConfig(draft).notifications, { service: "notify.mobile_app_pixel", events: { health: true, inputs: true, axle: true, free_power: true, daily: true, simulator: true } });
  const off = initialDraft({ inputs: {}, notifications: { service: "" } }, [], [], {}).draft;
  assert.equal(off.notifications.service, "off");
  assert.equal(buildConfig(off).notifications.service, "off");
});

test("testSummary: idle when the sensor has never been set", () => {
  assert.equal(h.testSummary(undefined).status, "idle");
  assert.deepEqual(h.testSummary(undefined).problems, []);
  assert.equal(h.testSummary({ state: "unknown", attributes: {} }).status, "idle");
});

test("testSummary: steps become readable lines", () => {
  const s = h.testSummary({ state: "failed", attributes: { action: "charge", minutes: 3, problems: ["start: timed_charge_current did not read back"],
    steps: [{ time: "2026-09-25T10:00:00+00:00", what: "wrote", writes: [{}, {}, {}] },
            { time: "2026-09-25T10:00:10+00:00", what: "read back (start)", ok: false, mismatched: ["timed_charge_current"], soc: 54.6, battery_w: -2100 }] } });
  assert.equal(s.status, "failed");
  assert.deepEqual(s.lines, ["10:00:00 wrote: 3 writes", "10:00:10 read back (start): MISMATCH: timed_charge_current, SoC 55%, battery charging 2100 W"]);
});

test("testSummary: RC verdict, grid and remote-control state", () => {
  const s = h.testSummary({ state: "passed", attributes: { action: "rc_charge", verdict: "worked", explanation: "battery charged",
    steps: [{ time: "2026-09-27T20:00:30+00:00", what: "reading", battery_w: 1500, grid_w: -800, rc: "Force discharge" }] } });
  assert.equal(s.verdict, "worked");
  assert.deepEqual(s.lines, ["20:00:30 reading: battery discharging 1500 W, grid export 800 W, RC Force discharge"]);
});

test("findRcEntities prefers the solis entities", () => {
  const states = { "select.x_battery_control_override": {}, "select.solis_inverter_battery_control_override": {},
    "number.solis_inverter_battery_control_override_charge_power": {} };
  assert.deepEqual(h.findRcEntities(states), { rc_mode: "select.solis_inverter_battery_control_override",
    rc_charge_power: "number.solis_inverter_battery_control_override_charge_power" });
});

test("every test has instructions", () => {
  for (const t of h.TESTS) assert.ok(t.what && t.watch && t.checks && t.label, t.key);
  assert.deepEqual(h.TESTS.filter((t) => t.group === "rc").map((t) => t.key), ["rc_charge", "rc_discharge", "rc_hold", "rc_failsafe"]);
});

test("diagnostics: config entities, states filter and private attributes, file name", () => {
  const cfg = { inputs: { battery_soc: { entity: "sensor.soc" }, x: { value: 3 } }, solar_plants: [{ inputs: { power: { entity: "sensor.pv" } } }] };
  assert.deepEqual([...h.configEntities(cfg)].sort(), ["sensor.pv", "sensor.soc"]);
  const st = { "sensor.pe_state_battery_soc": { state: "50", attributes: {} }, "sensor.soc": { state: "50", attributes: { account_number: "123", unit_of_measurement: "%" } },
    "light.kitchen": { state: "on", attributes: {} }, "number.solis_timed_charge_current": { state: "50", attributes: {} } };
  const out = h.diagStates(st, h.configEntities(cfg));
  assert.deepEqual(Object.keys(out).sort(), ["number.solis_timed_charge_current", "sensor.pe_state_battery_soc", "sensor.soc"]);
  assert.equal(out["sensor.soc"].attributes.account_number, "(removed)");
  assert.equal(out["sensor.soc"].attributes.unit_of_measurement, "%");
  assert.equal(h.diagFileName(new Date(2026, 8, 27, 19, 5)), "powerengine-diagnostics-20260927-1905.json");
});

test("dampingNote", () => {
  assert.match(h.dampingNote({}), /appear here/);
  const st = { "sensor.pe_diag_writes_today": { state: "5", attributes: { damping: { restart: true, bursts: false },
    damping_week: { days: 7, none: 60, restart: 50, both: 42, saved_restart: 10, saved_bursts: 8 } } } };
  assert.equal(h.dampingNote(st), "Last 7 days (modelled): no dampening 60 writes; restart hold-off saved 10 writes; burst damping would have saved 8 writes more.");
});

test("liveLine", () => {
  const st = { "sensor.pe_state_battery_power": { state: "-2000" }, "sensor.pe_state_grid_power": { state: "2500" }, "sensor.pe_state_battery_soc": { state: "61.2" } };
  assert.equal(h.liveLine(st), "Battery 61% · charging 2000 W · grid import 2500 W");
});

test("buildConfig keeps use_measured on a fixed value", () => {
  const cfg = h.buildConfig({ inputs: { battery_capacity: { value: "18", use_measured: false } }, solar_plants: [], features: {}, operation: {} });
  assert.deepEqual(cfg.inputs.battery_capacity, { value: 18, use_measured: false });
  const cfg2 = h.buildConfig({ inputs: { battery_capacity: { value: 18 } }, solar_plants: [], features: {}, operation: {} });
  assert.deepEqual(cfg2.inputs.battery_capacity, { value: 18 });
});

test("measuredText", () => {
  assert.equal(h.measuredText({ states: {} }, "battery_capacity"), "(not measured yet)");
  const hass = { states: { "sensor.pe_diag_battery_capacity": { state: "18.084", attributes: { measured: true, unit_of_measurement: "kWh" } } } };
  assert.equal(h.measuredText(hass, "battery_capacity"), "(18.08 kWh measured)");
  const eff = { states: { "sensor.pe_diag_battery_efficiency": { state: "90.3", attributes: { measured: true, measured_round_trip: 88.44 } } } };
  assert.equal(h.measuredText(eff, "battery_round_trip"), "(88.4% measured)");
  assert.equal(h.measuredText({ states: { "sensor.pe_diag_battery_efficiency": { state: "90.3", attributes: { measured: false } } } }, "battery_round_trip"), "(not measured yet)");
});

test("simulator history plan and month range", () => {
  const st = { attributes: { history_request: { months: ["2025-10"], entities: { house: ["sensor.h"] }, imported: [] } } };
  assert.deepEqual(h.simHistoryPlan(st).months, ["2025-10"]);
  assert.deepEqual(h.simHistoryPlan(undefined).months, []);
  const r = h.monthRange("2025-12");
  assert.equal(r.start, "2025-11-30T00:00:00.000Z");
  assert.equal(r.end, "2026-01-02T00:00:00.000Z");
});

const hs = (v, a) => ({ state: v, attributes: a || {} });

test("handoverRows: PowerEngine live", () => {
  const r = h.handoverRows({
    "input_select.battery_controller": hs("PowerEngine"), "switch.predbat_set_read_only": hs("on"),
    "switch.pe_ctl_pause": hs("off"), "sensor.pe_state_operation_mode": hs("active"),
    "automation.charge_house_battery_on": hs("off") });
  assert.deepEqual(r.rows.map((x) => x.ok), [true, true, true, true]);
  assert.equal(r.status, "live");
});

test("handoverRows: PowerEngine selected but Passive is not live", () => {
  const r = h.handoverRows({
    "input_select.battery_controller": hs("PowerEngine"), "switch.predbat_set_read_only": hs("on"),
    "switch.pe_ctl_pause": hs("off"), "sensor.pe_state_operation_mode": hs("passive", { reason: "Passive: watching" }),
    "automation.charge_house_battery_on": hs("off") });
  assert.equal(r.rows[3].ok, false);
  assert.equal(r.status, "not_live");
});

test("handoverRows: paused for testing is not a fault", () => {
  const r = h.handoverRows({
    "input_select.battery_controller": hs("PowerEngine"), "switch.predbat_set_read_only": hs("on"),
    "switch.pe_ctl_pause": hs("on"), "sensor.pe_state_operation_mode": hs("paused"),
    "automation.charge_house_battery_on": hs("off") });
  assert.deepEqual(r.rows.map((x) => x.ok), [true, true, null, null]);
  assert.equal(r.status, "paused");
});

test("handoverRows: Predbat selected with leftovers", () => {
  const r = h.handoverRows({
    "input_select.battery_controller": hs("Predbat"), "switch.predbat_set_read_only": hs("on"),
    "switch.pe_ctl_pause": hs("off"), "sensor.pe_state_operation_mode": hs("active"),
    "automation.house_battery_start_charging": hs("on") });
  assert.deepEqual(r.rows.map((x) => x.ok), [false, false, true, false]);
  assert.equal(r.rows[1].have, "1 on");
  assert.equal(r.status, "not_live");
});

test("handoverRows: a missing Predbat switch is not live", () => {
  const r = h.handoverRows({
    "input_select.battery_controller": hs("Predbat"),
    "switch.pe_ctl_pause": hs("off"), "sensor.pe_state_operation_mode": hs("passive"),
    "automation.charge_house_battery_on": hs("off") });
  assert.equal(r.rows[0].ok, null);
  assert.match(r.rows[0].note, /doesn't have this entity/);
  assert.equal(r.status, "not_live");
});

test("measuredText for learned rates", () => {
  assert.equal(h.measuredText({ states: {} }, "battery_max_charge_power"), "(not measured yet)");
  const hass = { states: { "sensor.pe_diag_learned": { state: "1 learned", attributes: { raw: { max_charge_kw: 4.2, max_discharge_kw: null } } } } };
  assert.equal(h.measuredText(hass, "battery_max_charge_power"), "(4.20 kW measured)");
  assert.equal(h.measuredText(hass, "battery_max_discharge_power"), "(not measured yet)");
});

test("every feature has a default", () => {
  assert.deepEqual(h.FEATURES.map((f) => f[0]).sort(), Object.keys(h.FEATURE_DEFAULTS).sort());
});

test("topicPlan puts everything somewhere, clocks together, leftovers in Other", () => {
  const plan = h.topicPlan(["battery_soc", "inverter_clock", "inverter_clock_sync", "new_thing"], ["min_reserve_soc"],
    ["axle", "learn_taper"], ["battery_location"]);
  const where = (k) => plan.find((t) => t.roles.includes(k)).key;
  assert.equal(where("inverter_clock"), "control");
  assert.equal(where("inverter_clock_sync"), "control");
  assert.equal(where("new_thing"), "other");
  assert.deepEqual(plan.find((t) => t.key === "battery").learning, ["learn_taper"]);
  assert.deepEqual(plan.find((t) => t.key === "cold").system, ["battery_location"]);
});

test("roleNeed", () => {
  const d = (mode, f) => ({ operation: { mode }, features: f || {} });
  assert.equal(h.roleNeed({ key: "battery_soc", required: "yes" }, d("passive")).level, "req");
  assert.equal(h.roleNeed({ key: "timed_charge_current", required: "no" }, d("passive")).level, "cond");
  assert.equal(h.roleNeed({ key: "timed_charge_current", required: "no" }, d("active")).badge, "Required to go live");
  assert.equal(h.roleNeed({ key: "axle_event_active", required: "axle" }, d("passive", { axle: false })).level, "cond");
  assert.equal(h.roleNeed({ key: "axle_event_active", required: "axle" }, d("passive", { axle: true })).level, "req");
  assert.equal(h.roleNeed({ key: "smart_target_soc", required: "no" }, d("passive", { smart_charge_optimisation: true })).level, "req");
  assert.equal(h.roleNeed({ key: "battery_soh", required: "no" }, d("passive")).level, "opt");
  assert.equal(h.roleNeed({ key: "battery_power", required: "yes" }, d("passive"), true).level, "unused");
});

test("matchesSearch", () => {
  assert.ok(h.matchesSearch("Inverter clock sensor.solis_rtc", "clock rtc"));
  assert.ok(!h.matchesSearch("Main supply fuse", "clock"));
  assert.ok(h.matchesSearch("anything", "  "));
});

test("handoverRows: Predbat missing is safe under PowerEngine", () => {
  const r = h.handoverRows({
    "input_select.battery_controller": hs("PowerEngine"),
    "switch.pe_ctl_pause": hs("off"), "sensor.pe_state_operation_mode": hs("active"),
    "automation.charge_house_battery_on": hs("off") });
  assert.equal(r.rows[0].ok, true);
  assert.match(r.rows[0].note, /isn't connected/);
  assert.equal(r.status, "live");
});

test("diagnostics history adds the mapped raw meters and the grid cross-check", () => {
  const ids = h.diagHistoryIds({ inputs: { grid_power: { entity: "sensor.solis_meter_active_power" },
    grid_power_reference: { entity: "sensor.myenergi_67lr_power_grid" }, battery_capacity: { value: 18 } } });
  assert.ok(ids.includes("sensor.solis_meter_active_power"));
  assert.ok(ids.includes("sensor.myenergi_67lr_power_grid"));
  assert.ok(ids.includes("sensor.pe_diag_grid_check"));
  assert.ok(ids.includes("sensor.pe_state_battery_power"));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(h.diagHistoryIds(null).includes("sensor.pe_state_grid_power"));
});

test("update card finds the PowerEngine repositories and reads the versions", () => {
  const repos = h.peRepos([{ id: 1, full_name: "durkimat/ha-powerengine-controller", installed: true },
    { id: 2, full_name: "durkimat/ha-powerengine-card", installed: true },
    { id: 3, full_name: "hacs/integration", installed: true },
    { id: 4, full_name: "someone/powerengine-fork", installed: false }]);
  assert.deepEqual(repos.map((r) => r.id), [1, 2]);
  const states = { "sensor.pe_diag_version": { state: "0.9.45" },
    "update.powerengine_update": { state: "on", attributes: { installed_version: "v0.9.45", latest_version: "v0.9.46" } },
    "update.powerengine_card_update": { state: "off", attributes: { installed_version: "v0.9.45" } } };
  const v = h.versionLine(states);
  assert.equal(v.running, "0.9.45");
  assert.deepEqual(v.parts, ["card v0.9.45", "app v0.9.45 → v0.9.46 available"]);
});

test("log card rows and times, and escaping", () => {
  const attrs = { recent: [{ t: "2026-09-28T12:00:00+01:00", l: "I", m: "a" }], warnings: [{ t: "x", l: "W", m: "b" }] };
  assert.equal(h.logRows(attrs, true)[0].m, "b");
  assert.equal(h.logRows(attrs, false)[0].m, "a");
  assert.deepEqual(h.logRows(null, true), []);
  assert.equal(h.logWhen("not a date"), "not a date");
  assert.equal(h.escHtml('<b>"x"&'), "&lt;b&gt;&quot;x&quot;&amp;");
});

test("version line shows a release HACS hasn't seen yet, with its notes", () => {
  const v = h.versionLine({ "sensor.pe_diag_version": { state: "0.9.48" },
    "sensor.pe_diag_update": { state: "available", attributes: { latest: "0.9.50", notes: "### 0.9.50\n\n- x" } } });
  assert.equal(v.released, "0.9.50");
  assert.ok(v.notes.startsWith("### 0.9.50"));
  assert.equal(h.versionLine({ "sensor.pe_diag_update": { state: "up to date", attributes: {} } }).released, null);
});

test("waterfall rows chain: totals reset the baseline, steps float between running totals", () => {
  const steps = [
    { label: "No solar or battery", kind: "total", value: 20 },
    { label: "Solar", kind: "step", value: -8 },
    { label: "EDF tariff", kind: "step", value: -4 },
    { label: "Battery on self-use", kind: "step", value: -3 },
    { label: "PowerEngine", kind: "step", value: -2 },
    { label: "Everyday cost", kind: "subtotal", value: 3 },
    { label: "Battery carry-over", kind: "step", value: 0.5 },
    { label: "You paid", kind: "total", value: 3.5 },
  ];
  const rows = h.waterfallRows(steps);
  assert.equal(rows.length, 8);
  assert.deepEqual([rows[0].from, rows[0].to], [0, 20]);
  assert.deepEqual([rows[1].from, rows[1].to], [20, 12]);
  assert.deepEqual([rows[2].from, rows[2].to], [12, 8]);
  assert.deepEqual([rows[3].from, rows[3].to], [8, 5]);
  assert.deepEqual([rows[4].from, rows[4].to], [5, 3]);
  assert.deepEqual([rows[5].from, rows[5].to], [0, 3]);       // subtotal resets the baseline
  assert.deepEqual([rows[6].from, rows[6].to], [3, 3.5]);
  assert.deepEqual([rows[7].from, rows[7].to], [0, 3.5]);     // final total also resets
  assert.equal(rows[rows.length - 1].to, 3.5);
});

test("waterfall rows: a day you earned money gives a negative running total", () => {
  const steps = [
    { label: "No solar or battery", kind: "total", value: 5 },
    { label: "Solar", kind: "step", value: -3 },
    { label: "EDF tariff", kind: "step", value: -2 },
    { label: "Battery on self-use", kind: "step", value: -2 },
    { label: "PowerEngine", kind: "step", value: -1 },
    { label: "Everyday cost", kind: "subtotal", value: -3 },
    { label: "Battery carry-over", kind: "step", value: 0 },
    { label: "You paid", kind: "total", value: -3 },
  ];
  const rows = h.waterfallRows(steps);
  const scale = h.waterfallScale(rows);
  assert.ok(scale.min < -3 && scale.max > 5);      // the scale always spans 0
  assert.equal(rows[rows.length - 1].value, -3);
});

test("waterfall rows: an all-zero day still produces a valid, non-degenerate scale", () => {
  const steps = [
    { label: "No solar or battery", kind: "total", value: 0 },
    { label: "Solar", kind: "step", value: 0 },
    { label: "Everyday cost", kind: "subtotal", value: 0 },
    { label: "You paid", kind: "total", value: 0 },
  ];
  const rows = h.waterfallRows(steps);
  const scale = h.waterfallScale(rows);
  assert.ok(scale.min < 0 && scale.max > 0);       // degenerate (all-equal) range still gives room either side
  assert.equal(rows.every((r) => r.from === 0 && r.to === 0), true);
});

test("waterfall scale always includes zero even when every value is positive", () => {
  const rows = h.waterfallRows([
    { label: "No solar or battery", kind: "total", value: 10 },
    { label: "You paid", kind: "total", value: 12 },
  ]);
  const scale = h.waterfallScale(rows);
  assert.ok(scale.min <= 0);
  assert.ok(scale.max >= 12);
});

test("pct: maps a value to its 0-100 position within a scale", () => {
  assert.equal(h.pct(5, { min: 0, max: 10 }), 50);
  assert.equal(h.pct(0, { min: 0, max: 10 }), 0);
  assert.equal(h.pct(10, { min: 0, max: 10 }), 100);
  assert.equal(h.pct(-5, { min: -10, max: 10 }), 25);
});

test("pct: handles a negative-only scale and a degenerate (zero-width) scale", () => {
  assert.equal(h.pct(-5, { min: -10, max: 0 }), 50);
  assert.equal(h.pct(3, { min: 3, max: 3 }), 50);   // no span: pick the middle rather than divide by zero
});

