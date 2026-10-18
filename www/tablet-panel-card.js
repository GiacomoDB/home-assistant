// tablet-panel-card: the whole screen of the wall tablet (Galaxy Tab A7,
// portrait, ~800×1280 CSS px), as one card on a panel view.
//
// One card instead of a stack of stock cards because the panel is read from
// across the room: a fixed layout, big numbers and one look, which stock
// cards plus card-mod can only approximate. Every entity comes from the
// card's config in dashboards/tablet.yaml (keys ending in `_entity`, which
// `ha.py deploy --dry-run` checks exist).
//
// Controls call the same helpers as the Heating view, so the panel never
// talks to tado directly:
//   −/+          input_number.set_value on the manual target, which starts
//                a hold (packages/heating.yaml, heating_hold). Taps are
//                gathered for 1.2 s and sent as one change, so tapping
//                +++ wakes the thermostat once, not three times.
//   Boost        timer.start / timer.cancel on the boost timer
//   Back to schedule   the heating_resume script
//   Lights       homeassistant.toggle
//
// Deployed by CI: HA pulls www/*.js into /config/www/repo/ and `ha.py
// deploy` points the dashboard resource at it with a ?v=<hash> that changes
// with the file, so the tablet loads a new version on its next reload.

const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap';

// `press` is the brightness of a pressed button: darker on light, lighter on dark.
const DAY = { ground: '#EEF1F4', tile: '#FFFFFF', raised: '#F3F5F7', line: '#DDE2E7',
  ink: '#1A1F26', muted: '#5C6773', heat: '#C2571A', water: '#2563B8',
  alertBg: '#FFF4EE', alertFg: '#9A3F0E', alertLine: '#F2C9B3', blockOn: '#F6DCC8', press: 0.92 };
// Dark and dim, for the hours a white screen would light up a dark room.
const NIGHT = { ground: '#050607', tile: '#0C0F11', raised: '#13171A', line: '#1A1F23',
  ink: '#9AA3AA', muted: '#6B757D', heat: '#B07A3E', water: '#4C7FA6',
  alertBg: '#170F0C', alertFg: '#B9806C', alertLine: '#2E1D16', blockOn: '#2A2016', press: 1.35 };

const BOOST_TARGET = 25;
const STEP_DELAY_MS = 1200;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const ICON = '<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">'
  + '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"></circle></svg>';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

const hhmm = (date) => date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

// "08:00:00" → minutes since midnight; "24:00:00" is the end of the day.
const minutesOf = (text) => {
  const [h, m, s] = String(text).split(':').map(Number);
  return h * 60 + (m || 0) + (s || 0) / 60;
};

class TabletPanelCard extends HTMLElement {
  setConfig(config) {
    if (!config.heating || !config.rooms || !config.tiles) {
      throw new Error('tablet-panel-card needs heating, rooms and tiles');
    }
    this._config = config;
    this._pending = null; // a target being stepped, not yet sent
    this._schedule = null; // today's blocks from schedule.get_schedule
    this._scheduleRetry = 0; // after a failed read, when to try again
    this._lastKey = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.addEventListener('click', (event) => this._onClick(event));
    }
  }

  set hass(hass) {
    this._hass = hass;
    // HA hands every card a new hass object on any state change in the whole
    // house; redraw only when something this panel shows has changed.
    const key = this._watched().map((id) => {
      const s = hass.states[id];
      return s ? `${s.state}|${s.last_updated}` : '-';
    }).join(';');
    if (key !== this._lastKey) {
      this._lastKey = key;
      this._render();
    }
    if (!this._schedule && Date.now() > this._scheduleRetry) this._loadSchedule();
  }

  connectedCallback() {
    loadFonts();
    // The clock, "x min ago" texts and the schedule marker move on their own.
    this._tick = setInterval(() => this._render(), 15000);
    // The schedule only changes on a deploy; refetch hourly, and at midnight
    // via the day check in _render.
    this._refetch = setInterval(() => { this._schedule = null; this._loadSchedule(); }, 3600000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    clearInterval(this._refetch);
  }

  getCardSize() {
    return 20;
  }

  _watched() {
    const ids = [];
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if ((key === 'entity' || key.endsWith('_entity')) && typeof value === 'string') ids.push(value);
          else walk(value);
        }
      }
    };
    walk(this._config);
    return ids;
  }

  _state(id) {
    return id ? this._hass.states[id] : undefined;
  }

  _value(id) {
    const s = this._state(id);
    return s && !['unavailable', 'unknown'].includes(s.state) ? s.state : null;
  }

  async _loadSchedule() {
    const id = this._config.heating.schedule_entity;
    if (!this._hass || this._loadingSchedule) return;
    this._loadingSchedule = true;
    try {
      const result = await this._hass.callWS({
        type: 'call_service', domain: 'schedule', service: 'get_schedule',
        target: { entity_id: id }, return_response: true,
      });
      this._schedule = { week: result.response[id], day: new Date().getDay() };
      this._render();
    } catch (err) {
      // Without it the bar is simply left out; the target still shows.
      console.warn('tablet-panel-card: could not read the heating schedule', err);
      this._scheduleRetry = Date.now() + 300000;
    } finally {
      this._loadingSchedule = false;
    }
  }

  _onClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const h = this._config.heating;
    const action = button.dataset.action;
    if (action === 'step') this._step(parseFloat(button.dataset.delta));
    else if (action === 'boost') {
      const active = this._state(h.boost_entity)?.state === 'active';
      this._hass.callService('timer', active ? 'cancel' : 'start', { entity_id: h.boost_entity });
    } else if (action === 'resume') {
      this._hass.callService('script', 'turn_on', { entity_id: h.resume_entity });
    } else if (action === 'toggle') {
      this._hass.callService('homeassistant', 'toggle', { entity_id: button.dataset.entity });
    }
  }

  _step(delta) {
    const h = this._config.heating;
    const input = this._state(h.manual_entity);
    if (!input) return;
    const min = num(input.attributes.min) ?? 14;
    const max = num(input.attributes.max) ?? 24;
    const from = this._pending ?? num(this._value(h.target_entity)) ?? num(input.state);
    if (from === null) return;
    this._pending = Math.min(max, Math.max(min, Math.round((from + delta) * 2) / 2));
    this._render();
    clearTimeout(this._stepTimer);
    this._stepTimer = setTimeout(async () => {
      const value = this._pending;
      try {
        await this._hass.callService('input_number', 'set_value', { entity_id: h.manual_entity, value });
      } finally {
        // Keep showing it until the target sensor catches up, so the number
        // doesn't flick back for the second the hold takes to apply.
        setTimeout(() => { this._pending = null; this._render(); }, 4000);
      }
    }, STEP_DELAY_MS);
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (this._schedule && this._schedule.day !== new Date().getDay()) {
      this._schedule = null;
      this._loadSchedule();
    }
    const t = this._isNight() ? NIGHT : DAY;
    this.shadowRoot.innerHTML = `<style>${styles(t)}</style>
      <div class="panel">
        ${this._header()}
        ${this._alerts()}
        ${this._heating(t)}
        ${this._rooms()}
        ${this._tiles()}
        ${this._lights()}
      </div>`;
  }

  _isNight() {
    const night = this._config.night;
    if (!night) return false;
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const from = minutesOf(night.from);
    const to = minutesOf(night.to);
    return from > to ? m >= from || m < to : m >= from && m < to;
  }

  _header() {
    const now = new Date();
    const date = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const wx = this._state(this._config.weather_entity);
    const temp = wx ? num(wx.attributes.temperature) : null;
    const condition = wx ? wx.state.replace('partlycloudy', 'partly cloudy').replace(/-/g, ' ') : '';
    return `<header class="top">
      <div class="clock">${hhmm(now)}</div>
      <div class="when">
        <div>${esc(date)}</div>
        ${temp === null ? '' : `<div><span class="mono big">${temp.toFixed(1)}°</span> ${esc(condition)}</div>`}
      </div>
    </header>`;
  }

  _alerts() {
    const offline = (this._config.lights || [])
      .filter((l) => this._state(l.entity)?.state === 'unavailable')
      .map((l) => l.name);
    // Every leak sensor in the house, not a list: a new one is covered at once.
    const leaks = Object.values(this._hass.states)
      .filter((s) => s.attributes.device_class === 'moisture' && s.state === 'on')
      .map((s) => s.attributes.friendly_name || s.entity_id);
    const items = [];
    if (leaks.length) items.push([`Water leak`, leaks.join(', ')]);
    // The router: 'off' is the line down; no answer for 5 min is the router itself.
    const wan = this._state(this._config.internet_entity);
    if (this._config.internet_entity) {
      const since = wan ? new Date(wan.last_changed) : null;
      const at = since ? `since ${since.toDateString() === new Date().toDateString() ? hhmm(since) : since.toLocaleDateString('en-GB', { weekday: 'short' })}` : '';
      if (wan?.state === 'off') items.push(['Internet down', at]);
      else if (!wan || (wan.state === 'unavailable' && Date.now() - since.getTime() > 5 * 60000)) items.push(['Router not answering', at]);
    }
    if (offline.length) {
      items.push([`${offline.length} light${offline.length > 1 ? 's' : ''} offline`, offline.join(', ')]);
    }
    if (!items.length) return '';
    return items.map(([title, detail]) => `<div class="alert" role="status">
      ${ICON}<strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`).join('');
  }

  _heating(t) {
    const h = this._config.heating;
    const boost = this._state(h.boost_entity);
    const boosting = boost?.state === 'active';
    const nowTs = Date.now() / 1000 + 1;
    const holdTs = num(this._state(h.hold_entity)?.attributes.timestamp) ?? 0;
    const pauseTs = num(this._state(h.pause_entity)?.attributes.timestamp) ?? 0;
    const schedule = this._state(h.schedule_entity);
    const setback = num(this._value(h.setback_entity));
    const desired = num(this._value(h.target_entity));
    const shown = this._pending ?? (boosting ? BOOST_TARGET : desired);
    const nextEvent = schedule?.attributes.next_event ? hhmm(new Date(schedule.attributes.next_event)) : null;

    let mode;
    if (this._pending !== null) mode = 'Setting…';
    else if (boosting) mode = `Boost until ${hhmm(new Date(boost.attributes.finishes_at))}`;
    else if (pauseTs > nowTs) mode = `Paused by tado until ${hhmm(new Date(pauseTs * 1000))}`;
    else if (holdTs > nowTs) mode = `Held until ${hhmm(new Date(holdTs * 1000))}`;
    else mode = `${schedule?.state === 'on' ? 'Schedule' : 'Setback'}${nextEvent ? ` until ${nextEvent}` : ''}`;
    if (this._state(h.live_entity)?.state === 'off') mode += ' · shadow mode';

    const scheduled = schedule?.state === 'on' ? num(schedule.attributes.target) : setback;
    const action = this._state(h.climate_entity)?.attributes.hvac_action;
    const boiler = action === 'heating' ? 'Boiler heating' : action ? `Boiler ${action}` : '';
    const overridden = holdTs > nowTs || pauseTs > nowTs;

    return `<section class="tile heating" aria-label="Heating">
      <div class="heat-main">
        <div class="row"><span class="label">Heating</span><span class="muted">${esc(boiler)}</span></div>
        <div class="stepper">
          <button class="round" data-action="step" data-delta="-0.5" aria-label="Lower target by half a degree">−</button>
          <div class="target">
            <div class="mono target-value ${this._pending !== null ? 'pending' : ''}">${shown === null ? '—' : `${shown.toFixed(1)}°`}</div>
            <div class="muted">${esc(mode)}</div>
          </div>
          <button class="round" data-action="step" data-delta="0.5" aria-label="Raise target by half a degree">+</button>
        </div>
        ${this._scheduleBar(setback)}
      </div>
      <div class="heat-side">
        <div class="row"><span class="muted">Bedroom</span><span class="mono">${fmt(this._value(h.reference_entity))}</span></div>
        <div class="row"><span class="muted">Schedule</span><span class="mono">${scheduled === null ? '—' : `${scheduled.toFixed(1)}°`}</span></div>
        <button class="wide" data-action="boost">${boosting ? 'Stop boost' : 'Boost 15 min'}</button>
        <button class="wide" data-action="resume" ${overridden ? '' : 'disabled'}>Back to schedule</button>
      </div>
    </section>`;
  }

  _scheduleBar(setback) {
    const week = this._schedule?.week;
    if (!week) return '';
    const blocks = week[WEEKDAYS[new Date().getDay()]] || [];
    // Gaps between blocks run at the setback temperature.
    const parts = [];
    let at = 0;
    for (const b of blocks) {
      const from = minutesOf(b.from);
      const to = minutesOf(b.to);
      // A gap under a minute is a block ending at 23:59:59, not a setback.
      if (from - at >= 1) parts.push({ from: at, to: from, target: setback, on: false });
      parts.push({ from, to, target: num(b.data?.target), on: true });
      at = to;
    }
    if (1440 - at >= 1) parts.push({ from: at, to: 1440, target: setback, on: false });
    const now = new Date();
    const marker = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
    const peak = Math.max(...parts.map((p) => p.target ?? 0));
    return `<div class="bar" aria-label="Today's schedule">
      ${parts.map((p) => {
        const width = ((p.to - p.from) / 1440) * 100;
        const label = width > 7 && p.target !== null ? `${p.target}°` : '';
        const warm = p.on && p.target === peak ? 'warm' : '';
        return `<div class="block ${warm}" style="width:${width}%">${label}</div>`;
      }).join('')}
      <div class="now" style="left:${marker}%"></div>
    </div>`;
  }

  _rooms() {
    return `<section class="rooms" aria-label="Rooms">
      ${this._config.rooms.map((r) => `<div class="tile room">
        <div class="muted name">${esc(r.name)}</div>
        <div class="row base">
          <span class="mono room-temp">${fmt(this._value(r.temperature_entity))}</span>
          <span class="mono room-hum">${fmtPct(this._value(r.humidity_entity))}</span>
        </div>
      </div>`).join('')}
    </section>`;
  }

  _tiles() {
    const e = this._config.tiles;
    const v = (key) => this._value(e[key]);
    const tiles = [];

    const level = num(v('fountain_level_entity'));
    const today = num(v('fountain_today_entity'));
    const yesterday = num(v('fountain_yesterday_entity'));
    const now = new Date();
    const dayFraction = (now.getHours() * 3600 + now.getMinutes() * 60) / 86400;
    tiles.push(['Fountain', level === null ? '—' : `${Math.min(level, 100).toFixed(0)}%`,
      [today === null ? '' : `${today.toFixed(0)} mL today`,
        yesterday === null ? '' : `${(yesterday * dayFraction).toFixed(0)} by now yday`]]);

    const visit = this._state(e.litter_occupancy_entity);
    tiles.push(['Litter box', v('litter_visits_entity') ?? '—',
      ['visits today', visit ? (visit.state === 'on' ? 'in use now' : `last ${ago(visit.last_changed)}`) : '']]);

    const cost = num(v('energy_cost_entity'));
    const used = num(v('energy_usage_entity'));
    const rate = this._state(e.energy_rate_entity);
    const rateValue = num(this._value(e.energy_rate_entity));
    let rateText = 'no rate';
    if (rateValue !== null) {
      // GBP under £1 reads better in pence, as tariffs are quoted.
      rateText = rate.attributes.unit_of_measurement?.startsWith('GBP') && rateValue < 1
        ? `${(rateValue * 100).toFixed(1)}p per kWh` : `${rateValue} ${rate.attributes.unit_of_measurement || ''}`;
    }
    tiles.push(['Energy', cost === null ? '—' : `£${cost.toFixed(2)}`,
      [used === null ? '' : `${used.toFixed(2)} kWh today`, rateText]]);

    const co2 = num(v('co2_entity'));
    const pm = v('pm25_entity');
    tiles.push(['Air', co2 === null ? '—' : co2.toFixed(0), ['ppm CO₂', pm === null ? '' : `PM2.5 ${pm}`]]);

    for (const [label, status, last] of [['Washer', 'washer_status_entity', 'washer_last_entity'],
      ['Dryer', 'dryer_status_entity', 'dryer_last_entity']]) {
      const [head, ...rest] = String(v(status) ?? 'Offline').split(' · ');
      tiles.push([label, head, [rest.join(' · '), v(last) ?? '']]);
    }

    const battery = num(v('vacuum_battery_entity'));
    const [vacHead] = String(v('vacuum_status_entity') ?? 'Offline').split(' · ');
    tiles.push(['Vacuum', battery === null ? '—' : `${battery.toFixed(0)}%`,
      [vacHead, v('vacuum_last_entity') ?? '']]);

    const ratio = num(v('dns_blocked_ratio_entity'));
    const queries = num(v('dns_queries_entity'));
    tiles.push(['Network', ratio === null ? '—' : `${ratio.toFixed(1)}%`,
      ['blocked of', queries === null ? '' : `${queries.toLocaleString('en-GB')} queries`]]);

    return `<section class="tiles" aria-label="House">
      ${tiles.map(([label, value, lines]) => `<div class="tile small">
        <div class="label">${esc(label)}</div>
        <div class="mono tile-value">${esc(value)}</div>
        <div class="muted lines">${lines.filter(Boolean).map(esc).join('<br>')}</div>
      </div>`).join('')}
    </section>`;
  }

  _lights() {
    const lights = this._config.lights || [];
    if (!lights.length) return '';
    return `<section class="lights" aria-labelledby="lights-h">
      <h2 id="lights-h" class="label">Lights</h2>
      <div class="light-grid">
        ${lights.map((l) => {
          const s = this._state(l.entity);
          const offline = !s || s.state === 'unavailable';
          const on = s?.state === 'on';
          const state = offline ? 'Offline' : on ? 'On' : 'Off';
          return `<button class="light ${offline ? 'offline' : ''} ${on ? 'on' : ''}" data-action="toggle"
            data-entity="${esc(l.entity)}" ${offline ? 'disabled' : ''} aria-pressed="${on}">
            ${ICON}<span class="light-name">${esc(l.name)}</span><span>${state}</span></button>`;
        }).join('')}
      </div>
    </section>`;
  }
}

const fmt = (value) => {
  const n = num(value);
  return n === null ? '—' : `${n.toFixed(1)}°`;
};
const fmtPct = (value) => {
  const n = num(value);
  return n === null ? '' : `${n.toFixed(0)}%`;
};

function loadFonts() {
  if (document.querySelector('link[data-tablet-panel-fonts]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONTS;
  link.dataset.tabletPanelFonts = '';
  document.head.appendChild(link);
}

function styles(t) {
  return `
  :host { display: block; }
  * { box-sizing: border-box; }
  .panel {
    height: 100vh; height: 100dvh; max-width: 900px; margin: 0 auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px; overflow: hidden;
    background: ${t.ground}; color: ${t.ink};
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
  }
  .mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-weight: 500; }
  .muted { color: ${t.muted}; }
  .label { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: ${t.muted}; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .row.base { align-items: baseline; }
  .tile { background: ${t.tile}; border: 1px solid ${t.line}; border-radius: 14px; }
  button { font: 500 17px 'IBM Plex Sans', system-ui, sans-serif; color: ${t.ink}; cursor: pointer;
    background: ${t.raised}; border: 1px solid ${t.line}; -webkit-tap-highlight-color: transparent; }
  button:active { filter: brightness(${t.press}); }
  button:disabled { opacity: .4; cursor: default; }

  .top { display: flex; justify-content: space-between; align-items: flex-end; padding: 0 4px; }
  .clock { font-family: 'IBM Plex Mono', monospace; font-size: 120px; font-weight: 500; line-height: .9; letter-spacing: -5px; }
  .when { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; padding-bottom: 6px; font-size: 20px; color: ${t.muted}; }
  .when .big { font-size: 30px; color: ${t.ink}; }

  .alert { display: flex; align-items: center; gap: 14px; min-height: 56px; padding: 0 18px; border-radius: 12px;
    background: ${t.alertBg}; color: ${t.alertFg}; font-size: 16px; }
  .alert strong { font-size: 18px; white-space: nowrap; }
  .alert span { opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .heating { border-radius: 16px; padding: 18px 20px; display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 18px 24px; align-items: center; }
  .heat-main, .heat-side { display: flex; flex-direction: column; gap: 12px; }
  .heat-main .muted, .heat-side .row { font-size: 16px; }
  .stepper { display: flex; align-items: center; justify-content: space-between; }
  .round { width: 64px; height: 64px; border-radius: 32px; font-size: 32px; }
  .target { display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
  .target .muted { font-size: 15px; }
  .target-value { font-size: 72px; line-height: 1; color: ${t.heat}; }
  .target-value.pending { opacity: .6; }
  .wide { min-height: 56px; border-radius: 12px; }
  .bar { position: relative; display: flex; height: 24px; border-radius: 6px; overflow: hidden;
    font: 12px 'IBM Plex Mono', monospace; color: ${t.muted}; }
  .block { background: ${t.raised}; display: flex; align-items: center; padding-left: 8px; border-right: 1px solid ${t.ground}; }
  .block.warm { background: ${t.blockOn}; color: ${t.ink}; }
  .now { position: absolute; top: 0; bottom: 0; width: 2px; background: ${t.ink}; }

  .rooms { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: minmax(120px, 1fr); gap: 12px; flex: 1 1 252px; min-height: 0; }
  .room { padding: 14px 18px; display: flex; flex-direction: column; justify-content: space-between; }
  .room .name { font-size: 17px; }
  .room-temp { font-size: 48px; line-height: 1; color: ${t.heat}; }
  .room-hum { font-size: 20px; color: ${t.water}; }

  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: minmax(130px, 1fr); gap: 12px; flex: 1 1 272px; min-height: 0; }
  .small { padding: 14px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .small .label { font-size: 12px; }
  .tile-value { font-size: 30px; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lines { font-size: 14px; line-height: 1.35; overflow: hidden; }

  .lights { display: flex; flex-direction: column; gap: 8px; }
  .lights .label { padding: 0 4px; }
  .light-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .light { min-height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 16px; border-radius: 12px;
    background: ${t.tile}; text-align: left; font-size: 16px; }
  .light span:last-child { font-size: 14px; color: ${t.muted}; }
  .light.on { border-color: ${t.heat}; }
  .light.on span:last-child { color: ${t.heat}; }
  .light.offline, .light.offline:disabled { opacity: 1; color: ${t.alertFg}; border-color: ${t.alertLine}; }
  .light.offline span:last-child { color: ${t.alertFg}; }
  .light-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
}

customElements.define('tablet-panel-card', TabletPanelCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'tablet-panel-card',
  name: 'Tablet panel',
  description: 'The wall tablet: clock, heating, rooms, house and lights on one screen.',
});
