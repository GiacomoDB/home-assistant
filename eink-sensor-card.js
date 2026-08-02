// E-ink Sensor Card v3.0 - Black text, configurable fonts, grid options
class EinkSensorCard extends HTMLElement {
    setConfig(config) {
        if (!config.entity) {
            throw new Error('You need to define an entity');
        }
        this.config = config;

        // Create structure once
        if (!this._initialized) {
            this.innerHTML = `
        <ha-card>
          <div class="card-content"></div>
        </ha-card>
      `;
            this.content = this.querySelector("div");
            this._addStyles();
            this._initialized = true;
        }
    }

    _addStyles() {
        const valueFontSize = this.config.value_font_size || 120;
        const unitFontSize = this.config.unit_font_size || 40;
        const labelFontSize = this.config.label_font_size || 32;

        const style = document.createElement('style');
        style.textContent = `
      ha-card {
        background-color: white;
        border: none;
        box-shadow: none;
        padding: 0;
      }
      .card-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
        background-color: white;
      }
      .value-container {
        display: block;
        text-align: center;
        white-space: nowrap;
        line-height: 0.8;
      }
      .value {
        font-size: ${valueFontSize}px;
        font-weight: bold;
        color: black;
        font-family: 'Arial', 'Helvetica', sans-serif;
        display: inline-block;
        vertical-align: baseline;
      }
      .unit {
        font-size: ${unitFontSize}px;
        color: black;
        font-family: 'Arial', 'Helvetica', sans-serif;
        display: inline-block;
        vertical-align: top;
        line-height: ${unitFontSize}px;
      }
      .label {
        font-size: ${labelFontSize}px;
        color: black;
        font-family: 'Arial', 'Helvetica', sans-serif;
        margin-bottom: 20px;
        text-transform: uppercase;
      }
    `;
        this.appendChild(style);
    }

    set hass(hass) {
        if (!this.content) return;

        const entityId = this.config.entity;
        const state = hass.states[entityId];

        if (!state) {
            this.content.innerHTML = `
        <div class="label">ERROR</div>
        <div class="value-container">
          <span class="value">--</span>
        </div>
      `;
            return;
        }

        let value = state.state;
        if (!isNaN(parseFloat(value))) {
            value = parseFloat(value).toFixed(1);
        }
        const unit = this.config.unit || state.attributes.unit_of_measurement || '';
        const label = this.config.name || state.attributes.friendly_name || '';

        this.content.innerHTML = `
      ${label ? `<div class="label">${label}</div>` : ''}
      <div class="value-container">
        <span class="value">${value}</span>${unit ? `<span class="unit">${unit}</span>` : ''}
      </div>
    `;
    }

    getCardSize() {
        return 3;
    }

    getGridOptions() {
        const options = this.config.grid_options || {};
        return {
            columns: options.columns || 12,
            rows: options.rows || 3,
            min_rows: options.min_rows || 2,
            max_rows: options.max_rows,
            min_columns: options.min_columns || 1,
            max_columns: options.max_columns
        };
    }
}

customElements.define('eink-sensor-card', EinkSensorCard);