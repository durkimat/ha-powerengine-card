# PowerEngine card: notes for Claude

This is the Lovelace card for the PowerEngine app. **Read `../ha-powerengine-controller/CLAUDE.md` first**: it has
the release routine, guardrails and current plan for both repos.

- One file: `ha-powerengine-card.js`. It holds several custom elements: config, toggle, handover, test,
  diagnostics, update, health, log and sim cards.
- Tests: `node --test tests/helpers.test.cjs`. Pure helpers are exported via `module.exports` at the bottom for
  testing.
- The card is released only when it changes, taking the app version it ships with (one sequence; numbers can skip,
  e.g. 0.9.70 to 0.9.74). `tools/release.sh` in the app repo does it with `--card-notes`.
- `MIN_APP_VERSION` is the oldest app the card works with (0.9.72: the `custom` waterfall period). The app publishes
  `min_card_version` on `sensor.pe_diag_version`. Each side warns only when the other is older than its minimum
  (`versionWarnings`), not when the versions differ. Raise `MIN_APP_VERSION` when the card starts to need something
  a newer app publishes.
