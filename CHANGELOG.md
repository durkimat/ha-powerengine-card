# Changelog

Released in step with the [PowerEngine app](https://github.com/durkimat/ha-powerengine-controller); versions match.

## 0.5.10 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.5.9 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.5.8 (beta)

### Behaviour changes
- Smart-charge optimisation description updated.

## 0.5.7 (beta)

### Behaviour changes
- Energy arbitrage description updated: it is now planned (and simulated in Passive mode).

## 0.5.6 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.5.5 (beta)

### Behaviour changes
- New feature checkbox **Automatic cheap threshold** (on by default).

## 0.5.4 (beta)

### Behaviour changes
- Unmapped inputs with a suggested entity now show **Suggested: <entity>** (click to use it), and a section with
  several shows **Use all N suggested entities**. Previously suggestions were only pre-filled on a brand-new
  config, so inputs added in later versions (like the Solis timed-slot controls) started empty.

## 0.5.3 (beta)

### Behaviour changes
- Reads the settings list from the app's new `sensor.pe_map_settings` (app 0.5.3), falling back to the old location.

## 0.5.2 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.5.1 (beta)

### Behaviour changes
- New **Notifications** section on the config page: choose the phone's notify service (from those HA offers) and which notifications to send.

## 0.5.0 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.13 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.12 (beta)

### Behaviour changes
- New `custom:powerengine-toggle-card`: a discreet row with an optional title on the left and a small switch
  (icon, name, slider) on the right; no card box. Used by the app's Costs tab for number alignment.

## 0.4.11 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.10 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.9 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.8 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.7 (beta)

### Behaviour changes
- With Battery charging power and Battery discharging power both mapped, Battery power shows **Not used** (no
  sign note, no Invert, no live readout or problems) and the pair show **Required**.

## 0.4.6 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.5 (beta)

### Behaviour changes
- None. Version kept in step with the app (the new battery inputs appear automatically).

## 0.4.4 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.3 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.2 (beta)

### Behaviour changes
- The config page is split into collapsible sections: Operation and features; settings by topic (Battery and
  charging, Supply limits, Axle events, Arbitrage); one section per input group; Solar plants.
- Each section's header shows how many items need checking and how many are unsaved; sections with problems open
  by themselves. *Expand all* / *Collapse all* at the top; which sections are open is remembered in this browser.
- With an older app (no sections sent), all settings appear in one section.

## 0.4.1 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.4.0 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.8 (beta)

### Behaviour changes
- New feature checkbox **Top up when cheap** (on by default).
- The **Energy arbitrage** option says it isn't built yet and warns to check export tariff terms.

## 0.3.7 (beta)

### Behaviour changes
- None. The settings section is now headed "Safety, limits and thresholds" (it now holds the main fuse and car charger settings).

## 0.3.6 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.5 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.4 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.3 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.2 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.1 (beta)

### Behaviour changes
- None. Version kept in step with the app.

## 0.3.0 (beta)

### Behaviour changes
- None. Version kept in step with the app (0.3.0, "Plan").

## 0.2.0 (beta)

### Behaviour changes
- None to your devices.

### Added
- **Safety and thresholds** section (minimum reserve, cheap-import threshold, grid-charge target, restart margin,
  Axle look-ahead and margin), with ranges checked before saving.
- **House load includes the car charger** option (Grid and house).
- View-only mode for non-admin users.
- The card now lives on the PowerEngine dashboard's **Config** tab; a separate dashboard is no longer needed.

## 0.1.0 (beta)

### Behaviour changes
- None. Version kept in step with the app (0.1.0, "See").

## 0.0.4 (beta)

### Behaviour changes
- None to your devices. The card can now **save** PowerEngine's configuration (admin only).

### Added
- Every input grouped by area, each with a one-line description and a Required/Optional badge.
- HA entity pickers, with suggestions pre-filled from your system on first use; fixed values where allowed.
- **Live values** next to each input (rate lists, forecasts and dispatches are summarised).
- Signed inputs show the expected sign, an **Invert** tickbox, and how PowerEngine will read the live value.
- Instant checks (exists, domain, unit, availability) and PowerEngine's own check after saving.
- Solar plants: main plant plus **+ Add solar plant**.
- Features and operation mode (Active disabled in this build).
- Bump/boost entities can never be chosen as control outputs.

## 0.0.3 (beta)

### Behaviour changes
- None. The card now shows whether the app is running, its version and operation mode, and warns if app and card versions differ.

## 0.0.2 (beta)

### Behaviour changes
- None. Version bump to stay in step with the app (0.0.2).

## 0.0.1 (beta)

### Behaviour changes
- None. Scaffold card: shows its version and whether the PowerEngine app is detected. No editing yet.
