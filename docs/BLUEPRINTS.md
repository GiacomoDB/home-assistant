# Blueprints

For the IKEA BILRESA scroll-wheel remote. The files are at the repo root;
each button below imports one into your HA. They're installed by hand, not by
the deploy. The heating is controlled from the dashboard, so the two
thermostat ones are currently unused.

## Scroll Wheel – Light Brightness Control

Controls light brightness with clockwise/counter-clockwise rotation.

<a href="https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FGiacomoDB%2Fhome-assistant%2Fblob%2Fmain%2Fikea-billresa-scrollwheel.yaml" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/blueprint_import.svg" alt="Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled." /></a>

## Scroll Wheel – Thermostat Control

Controls Tado thermostat temperature with clockwise/counter-clockwise rotation.
Pointed at `climate.heating`, a turn counts as a manual change and pauses the
heating schedule until the next block.

<a href="https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FGiacomoDB%2Fhome-assistant%2Fblob%2Fmain%2Fikea-billresa-thermostat.yaml" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/blueprint_import.svg" alt="Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled." /></a>

## Center Button – Tado Thermostat Boost (Once Per Day)

Boosts the heating from the center button, limited to one boost per day. It
starts `timer.heating_boost` (15 min by default) from `packages/heating.yaml`,
and the heating controller sends 25 °C to tado over HomeKit while it runs. No
cloud call, so no tado API quota.

**Prerequisites:** `packages/heating.yaml` installed; an `input_boolean` helper to track daily usage, and a separate automation to reset it at midnight. Automations made from the old version (two thermostat inputs) need re-saving with the new inputs.

<a href="https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FGiacomoDB%2Fhome-assistant%2Fblob%2Fmain%2Fikea-billresa-thermostat-boost.yaml" target="_blank" rel="noreferrer noopener"><img src="https://my.home-assistant.io/badges/blueprint_import.svg" alt="Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled." /></a>
