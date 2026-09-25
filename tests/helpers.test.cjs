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

test("notifications are saved only once a service is chosen", () => {
  const { initialDraft, buildConfig } = require("../ha-powerengine-card.js");
  const { draft } = initialDraft({ inputs: { a: { entity: "sensor.a" } } }, [], [], {});
  assert.equal(draft.notifications.service, "");
  assert.equal(draft.notifications.events.health, true);
  assert.equal(draft.notifications.events.daily, false);
  assert.equal(buildConfig(draft).notifications, undefined);
  draft.notifications.service = "notify.mobile_app_pixel";
  draft.notifications.events.daily = true;
  assert.deepEqual(buildConfig(draft).notifications, { service: "notify.mobile_app_pixel", events: { health: true, inputs: true, axle: true, free_power: true, daily: true } });
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
  assert.deepEqual(s.lines, ["10:00:00 wrote: 3 writes", "10:00:10 read back (start): MISMATCH: timed_charge_current, SoC 55%, battery -2100 W"]);
});
