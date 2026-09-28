# PowerEngine card: notes for Claude

This is the Lovelace card for the PowerEngine app. **Read `../ha-powerengine-controller/CLAUDE.md` first**: it has
the release routine, guardrails and current plan for both repos.

- One file: `ha-powerengine-card.js`. It holds several custom elements: config, toggle, handover, test,
  diagnostics, update, health, log and sim cards.
- Tests: `node --test tests/helpers.test.cjs`. Pure helpers are exported via `module.exports` at the bottom for
  testing.
- `CARD_VERSION` moves in step with the app's version, even when the card doesn't change ("No card changes;
  version kept in step with the app.").
