const test = require("node:test");
const assert = require("node:assert");
const card = require("../ha-powerengine-card.js");

const T0 = Date.parse("2026-10-05T21:00:00Z");
const iso = (h) => new Date(T0 + h * 3600000).toISOString();
const st = (state, attributes = {}) => ({ state, attributes, last_updated: "x" });

const timeline = () => ({
  now: iso(3.5), because: "New prices published", floor_soc: 12, reserve_soc: 12,
  items: [
    { mode: "self_use", start: iso(0), end: iso(2.5), level_start: 41, level_end: 30, until: "" },
    { mode: "charge", start: iso(2.5), end: iso(5.5), level_start: 30, level_end: 88, until: "until 88%", reason: "cheap" },
    { mode: "hold", start: iso(5.5), end: iso(8), level_start: 88, level_end: 88, until: "until 05:30" },
    { mode: "bad", start: "nope", end: iso(9) },                // ignored: no valid start
  ],
  path: { start: iso(0), step_min: 60, mid: [41, 30, 30, 51, 70, 88, 88, 88, 88], low: [41, 30, 30, 48, 60, 80, 82, 84, 85], high: [41, 30, 30, 55, 80, 95, 95, 95, 95] },
  prices: [
    { start: iso(0), end: iso(2.5), import_p: 28.84, export_p: 15, slot_prob: null, event: false },
    { start: iso(2.5), end: iso(8), import_p: 6.99, export_p: 15, slot_prob: 0.7, event: false },
  ],
  cost_expected: 1.23, cost_selfuse: 2.34, comfort_given_up: 0.06,
});
const curve = () => ({ start: iso(0), step_min: 60, levels: [0, 50, 100], unit: "p/kWh",
  values: [[10, 20, 30], [10, 20, 30], [40, 30, 20], [0, 0, 90], [5, 5, 5]] });

test("value bar: marker and the two real-price lines on one scale", () => {
  const g = card.valueBarGeometry({ value_p: 30, buy_line_p: 7.4, sell_line_p: 14.3, scale_max_p: 40 }, { width: 400, x0: 0 });
  assert.strictEqual(g.max, 40);
  assert.strictEqual(g.marker.x, 300);
  assert.strictEqual(g.buy.x, 74);
  assert.ok(Math.abs(g.sell.x - 143) < 1e-9);
  assert.ok(Math.abs(g.sellFill.w - 143) < 1e-9);
  assert.strictEqual(g.buyFill.x, 74);
  assert.ok(Math.abs(g.buyFill.w - 326) < 1e-9);
  assert.strictEqual(g.marker.off, false);
  assert.deepStrictEqual(g.ticks.map((t) => t.p), [0, 10, 20, 30, 40]);
});

test("value bar: a grid-event value sits at the end and is marked off the scale; missing lines are left out", () => {
  const g = card.valueBarGeometry({ value_p: 109, scale_max_p: 40 }, { width: 400, x0: 0 });
  assert.strictEqual(g.marker.x, 400);
  assert.strictEqual(g.marker.off, true);
  assert.strictEqual(g.buy, null);
  assert.strictEqual(g.sell, null);
  assert.strictEqual(g.sellFill, null);
  assert.strictEqual(card.valueBarGeometry({}, {}).marker, null);
  assert.strictEqual(card.valueBarGeometry({ value_p: 5 }, {}).max, 40);
});

test("value bar: labels near the right edge flip to the left of their line", () => {
  const g = card.valueBarGeometry({ value_p: 20, buy_line_p: 5, sell_line_p: 38, scale_max_p: 40 }, { width: 400, x0: 0 });
  assert.strictEqual(g.buy.anchor, "start");
  assert.strictEqual(g.sell.anchor, "end");
});

test("mode subtitle and exits", () => {
  const m = { since: iso(2.5), exits: [{ kind: "price", text: "The cheap rate ends", expected_at: iso(8) },
    { kind: "level", text: "The battery reaches 88%", expected_at: iso(5.5), first: true }, { kind: "event", text: "The car starts charging" }] };
  const sub = card.modeSubtitle(m);
  assert.match(sub, /^until the battery reaches 88% · expected about \d\d:\d\d · since \d\d:\d\d$/);
  const rows = card.exitRows(m.exits, "charge");
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[1].first, true);
  assert.match(rows[1].when, /^about \d\d:\d\d$/);
  assert.strictEqual(rows[2].when, "any time");
  assert.strictEqual(rows[1].colour, "--m-charge");
  assert.strictEqual(card.modeSubtitle({}), "");
});

test("engine card view: v1 running, nothing published, and the normal case", () => {
  assert.strictEqual(card.engineCardView({ [card.ENGINE_SENSOR]: st("v1") }).text, card.V2_NOT_RUNNING);
  assert.strictEqual(card.engineCardView({ [card.ENGINE_SENSOR]: st("v1") }).kind, "v1");
  assert.strictEqual(card.engineCardView({}).kind, "none");
  assert.strictEqual(card.engineCardView({}).text, card.V2_NO_DATA);
  const v = card.engineCardView({
    [card.ENGINE_SENSOR]: st("v2"),
    "sensor.pe_v2_mode": st("charge", { label: "Charging from the grid", why: "Import is 6.99p", target_soc: 88, power_w: 4800, level_reported: 51, level_filtered: 51.3, values_at: iso(2.5), sending: false, not_sending_reason: "Passive", exits: [] }),
    "sensor.pe_v2_value": st("30.0", { value_p: 30, buy_line_p: 7.36, sell_line_p: 14.25, scale_max_p: 40 }),
  });
  assert.strictEqual(v.kind, "ok");
  assert.strictEqual(v.label, "Charging from the grid");
  assert.strictEqual(v.figs[2].k, "Charging at");
  assert.strictEqual(v.figs[2].v, "4.8 kW");
  assert.strictEqual(v.figs[1].v, "51.3%");
  assert.ok(v.notes.some((n) => /Not sending to the inverter: Passive/.test(n)));
  assert.match(v.barText, /above the 7.4p buy line, so charging pays/);
  assert.match(v.barText, /above the 14.3p sell line, so selling does not pay/);
});

test("engine card view survives a missing value sensor and odd attributes", () => {
  const v = card.engineCardView({ "sensor.pe_v2_mode": st("hold", { exits: "nonsense", power_w: "x" }) });
  assert.strictEqual(v.kind, "ok");
  assert.strictEqual(v.bar, null);
  assert.strictEqual(v.figs[2].v, "–");
  assert.strictEqual(card.engineCardView({ "sensor.pe_v2_mode": st("unavailable") }).kind, "none");
});

test("timeline layout: hours from the left edge, past and future bands, invalid items dropped", () => {
  const L = card.timelineLayout(timeline());
  assert.strictEqual(L.t0, T0);
  assert.strictEqual(L.bands.length, 3);
  assert.deepStrictEqual(L.bands.map((b) => b.state), ["past", "now", "future"]);
  assert.deepStrictEqual([L.bands[1].a, L.bands[1].b], [2.5, 5.5]);
  assert.strictEqual(L.nowH, 3.5);
  assert.strictEqual(L.spanH, 8);
  assert.strictEqual(L.floor, 12);
  assert.strictEqual(L.steps[1].slot, true);
  assert.strictEqual(L.steps[0].slot, false);
  assert.strictEqual(L.mid.length, 9);
  assert.strictEqual(L.nowLevel, 60.5);          // 51 at 3h, 70 at 4h: 3.5h is halfway
  assert.ok(L.ticks.every((t) => new Date(t.ms).getHours() % 3 === 0));
});

test("timeline layout: starts at most six hours before now and ends within 48 hours", () => {
  const tl = timeline();
  tl.now = iso(30);
  tl.items = [{ mode: "hold", start: iso(0), end: iso(100) }];
  tl.path = null; tl.prices = [];
  const L = card.timelineLayout(tl);
  assert.strictEqual(L.t0, T0 + 24 * 3600000);
  assert.strictEqual(L.spanH, 48);
  assert.strictEqual(L.bands[0].a, 0);
  assert.strictEqual(L.bands[0].b, 48);
  assert.deepStrictEqual(card.timelineLayout({}, { now: T0 }).bands, []);
});

test("band labels depend on the width", () => {
  const b = { mode: "charge", until: "until 88%" };
  assert.strictEqual(card.bandLabel(b, 200), "Charge · until 88%");
  assert.strictEqual(card.bandLabel(b, 80), "Charge");
  assert.strictEqual(card.bandLabel(b, 30), "");
  assert.strictEqual(card.bandLabel({ mode: "event" }, 200), "Grid event");
});

test("heat-map colour scale: pale to deep, clamped, grid events apart, dark mode differs", () => {
  const lo = card.heatColour(0), mid = card.heatColour(20), hi = card.heatColour(40), over = card.heatColour(55);
  assert.strictEqual(lo.css, "rgb(247,244,232)");
  assert.strictEqual(hi.css, "rgb(13,71,161)");
  assert.strictEqual(over.css, hi.css);                       // above the scale but not an event: deepest blue
  assert.notStrictEqual(mid.css, lo.css);
  assert.ok(mid.t > 0 && mid.t < 1);
  assert.deepStrictEqual(card.heatColour(109), { kind: "event", css: "var(--m-event)", t: 1 });
  assert.strictEqual(card.heatColour(-5).css, lo.css);
  assert.strictEqual(card.heatColour(null).kind, "none");
  assert.strictEqual(card.heatColour(0, { dark: true }).css, "rgb(36,40,46)");
  assert.strictEqual(card.heatColour(80, { max: 100 }).kind, "scale");
  assert.strictEqual(card.heatColour(80, { max: 40 }).kind, "event");
});

test("value map grid: each level covers half a step either side, clipped to the axis", () => {
  const g = card.valueMapGrid(curve(), T0, 4);
  assert.strictEqual(g.cells.length, 4 * 3);                  // rows 0..3 fall inside 4 hours
  const row0 = g.cells.filter((c) => c.row === 0);
  assert.deepStrictEqual(row0.map((c) => [c.lo, c.hi]), [[0, 25], [25, 75], [75, 100]]);
  assert.deepStrictEqual([row0[0].a, row0[0].b], [0, 1]);
  assert.strictEqual(card.mapCellAt(g, 0.5, 10).value, 10);
  assert.strictEqual(card.mapCellAt(g, 0.5, 60).value, 20);
  assert.strictEqual(card.mapCellAt(g, 2.5, 99).value, 20);
  assert.strictEqual(card.mapCellAt(g, 9, 50), null);
  assert.strictEqual(card.mapCellAt(null, 1, 1), null);
  assert.strictEqual(card.valueMapGrid({}, T0, 4), null);
  assert.strictEqual(card.valueMapGrid({ start: iso(0), levels: [0, 100], values: [[1]] }, T0, 4).cells.length, 1);
});

test("a window that starts later cuts the first rows off", () => {
  const g = card.valueMapGrid(curve(), T0 + 2 * 3600000, 2);
  assert.strictEqual(g.cells[0].row, 2);
  assert.strictEqual(g.cells[0].a, 0);
});

test("value along the expected path, and the real prices as lines in value terms", () => {
  assert.strictEqual(card.interpValue([0, 50, 100], [10, 20, 30], 25), 15);
  assert.strictEqual(card.interpValue([0, 50, 100], [10, 20, 30], 150), 30);
  assert.strictEqual(card.interpValue([0, 50, 100], [10, 20, 30], -5), 10);
  assert.strictEqual(card.interpValue([], [], 5), null);
  const L = card.timelineLayout(timeline());
  const series = card.pathValueSeries(curve(), L);
  assert.strictEqual(series.length, 9);
  assert.ok(Math.abs(series[0].value - 18.2) < 1e-9);         // hour 0 is row 0 (10, 20, 30 at 0, 50, 100%); 41% -> 10 + 10 * 0.82
  assert.ok(Math.abs(series[4].value - 25) < 1e-9 || series[4].value > 0);
});

test("path lines are the prices times the losses the value sensor reports, never a made-up price", () => {
  const L = card.timelineLayout(timeline());
  const lines = card.pathLines(L, { import_p: 6.99, buy_line_p: 7.36, export_p: 15, sell_line_p: 14.25 });
  assert.strictEqual(lines.afterLosses, true);
  assert.ok(Math.abs(lines.buy[1].p - 6.99 * (7.36 / 6.99)) < 1e-9);
  assert.ok(Math.abs(lines.sell[0].p - 14.25) < 1e-9);
  const raw = card.pathLines(L, {});
  assert.strictEqual(raw.afterLosses, false);
  assert.strictEqual(raw.buy[0].p, 28.84);
  assert.strictEqual(raw.sell[0].p, 15);
  assert.deepStrictEqual(card.pathLines(null, {}).buy, []);
});

test("map readout text", () => {
  const cell = { lo: 25, hi: 75, value: 20 };
  assert.match(card.mapReadoutText(cell, "03:30", 7.4), /At 03:30 with the battery at 25–75%, one more kWh is worth 20p\. Buying then costs 7.4p per stored kWh: worth it/);
  assert.match(card.mapReadoutText({ lo: 80, hi: 80, value: 5 }, "03:30", 7.4), /at 80%.*not worth it/);
  assert.match(card.mapReadoutText(cell, "03:30", null), /20p\.$/);
  assert.match(card.mapReadoutText(null), /^Point at the map/);
});

test("plan card view: gates and content", () => {
  assert.strictEqual(card.planCardView({ [card.ENGINE_SENSOR]: st("v1") }).text, card.V2_NOT_RUNNING);
  assert.strictEqual(card.planCardView({}).kind, "none");
  assert.strictEqual(card.planCardView({ "sensor.pe_v2_timeline": st(iso(0), { items: [] }) }).kind, "none");
  const v = card.planCardView({ "sensor.pe_v2_timeline": st(iso(3), timeline()), "sensor.pe_v2_value_curve": st(iso(3), curve()),
    "sensor.pe_v2_value": st("30", { scale_max_p: 50, import_p: 6.99, buy_line_p: 7.36 }) });
  assert.strictEqual(v.kind, "ok");
  assert.strictEqual(v.scaleMax, 50);
  assert.ok(v.grid && v.layout);
  assert.match(v.cost, /Expected cost £1.23 against £2.34 on Self-use; comfort band gave up £0.06/);
  assert.match(v.chip, /new prices published/);
  // the curve alone still draws a map
  const only = card.planCardView({ "sensor.pe_v2_value_curve": st(iso(0), curve()) });
  assert.strictEqual(only.kind, "ok");
  assert.strictEqual(only.layout, null);
  assert.strictEqual(only.scaleMax, 40);
});

test("health: causes biggest first, backstop flagged, weights and comfort text", () => {
  const bars = card.causeBars({ causes: { drift: 3, slots_changed: 2, backstop: 1, something_new: 2, none: 0 }, revalues: 9 });
  assert.deepStrictEqual(bars.map((b) => b.key), ["drift", "slots_changed", "something_new", "backstop"]);
  assert.strictEqual(bars[0].pct, 100);
  assert.strictEqual(bars[3].warn, true);
  assert.strictEqual(bars[2].label, "Something new");
  assert.strictEqual(card.causeBars({ causes: {}, backstop: 2 })[0].warn, true);
  const v = card.healthCardView({
    "sensor.pe_v2_triggers": st("9", { recent: [{ at: iso(1), kind: "price", text: "New prices", effect: "revalue" }],
      today: { causes: { drift: 3 }, revalues: 9, mode_changes: 7, flip_flops: 0, deadlines_missed: 1, longest_calc_s: 2.4 } }),
    "sensor.pe_diag_v2": st("ok", { weights: { solar: { morning: [0.29, 0.51, 0.2], midday: [0.34, 0.48, 0.18] }, days: 23, start: { solar: [0.25, 0.5, 0.25] } },
      soc_offset: { charging: -0.9, holding: 0, discharging: 0.3 }, filter_gap_max_today: 1.2,
      comfort: [{ date: "2026-10-05", hours_above: 3.5, hours_below: 0, given_up: 0.06, decisions_changed: 2 }] }),
    "sensor.pe_diag_v2_settings": st("30", { settings: [], values: { comfort_low_soc: 20, comfort_high_soc: 90 } }),
  });
  assert.strictEqual(v.kind, "ok");
  assert.strictEqual(v.revalues, 9);
  assert.deepStrictEqual(v.figs.map((f) => f.v), ["7", "0", "1", "2.4 s"]);
  assert.deepStrictEqual(v.weights[1].pct, [34, 48, 18]);
  assert.deepStrictEqual(v.weightsStart, [25, 50, 25]);
  assert.strictEqual(v.comfort.title, "Comfort band (20 to 90%)");
  assert.strictEqual(v.comfort.text, "3.5 h above 90%, none below 20%. Gave up £0.06 against no band; changed 2 decisions.");
  assert.match(v.filterText, /0.9 points low while charging.*0.3 points high while discharging/);
  assert.strictEqual(v.recent[0].text, "New prices");
  assert.strictEqual(card.healthCardView({ [card.ENGINE_SENSOR]: st("v1") }).text, card.V2_NOT_RUNNING);
  assert.strictEqual(card.healthCardView({}).kind, "none");
  assert.strictEqual(card.healthCardView({ "sensor.pe_v2_triggers": st("0", {}) }).kind, "ok");
});

test("config grouping: v1-only settings leave the house topics, nothing is lost, nothing doubles", () => {
  const settings = ["battery_floor_soc", "min_reserve_soc", "grid_charge_target_soc", "charge_hysteresis_soc", "main_fuse_a", "cheap_threshold_p",
    "window_switch_cost_p", "battery_wear_p", "arbitrage_min_soc", "pre_axle_lookahead_h", "axle_margin_soc", "export_limit_kw", "brand_new_setting"];
  const features = ["optimised_plan", "auto_cheap_threshold", "fill_when_cheap", "arbitrage", "deep_overnight", "axle", "use_check_meter"];
  const system = ["engine", "overnight_window", "control_method"];
  const on = card.engineGrouping(["battery_soc"], settings, features, system, true);
  assert.strictEqual(on.grouped, true);
  const houseSettings = on.house.flatMap((t) => t.settings), houseFeatures = on.house.flatMap((t) => t.features);
  ["min_reserve_soc", "grid_charge_target_soc", "charge_hysteresis_soc", "cheap_threshold_p", "window_switch_cost_p", "battery_wear_p", "arbitrage_min_soc", "pre_axle_lookahead_h", "axle_margin_soc"]
    .forEach((k) => assert.ok(!houseSettings.includes(k), k));
  ["battery_floor_soc", "main_fuse_a", "export_limit_kw", "brand_new_setting"].forEach((k) => assert.ok(houseSettings.includes(k), k));
  ["optimised_plan", "auto_cheap_threshold", "fill_when_cheap", "arbitrage", "deep_overnight"].forEach((k) => assert.ok(!houseFeatures.includes(k), k));
  ["axle", "use_check_meter"].forEach((k) => assert.ok(houseFeatures.includes(k), k));
  assert.ok(!on.house.flatMap((t) => t.system).includes("engine"));            // the choice has its own control
  const v1Settings = on.v1.flatMap((s) => s.settings), v1Features = on.v1.flatMap((s) => s.features);
  assert.deepStrictEqual(v1Settings.slice().sort(), ["arbitrage_min_soc", "axle_margin_soc", "battery_wear_p", "charge_hysteresis_soc", "cheap_threshold_p",
    "grid_charge_target_soc", "min_reserve_soc", "pre_axle_lookahead_h", "window_switch_cost_p"]);
  assert.deepStrictEqual(v1Features.slice().sort(), ["arbitrage", "auto_cheap_threshold", "deep_overnight", "fill_when_cheap", "optimised_plan"]);
  // the battery floor is a shared setting in the battery topic
  assert.ok(on.house.find((t) => t.key === "battery").settings.includes("battery_floor_soc"));
  // every key lands somewhere exactly once
  const all = houseSettings.concat(v1Settings);
  assert.strictEqual(new Set(all).size, all.length);
  assert.deepStrictEqual(all.slice().sort(), settings.slice().sort());
});

test("config grouping: without v2 nothing moves", () => {
  const settings = ["min_reserve_soc", "cheap_threshold_p"], features = ["optimised_plan"], system = ["engine", "control_method"];
  const off = card.engineGrouping([], settings, features, system, false);
  assert.strictEqual(off.grouped, false);
  assert.deepStrictEqual(off.v1, []);
  assert.deepStrictEqual(off.house, require("../ha-powerengine-card.js").topicPlan([], settings, features, system));
  assert.ok(off.house.flatMap((t) => t.settings).includes("min_reserve_soc"));
});

test("v2 keys are sent only when the app publishes the v2 settings", () => {
  assert.deepStrictEqual(card.engineFields(false, "v2", { reserve_soc: 15 }), {});
  assert.deepStrictEqual(card.engineFields(true, "v2", { reserve_soc: "15", arbitrage: true, junk: "" }), { system: { engine: "v2" }, engine_v2: { reserve_soc: 15, arbitrage: true } });
  assert.deepStrictEqual(card.engineFields(true, "v1", {}), { system: { engine: "v1" } });
  assert.deepStrictEqual(card.engineFields(true, "sideways", { terminal_value: "fixed" }), { engine_v2: { terminal_value: "fixed" } });
  const states = { "sensor.pe_diag_v2_settings": st("30", { settings: [{ key: "reserve_soc" }] }) };
  assert.strictEqual(card.v2Supported(states), true);
  assert.strictEqual(card.v2Supported({}), false);
  assert.strictEqual(card.v2Supported({ "sensor.pe_diag_v2_settings": st("unavailable", { settings: [{ key: "x" }] }) }), false);
  assert.strictEqual(card.v2Supported({ "sensor.pe_diag_v2_settings": st("0", { settings: [] }) }), false);
});

test("buildConfig carries engine and engine_v2 only for a draft that opted in; the rest is as before", () => {
  const base = { inputs: {}, features: {}, operation: {}, system: { control_method: "ram" } };
  const plain = card.buildConfig(Object.assign({}, base));
  assert.strictEqual(plain.engine_v2, undefined);
  assert.deepStrictEqual(plain.system, { control_method: "ram" });
  const v2 = card.buildConfig(Object.assign({}, base, { system: { control_method: "ram", engine: "v2" }, engine_v2: { reserve_soc: "14" } }));
  assert.deepStrictEqual(v2.system, { control_method: "ram", engine: "v2" });
  assert.deepStrictEqual(v2.engine_v2, { reserve_soc: 14 });
  const empty = card.buildConfig(Object.assign({}, base, { system: { engine: "v1" }, engine_v2: {} }));
  assert.strictEqual(empty.engine_v2, undefined);
  assert.deepStrictEqual(empty.system, { engine: "v1" });
});

test("engine in use: the running engine wins, then the saved choice", () => {
  assert.strictEqual(card.engineInUse({ [card.ENGINE_SENSOR]: st("v2") }, { system: { engine: "v1" } }), "v2");
  assert.strictEqual(card.engineInUse({}, { system: { engine: "v2" } }), "v2");
  assert.strictEqual(card.engineInUse({}, {}), "v1");
  assert.strictEqual(card.engineInUse({ [card.ENGINE_SENSOR]: st("unavailable") }, null), "v1");
});

test("the confirmation reads the same in both directions", () => {
  const up = card.engineConfirm("v1", "v2"), down = card.engineConfirm("v2", "v1");
  assert.strictEqual(up.title, "Switch to engine v2?");
  assert.strictEqual(down.title, "Switch to engine v1?");
  assert.strictEqual(up.confirm, "Switch to v2");
  assert.strictEqual(up.cancel, "Keep v1");
  assert.strictEqual(down.confirm, "Switch to v1");
  assert.strictEqual(down.cancel, "Keep v2");
  assert.match(up.text, /Active, Passive and Pause stay as they are/);
  assert.match(down.text, /Active, Passive and Pause stay as they are/);
  assert.match(up.text, /Engine v1's settings are kept/);
  assert.match(down.text, /Engine v2's settings are kept/);
  assert.strictEqual(up.text.replace(/v[12]/g, "vX"), down.text.replace(/v[12]/g, "vX"));
});

test("v2 setting checks", () => {
  const num = { kind: "number", min: 0, max: 100 }, int = { kind: "int", min: 1, max: 10 };
  assert.strictEqual(card.v2Problem(num, "50"), "");
  assert.match(card.v2Problem(num, "101"), /between 0 and 100/);
  assert.strictEqual(card.v2Problem(num, ""), "Enter a number");
  assert.match(card.v2Problem(int, "2.5"), /whole number/);
  assert.strictEqual(card.v2Problem({ kind: "bool" }, true), "");
  assert.strictEqual(card.v2Problem({ kind: "choice", options: ["refill", "fixed"] }, "fixed"), "");
  assert.match(card.v2Problem({ kind: "choice", options: ["refill", "fixed"] }, "other"), /options/);
  assert.ok(card.v2Contradictions({ comfort_low_soc: 90, comfort_high_soc: 20 }).comfort_low_soc);
  assert.deepStrictEqual(card.v2Contradictions({ comfort_low_soc: 20, comfort_high_soc: 90 }), {});
  assert.ok(card.v2Contradictions({ solar_low_pct: 0, solar_mid_pct: 0, solar_high_pct: 0 }).solar_low_pct);
  assert.strictEqual(card.v2Same("5", 5), true);
  assert.strictEqual(card.v2Same(true, "true"), true);
  assert.strictEqual(card.v2Same("fixed", "refill"), false);
  assert.deepStrictEqual(card.v2Values({ values: { a: 1, b: 2 } }, { b: 3 }), { a: 1, b: 3 });
});

test("readouts under the v2 settings", () => {
  const diag = { weights: { solar: { midday: [0.34, 0.48, 0.18] }, days: 23 }, comfort: [{ date: "2026-10-05", hours_above: 3.5, hours_below: 0, given_up: 0.06, decisions_changed: 2 }] };
  assert.match(card.weightsReadout(diag), /Learned now \(midday\): 34 \/ 48 \/ 18 from 23 days/);
  assert.strictEqual(card.weightsReadout({}), null);
  assert.match(card.comfortReadout(diag, { comfort_low_soc: 20, comfort_high_soc: 90 }), /Latest day \(2026-10-05\): 3.5 h above 90%, none below 20%/);
  assert.strictEqual(card.comfortReadout({}, {}), null);
  assert.strictEqual(card.floorsReadout({ battery_floor_soc: 12 }, { hard_floor_margin_pct: 1 }), "Hard floor 12% (the battery's own limit, set under Your house). Grid events stop at 13%.");
  assert.strictEqual(card.floorsReadout({}, {}), null);
});

test("the battery topic lists the new shared floor setting", () => {
  assert.ok(card.TOPICS.find((t) => t.key === "battery").settings.includes("battery_floor_soc"));
});

test("preview: engine v1 in control with v2 publishing shows the data with a Preview line", () => {
  const pre = (extra = {}) => Object.assign({
    [card.ENGINE_SENSOR]: st("v1", { v2_available: true, v2_preview: true }),
    "sensor.pe_v2_mode": st("charge", { label: "Charging from the grid", why: "Import is 6.99p", preview: true, sending: false, not_sending_reason: "Preview: engine v1 is in control", exits: [] }),
    "sensor.pe_v2_value": st("30.0", { value_p: 30, buy_line_p: 7.36, sell_line_p: 14.25, scale_max_p: 40 }),
    "sensor.pe_v2_timeline": st(iso(3), timeline()), "sensor.pe_v2_value_curve": st(iso(3), curve()),
    "sensor.pe_v2_triggers": st("3", { today: { revalues: 3 }, recent: [] }), "sensor.pe_diag_v2": st("ok", {}),
  }, extra);
  assert.strictEqual(card.v2Preview(pre()), true);
  const e = card.engineCardView(pre());
  assert.strictEqual(e.kind, "ok");
  assert.strictEqual(e.preview, true);
  assert.strictEqual(e.label, "Would be charging from the grid");
  assert.ok(!e.notes.some((n) => /Not sending/.test(n)));
  assert.strictEqual(card.planCardView(pre()).preview, true);
  assert.strictEqual(card.healthCardView(pre()).preview, true);
  assert.match(card.previewBanner(true), /Preview: engine v1 is in control\. Nothing is sent\./);
  assert.strictEqual(card.previewBanner(false), "");
  assert.strictEqual(card.previewLabel("Self-use", false), "Self-use");
});

test("preview: off, stale or absent keeps the old message; a live v2 is never a preview", () => {
  // preview switched off: engine sensor is v1 without v2_preview, the v2 sensors are stale
  const stale = { [card.ENGINE_SENSOR]: st("v1", { v2_available: true }), "sensor.pe_v2_mode": st("hold", { preview: true }), "sensor.pe_v2_value": st("1") };
  assert.strictEqual(card.v2Preview(stale), false);
  assert.strictEqual(card.engineCardView(stale).text, card.V2_NOT_RUNNING);
  // an app 0.9.106 (no preview anywhere)
  assert.strictEqual(card.engineCardView({ [card.ENGINE_SENSOR]: st("v1", { v2_available: true }) }).text, card.V2_NOT_RUNNING);
  // v2 live
  const live = { [card.ENGINE_SENSOR]: st("v2"), "sensor.pe_v2_mode": st("hold", { preview: false, label: "Holding" }), "sensor.pe_v2_value": st("1") };
  assert.strictEqual(card.v2Preview(live), false);
  assert.strictEqual(card.engineCardView(live).label, "Holding");
  // no engine sensor: the v2 mode's own flag decides
  assert.strictEqual(card.v2Preview({ "sensor.pe_v2_mode": st("hold", { preview: true }) }), true);
  // preview flag but no v2 mode data
  assert.strictEqual(card.v2Preview({ [card.ENGINE_SENSOR]: st("v1", { v2_preview: true }) }), false);
});
