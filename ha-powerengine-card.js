/*
 * PowerEngine config card for Home Assistant.
 *
 * v0.0.x is a scaffold: it shows the card version and whether the PowerEngine
 * app is publishing its config sensor. Editing arrives in later releases.
 */
const CARD_VERSION = "0.0.2";
const CONFIG_SENSOR = "sensor.pe_map_config";

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
    const state = this._hass && this._hass.states[CONFIG_SENSOR];
    const status = state
      ? `App connected (config sensor state: ${state.state}).`
      : "PowerEngine app not detected yet. Install and start the app, then reload.";
    this.shadowRoot.innerHTML = `
      <ha-card header="PowerEngine configuration">
        <div class="content">
          <p>${status}</p>
          <p class="muted">Card v${CARD_VERSION} (scaffold: editing not available yet)</p>
        </div>
      </ha-card>
      <style>
        .content { padding: 0 16px 16px; }
        .muted { color: var(--secondary-text-color); font-size: 0.9em; }
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
