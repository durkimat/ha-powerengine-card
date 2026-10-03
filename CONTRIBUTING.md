# Contributing to the PowerEngine card

This is the Lovelace card for [PowerEngine](https://github.com/durkimat/ha-powerengine-controller). Contributions follow the same
rules as the app, which are written up in its
**[CONTRIBUTING.md](https://github.com/durkimat/ha-powerengine-controller/blob/main/CONTRIBUTING.md)**: read that first (what to
send, the rules the code keeps, safety on other people's hardware). This page only adds what is specific to the card.

Licence: [Apache-2.0](LICENSE). Under section 5 of that licence, what you submit is licensed to the project on the same terms.

## What lives here

One file, `ha-powerengine-card.js`, holds every card (configuration, setup wizard, tests, health, update and so on). Pure helpers
are exported at the bottom (`module.exports`) so they can be tested without a browser.

## Checks

```
node --check ha-powerengine-card.js
node --test tests/*.test.cjs
```

To look at a card without a Home Assistant, load the file in a page with a fake `hass` object (`states`, `entities`, `devices`) and
the app's published attributes, as `tests/wizard.test.cjs` does for the helpers.

## Rules specific to the card

- **No supplier or device names in texts.** Use `<<term>>` placeholders (`fillNames`): `<<supplier>>`, `<<event>>`, `<<ev_charger>>`
  and so on. The wizard holds no brand names at all: what to look for comes from the app.
- **Pair changes with the app.** A new setting in the app needs adding to the card's section lists. If the card starts to need
  something newer from the app, raise `MIN_APP_VERSION`, and release both.
- **Hide, don't break, on an older app.** A card that needs a new attribute hides itself when the app doesn't publish it.
- **Words matter.** Use "grid events" for the concept; the provider's name comes from the names map.
- **Releases** take the app's version number and are done by the owner with the app (`tools/release.sh` or the Release workflow in
  the app repo). Draft notes in plain words with your PR.
