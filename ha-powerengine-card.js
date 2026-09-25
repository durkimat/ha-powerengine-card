/*
 * PowerEngine config card for Home Assistant.
 *
 * v0.0.x is a scaffold: it shows whether the PowerEngine app is running, its
 * version and operation mode. Editing arrives in later releases.
 */
const CARD_VERSION = "0.0.3";
const VERSION_SENSOR = "sensor.pe_diag_version";
const MODE_SENSOR = "sensor.pe_state_operation_mode";

class PowerEngineConfigCard extends HTMLElement {
  setConfig(config) {
    this._config = config || {};
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 3;
  }

  _render() {
    if (!this.shadowRoot) return;
    const states = (this._hass && this._hass.states) || {};
    const ver = states[VERSION_SENSOR];
    const mode = states[MODE_SENSOR];
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    let body;
    if (!ver || ver.state === "unavailable") {
      body = "<p>PowerEngine app not detected. Check it is installed and that AppDaemon's MQTT plugin is set up.</p>";
    } else {
      const reason = mode && mode.attributes && mode.attributes.reason ? esc(mode.attributes.reason) : "";
      const mismatch = ver.state !== CARD_VERSION
        ? `<p class="warn">App is v${esc(ver.state)} but this card is v${CARD_VERSION}; update both to the same version.</p>` : "";
      body = `<p>App v${esc(ver.state)} running. Mode: <b>${esc(mode ? mode.state : "unknown")}</b></p>
        <p class="muted">${reason}</p>${mismatch}`;
    }
    this.shadowRoot.innerHTML = `
      <ha-card header="PowerEngine configuration">
        <div class="content">
          ${body}
          <p class="muted">Card v${CARD_VERSION} (scaffold: editing not available yet)</p>
        </div>
      </ha-card>
      <style>
        .content { padding: 0 16px 16px; }
        .muted { color: var(--secondary-text-color); font-size: 0.9em; }
        .warn { color: var(--warning-color); }
      </style>`;
  }
}

customElements.define("powerengine-config-card", PowerEngineConfigCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "powerengine-config-card",
  name: "PowerEngine configuration",
  description: "Configure the PowerEngine app (inputs, features, safety margins).",
});

console.info(`%c POWERENGINE-CARD %c v${CARD_VERSION} `, "background:#1f6feb;color:#fff", "");
