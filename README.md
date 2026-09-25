# PowerEngine Card

The configuration page for [PowerEngine](https://github.com/durkimat/ha-powerengine-controller):
input mappings, feature switches and safety margins, edited with Home Assistant's
own entity pickers and validated before saving.

> **Status: early development (0.0.x).** The card currently only shows its version
> and whether the app is detected.

## Install (HACS)

1. HACS → ⋮ → *Custom repositories* → add this repo with category **Dashboard**.
2. Install **PowerEngine Card** (HACS adds the dashboard resource).
3. Create a dashboard for admins only, hidden from the sidebar, and add:

```yaml
type: custom:powerengine-config-card
```

Keep the card and app on the same version.
