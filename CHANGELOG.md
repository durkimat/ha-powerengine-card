# Changelog

Released in step with the [PowerEngine app](https://github.com/durkimat/ha-powerengine-controller); versions match.

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
