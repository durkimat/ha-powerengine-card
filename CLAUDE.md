# PowerEngine card: notes for Claude

This is the Lovelace card for the PowerEngine app. **Read `../ha-powerengine-controller/CLAUDE.md` first**: it has
the release routine, guardrails and current plan for both repos. It is `durkimat/ha-powerengine-controller`; clone it
beside this repo (`../ha-powerengine-controller`). If it isn't there, say so and stop rather than guess. Releases run
on the owner's machine, not in a cloud session.

- One file: `ha-powerengine-card.js`. It holds several custom elements: config, toggle, handover, test,
  diagnostics, update, health, log and sim cards.
- Tests: `node --test tests/helpers.test.cjs`. Pure helpers are exported via `module.exports` at the bottom for
  testing.
- The card is released only when it changes, taking the app version it ships with (one sequence; numbers can skip,
  e.g. 0.9.70 to 0.9.74). `tools/release.sh` in the app repo does it with `--card-notes`.
- `MIN_APP_VERSION` is the oldest app the card works with (0.9.69: `demo_days`). The app publishes
  `min_card_version` on `sensor.pe_diag_version`. Each side warns only when the other is older than its minimum
  (`versionWarnings`), not when the versions differ. Raise `MIN_APP_VERSION` when the card starts to need something
  a newer app publishes.
- The setup wizard (`PowerEngineWizardCard`, section "setup wizard and candidate export") works from what the app publishes as
  `sensor.pe_diag_version` attribute `wizard`; it holds no brand names itself. Its pure helpers (`wizard*`, `scrubText`,
  `buildCandidateExport`) are tested in `tests/wizard.test.cjs`. Format and rules: the app repo's `docs/WIZARD.md`. Not yet run on
  a live Home Assistant. To look at it without one, load the file in a page with a fake `hass` (states, entities, devices) and the
  app's published JSON, as the tests do for the helpers.
- The wizard is folded away when the app is configured (`wizOpen`), reads what is in use (`wizardInUse`: the candidate holding a saved
  mapped entity), lists other candidates and unowned energy devices (`wizardAlso`, `wizardOthers`); "Your system" shows the same
  ("also found"). The setup card hides itself when `setupSummary().allSet`. Use "grid events" for the concept in texts; the provider
  name comes from `<<event>>`.
