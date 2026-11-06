# PowerEngine Card (retired)

**This repository is retired and read-only.** The dashboard card is now part of
[PowerEngine](https://github.com/durkimat/ha-powerengine-controller): the integration serves it and adds it to Home
Assistant itself, so there is nothing to install separately. Its source lives in the `card/` folder of that
repository and it is released with PowerEngine.

If you installed this repository from HACS (as a Dashboard), remove it and its Lovelace resource after updating
PowerEngine to 0.9.215 or newer; the integration provides the card, and having both loads it twice.

The last release of this repository is v0.9.200.
