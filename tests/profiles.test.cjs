const test = require("node:test");
const assert = require("node:assert");
const c = require("../ha-powerengine-card.js");

const cat = {
  profile: "2.1 beta",
  profiles: {
    builtin: [{ name: "defaults", note: "d", values: {} }, { name: "2.1 beta", note: "b", values: { executor: "plan", top_up_cost_p: 0 } }],
    saved: [], site_keys: ["reserve_soc", "arbitrage"], max_saved: 2, max_name: 10,
  },
};

test("with profiles, 2.1 beta is a profile of engine v2, not an engine", () => {
  assert.strictEqual(c.uiEngine(cat, "v2_1"), "v2");
  assert.strictEqual(c.uiEngine({}, "v2_1"), "v2_1");     // an older app: unchanged
  assert.strictEqual(c.uiEngine(cat, "v1"), "v1");
});

test("the draft takes the saved profile, else the one the app runs, else defaults", () => {
  assert.deepStrictEqual(c.profileDraft(cat, {}), { v2_profile: "2.1 beta", v2_profiles: {} });
  assert.deepStrictEqual(c.profileDraft(cat, { v2_profile: "mine", v2_profiles: { mine: { executor: "lines" } } }), { v2_profile: "mine", v2_profiles: { mine: { executor: "lines" } } });
  assert.deepStrictEqual(c.profileDraft(null, {}), { v2_profile: "defaults", v2_profiles: {} });
});

test("the list has the built-in profiles first, then yours", () => {
  assert.deepStrictEqual(c.profileList(cat, { zed: {}, amy: {} }).map((p) => p.name), ["defaults", "2.1 beta", "amy", "zed"]);
});

test("loading drops your changes to the tuning but keeps the house settings", () => {
  const f = c.profileLoadFields(cat, {}, { top_up_cost_p: 5, reserve_soc: 15 }, "2.1 beta");
  assert.deepStrictEqual(f, { v2_profile: "2.1 beta", v2_profiles: {}, engine_v2: { reserve_soc: 15 } });
  assert.match(c.profileLoadFields(cat, {}, {}, "nope").error, /No profile/);
});

test("saving stores the profile in use plus your changes, and switches to it", () => {
  const f = c.profileSaveFields(cat, {}, "2.1 beta", { top_up_cost_p: 3, reserve_soc: 15 }, " mine ");
  assert.strictEqual(f.v2_profile, "mine");
  assert.deepStrictEqual(f.v2_profiles, { mine: { executor: "plan", top_up_cost_p: 3 } });
  assert.deepStrictEqual(f.engine_v2, { reserve_soc: 15 });
});

test("saving refuses a bad name, a built-in name and too many profiles", () => {
  assert.match(c.profileSaveFields(cat, {}, "defaults", { a: 1 }, "").error, /name/);
  assert.match(c.profileSaveFields(cat, {}, "defaults", { a: 1 }, "DEFAULTS").error, /built-in/);
  assert.match(c.profileSaveFields(cat, {}, "defaults", { a: 1 }, "x".repeat(11)).error, /at most 10/);
  assert.match(c.profileSaveFields(cat, { a: {}, b: {} }, "defaults", { x: 1 }, "c").error, /Up to 2/);
  assert.ok(!c.profileSaveFields(cat, { a: {}, b: {} }, "defaults", { x: 1 }, "b").error);   // replacing one is fine
});

test("deleting the profile in use goes back to defaults and keeps your changes", () => {
  const f = c.profileDeleteFields(cat, { mine: {}, other: {} }, "mine", { top_up_cost_p: 1 });
  assert.deepStrictEqual(f, { v2_profile: "defaults", v2_profiles: { other: {} }, engine_v2: { top_up_cost_p: 1 } });
});

test("a save carries the profile and saved profiles only when there are some", () => {
  const draft = { system: { engine: "v2" }, engine_v2: {}, v2_profile: "mine", v2_profiles: { mine: { executor: "plan" } } };
  const out = c.buildConfig(draft);
  assert.strictEqual(out.v2_profile, "mine");
  assert.deepStrictEqual(out.v2_profiles, { mine: { executor: "plan" } });
  assert.ok(!("v2_profiles" in c.buildConfig({ system: { engine: "v2" }, engine_v2: {}, v2_profile: "defaults", v2_profiles: {} })));
});

test("the profiles sensor is merged into the catalogue only when the app publishes it", () => {
  const st = (attributes) => ({ attributes });
  const base = { [c.V2_SETTINGS || "sensor.pe_diag_v2_settings"]: st({ settings: [{ key: "a" }] }) };
  assert.strictEqual(c.v2WithProfiles(base).profiles, undefined);
  const withP = Object.assign({}, base, { [c.V2_PROFILES]: st({ profile: "mine", builtin: [], saved: ["mine"] }) });
  const v = c.v2WithProfiles(withP);
  assert.strictEqual(v.profile, "mine");
  assert.deepStrictEqual(v.profiles.saved, ["mine"]);
  assert.deepStrictEqual(v.settings, [{ key: "a" }]);
});
