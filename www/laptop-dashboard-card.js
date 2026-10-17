// laptop-dashboard-card: every view of the laptop dashboard, one card per
// panel view (`page: home`, `heating`, ...). dashboards/laptop.yaml gives every
// view the same config through a YAML anchor, so a page can link to any other.
//
// One card instead of stock cards for the same reason as the tablet panel: one
// layout and one look across seven pages, with charts drawn from HA's history
// and long-term statistics (read with the logged-in user's own connection, so
// no extra token). Every entity comes from the config, under keys ending in
// `_entity`, which `ha.py deploy --dry-run` checks exist.
//
// Controls call the same helpers as the other dashboards:
//   heating −/+     input_number.set_value on the manual target (a hold until
//                   the next block); taps gathered for 1.2 s, sent once
//   Boost / Back to schedule   timer.start|cancel, the heating_resume script
//   HA controls tado           toggles the controller's live switch
//   lights, switches           homeassistant.toggle; brightness light.turn_on
//   vacuum                     vacuum.start / vacuum.return_to_base
//   unit rate                  input_number.set_value (packages/energy.yaml)
//
// The page's own sidebar navigates inside HA, keeping the query string, so
// /dashboard-laptop/home?kiosk stays in kiosk mode from page to page.

const FONTS = 'https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700&display=swap';

const C = {
  ground: '#F3F5F6', card: '#FFFFFF', ink: '#15191C', muted: '#5B6670', line: '#E6E9EC',
  control: '#D5DADF', faint: '#EEF1F3', accent: '#0B6E78', accentDark: '#084F56', accentSoft: '#DDEBEC',
  heat: '#B4530F', water: '#2563B8', grey: '#9AA3AB', alertBg: '#FFF4EE', alertFg: '#9A3F0E',
  alertLine: '#F2C9B3', goodBg: '#E2F2E6', goodFg: '#1D5E2E',
};
const ROOM_COLOURS = ['#B4530F', '#2563B8', '#0B6E78', '#8A6FB5', '#C0882B', '#5B8C3A'];

const PAGES = [['home', 'Home'], ['heating', 'Heating'], ['cat', 'Cat'], ['energy', 'Energy'],
  ['appliances', 'Appliances'], ['network', 'Network'], ['lights', 'Lights']];

const BOOST_TARGET = 25;
const STEP_DELAY_MS = 1200;
const HISTORY_TTL = 5 * 60000;
const STATS_TTL = 30 * 60000;
const DAYS = 31;
const MONTHS = 11;
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
const deg = (value) => (num(value) === null ? '—' : `${num(value).toFixed(1)}°`);
const kwh = (value) => (value >= 10 ? value.toFixed(1) : value.toFixed(2).replace(/0$/, ''));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
const monthKey = (date) => `${date.getFullYear()}-${date.getMonth()}`;

function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

// "11:33" today, "Thu 15 Oct 15:11" before.
function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (dayKey(date) === dayKey(new Date())) return hhmm(date);
  return `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(date)}`;
}

// "08:00:00" → minutes since midnight; "24:00:00" is the end of the day.
const minutesOf = (text) => {
  const [h, m, s] = String(text).split(':').map(Number);
  return h * 60 + (m || 0) + (s || 0) / 60;
};

class LaptopDashboardCard extends HTMLElement {
  setConfig(config) {
    if (!config.page || !PAGES.some(([key]) => key === config.page)) {
      throw new Error(`laptop-dashboard-card needs page: one of ${PAGES.map(([key]) => key).join(', ')}`);
    }
    this._config = config;
    this._pending = null; // a heating target being stepped, not yet sent
    this._schedule = null; // the week from schedule.get_schedule
    this._scheduleRetry = 0;
    this._data = {}; // fetched history and statistics, by name
    this._lastKey = '';
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.addEventListener('click', (event) => this._onClick(event));
      this.shadowRoot.addEventListener('change', (event) => this._onChange(event));
      // A redraw while typing would throw the text away; catch up on leaving.
      this.shadowRoot.addEventListener('focusout', () => setTimeout(() => this._render(), 0));
    }
  }

  set hass(hass) {
    this._hass = hass;
    // HA hands every card a new hass object on any state change in the whole
    // house; redraw only when something this dashboard shows has changed.
    const key = this._watched().map((id) => {
      const s = hass.states[id];
      return s ? `${s.state}|${s.last_updated}` : '-';
    }).join(';');
    if (key !== this._lastKey) {
      this._lastKey = key;
      this._render();
    }
    this._load();
  }

  connectedCallback() {
    loadFonts();
    // Clocks, "x min ago" texts and the schedule marker move on their own;
    // charts refresh when their data is older than its TTL.
    this._tick = setInterval(() => { this._render(); this._load(); }, 60000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
  }

  getCardSize() {
    return 30;
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

  // ───────────────────────────── data ─────────────────────────────

  // What the current page draws, as named history and statistics requests.
  _requests() {
    const c = this._config;
    const h = c.heating || {};
    const page = c.page;
    const machines = c.appliances?.machines || [];
    const devices = c.energy?.devices || [];
    const r = [];
    if (page === 'home') {
      r.push({ name: 'rooms24', kind: 'history', hours: 24,
        ids: [...(c.rooms || []).map((room) => room.temperature_entity), h.target_entity] });
      r.push({ name: 'month', kind: 'stats', period: 'month', months: 1, types: ['change'],
        ids: devices.map((d) => d.energy_entity) });
    }
    if (page === 'heating') {
      r.push({ name: 'heat24', kind: 'history', hours: 24,
        ids: [h.target_entity, h.reference_entity, h.setpoint_entity] });
    }
    if (page === 'cat') {
      const cat = c.cat || {};
      r.push({ name: 'fountain48', kind: 'history', hours: 48, ids: [cat.fountain_today_entity] });
      r.push({ name: 'catDays', kind: 'stats', period: 'day', days: DAYS, types: ['change', 'max'],
        ids: [cat.fountain_today_entity, cat.sessions_today_entity, cat.litter_visits_entity] });
    }
    if (page === 'energy' || page === 'appliances') {
      const ids = [...new Set([...devices, ...machines].map((d) => d.energy_entity))];
      r.push({ name: 'energyDays', kind: 'stats', period: 'day', days: DAYS, types: ['change'], ids });
      r.push({ name: 'energyMonths', kind: 'stats', period: 'month', months: MONTHS, types: ['change'],
        ids: [...ids, ...machines.map((m) => m.cycles_entity)] });
    }
    if (page === 'network') {
      const n = c.network || {};
      r.push({ name: 'dns24', kind: 'history', hours: 24, ids: [n.queries_entity, n.blocked_entity] });
    }
    return r.map((req) => ({ ...req, ids: req.ids.filter(Boolean) })).filter((req) => req.ids.length);
  }

  _load() {
    if (!this._hass) return;
    if (this._config.page === 'heating' && !this._schedule && Date.now() > this._scheduleRetry) {
      this._loadSchedule();
    }
    for (const req of this._requests()) {
      const have = this._data[req.name];
      const ttl = req.kind === 'history' ? HISTORY_TTL : STATS_TTL;
      if (have && (have.loading || Date.now() - have.at < ttl)) continue;
      this._data[req.name] = { ...have, loading: true, at: Date.now() };
      this._fetch(req).then(
        (value) => { this._data[req.name] = { value, at: Date.now() }; },
        (err) => {
          console.warn(`laptop-dashboard-card: could not load ${req.name}`, err);
          this._data[req.name] = { ...this._data[req.name], loading: false, failed: true, at: Date.now() };
        },
      ).then(() => this._render());
    }
  }

  async _fetch(req) {
    const now = new Date();
    if (req.kind === 'history') {
      const start = new Date(now.getTime() - req.hours * 3600000);
      const result = await this._hass.callWS({
        type: 'history/history_during_period', start_time: start.toISOString(), end_time: now.toISOString(),
        entity_ids: req.ids, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      // { id: [[ms, number|null], ...] }
      const out = {};
      for (const id of req.ids) {
        out[id] = (result[id] || []).map((p) => [(p.lu ?? p.lc) * 1000, num(p.s)]);
      }
      return { from: start.getTime(), to: now.getTime(), series: out };
    }
    const start = req.period === 'day'
      ? new Date(startOfDay(now).getTime() - (req.days - 1) * 86400000)
      : new Date(now.getFullYear(), now.getMonth() - (req.months - 1), 1);
    const result = await this._hass.callWS({
      type: 'recorder/statistics_during_period', start_time: start.toISOString(),
      statistic_ids: req.ids, period: req.period, types: req.types,
    });
    // One slot per day or month, oldest first; a missing slot is 0.
    const slots = [];
    if (req.period === 'day') {
      for (let i = 0; i < req.days; i += 1) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        slots.push({ key: dayKey(d), date: d });
      }
    } else {
      for (let i = 0; i < req.months; i += 1) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        slots.push({ key: monthKey(d), date: d });
      }
    }
    const keyOf = req.period === 'day' ? dayKey : monthKey;
    const out = {};
    for (const id of req.ids) {
      const byKey = {};
      for (const p of result[id] || []) byKey[keyOf(new Date(p.start))] = p;
      out[id] = Object.fromEntries(req.types.map((type) => [type,
        slots.map((s) => Math.max(num(byKey[s.key]?.[type]) ?? 0, 0))]));
    }
    return { dates: slots.map((s) => s.date), series: out };
  }

  async _loadSchedule() {
    const id = this._config.heating?.schedule_entity;
    if (!id || this._loadingSchedule) return;
    this._loadingSchedule = true;
    try {
      const result = await this._hass.callWS({
        type: 'call_service', domain: 'schedule', service: 'get_schedule',
        target: { entity_id: id }, return_response: true,
      });
      this._schedule = { week: result.response[id], at: Date.now() };
      this._render();
    } catch (err) {
      console.warn('laptop-dashboard-card: could not read the heating schedule', err);
      this._scheduleRetry = Date.now() + 300000;
    } finally {
      this._loadingSchedule = false;
    }
  }

  // ─────────────────────────── controls ───────────────────────────

  _onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const h = this._config.heating || {};
    const action = el.dataset.action;
    if (action === 'nav') {
      event.preventDefault();
      navigate(el.dataset.page);
    } else if (action === 'step') this._step(parseFloat(el.dataset.delta));
    else if (action === 'boost') {
      const active = this._state(h.boost_entity)?.state === 'active';
      this._hass.callService('timer', active ? 'cancel' : 'start', { entity_id: h.boost_entity });
    } else if (action === 'resume') {
      this._hass.callService('script', 'turn_on', { entity_id: h.resume_entity });
    } else if (action === 'toggle') {
      this._hass.callService('homeassistant', 'toggle', { entity_id: el.dataset.entity });
    } else if (action === 'all-off') {
      const on = (this._config.lights || []).map((l) => l.entity).filter((id) => this._state(id)?.state === 'on');
      if (on.length) this._hass.callService('homeassistant', 'turn_off', { entity_id: on });
    } else if (action === 'vacuum') {
      this._hass.callService('vacuum', el.dataset.service, { entity_id: el.dataset.entity });
    }
  }

  _onChange(event) {
    const el = event.target;
    if (el.dataset.change === 'rate') {
      const value = num(el.value);
      if (value !== null) {
        this._hass.callService('input_number', 'set_value', { entity_id: this._config.energy.rate_entity, value });
      }
    } else if (el.dataset.change === 'brightness') {
      this._hass.callService('light', 'turn_on', { entity_id: el.dataset.entity, brightness_pct: Number(el.value) });
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
        // Keep showing it until the target sensor catches up.
        setTimeout(() => { this._pending = null; this._render(); }, 4000);
      }
    }, STEP_DELAY_MS);
  }

  // ─────────────────────────── layout ────────────────────────────

  _render() {
    if (!this._hass || !this._config) return;
    if (this.shadowRoot.activeElement?.matches('input')) return;
    if (this._schedule && Date.now() - this._schedule.at > 3600000) {
      this._schedule = null; // the schedule only changes on a deploy; reread hourly
    }
    const page = this._config.page;
    const [title, lede, aside, body] = this[`_${page}`]();
    this.shadowRoot.innerHTML = `<style>${STYLES}</style>
      <div class="page"><div class="wrap">
        <nav aria-label="Views">
          <div class="brand">Home Assistant</div>
          ${PAGES.map(([key, name]) => `<a href="${esc(pageUrl(key))}" data-action="nav" data-page="${key}"
            class="${key === page ? 'here' : ''}" ${key === page ? 'aria-current="page"' : ''}>${ICON}<span>${name}</span></a>`).join('')}
        </nav>
        <main>
          <header class="head">
            <div class="titles"><h1>${esc(title)}</h1><div class="lede">${lede}</div></div>
            ${aside || ''}
          </header>
          ${body}
        </main>
      </div></div>`;
  }

  _link(page, text) {
    return `<a class="more" href="${esc(pageUrl(page))}" data-action="nav" data-page="${page}">${esc(text)} ›</a>`;
  }

  _chartState(name) {
    const d = this._data[name];
    if (d?.value) return null;
    return `<div class="chart-empty">${d?.failed ? 'Couldn’t load the history.' : 'Loading…'}</div>`;
  }

  // ─────────────────────────── heating ───────────────────────────

  _heatingState() {
    const h = this._config.heating;
    const boost = this._state(h.boost_entity);
    const boosting = boost?.state === 'active';
    const nowTs = Date.now() / 1000 + 1;
    const holdTs = num(this._state(h.hold_entity)?.attributes.timestamp) ?? 0;
    const pauseTs = num(this._state(h.pause_entity)?.attributes.timestamp) ?? 0;
    const schedule = this._state(h.schedule_entity);
    const setback = num(this._value(h.setback_entity));
    const desired = num(this._value(h.target_entity));
    const nextEvent = schedule?.attributes.next_event ? hhmm(new Date(schedule.attributes.next_event)) : null;
    let mode;
    if (this._pending !== null) mode = 'Setting…';
    else if (boosting) mode = `Boost until ${hhmm(new Date(boost.attributes.finishes_at))}`;
    else if (pauseTs > nowTs) mode = `Paused by tado until ${hhmm(new Date(pauseTs * 1000))}`;
    else if (holdTs > nowTs) mode = `Held until ${hhmm(new Date(holdTs * 1000))}`;
    else mode = `${schedule?.state === 'on' ? 'Schedule' : 'Setback'}${nextEvent ? ` until ${nextEvent}` : ''}`;
    const live = this._state(h.live_entity)?.state !== 'off';
    const action = this._state(h.climate_entity)?.attributes.hvac_action;
    return {
      boosting, mode, live, setback, desired,
      shown: this._pending ?? (boosting ? BOOST_TARGET : desired),
      scheduled: schedule?.state === 'on' ? num(schedule.attributes.target) : setback,
      overridden: holdTs > nowTs || pauseTs > nowTs,
      boiler: action === 'heating' ? 'heating' : action || '',
    };
  }

  _heatControl(big) {
    const s = this._heatingState();
    return `<div class="stepper ${big ? 'big' : ''}">
        <button class="round" data-action="step" data-delta="-0.5" aria-label="Lower target by half a degree">−</button>
        <div class="target">
          <div class="target-value ${this._pending !== null ? 'pending' : ''}">${s.shown === null ? '—' : `${s.shown.toFixed(1)}°`}</div>
          <div class="muted">${esc(s.mode)}${s.live ? '' : ' · shadow mode'}</div>
        </div>
        <button class="round" data-action="step" data-delta="0.5" aria-label="Raise target by half a degree">+</button>
      </div>
      <div class="pair">
        <button class="${s.boosting ? '' : 'primary'}" data-action="boost">${s.boosting ? 'Stop boost' : 'Boost 15 min'}</button>
        <button data-action="resume" ${s.overridden ? '' : 'disabled'}>Back to schedule</button>
      </div>`;
  }

  _heating() {
    const h = this._config.heating;
    const s = this._heatingState();
    const ref = this._state(h.reference_entity);
    const setpoint = this._state(h.setpoint_entity);
    const climate = this._state(h.climate_entity);
    const facts = [
      ['Bedroom', ref?.attributes.source ? `from the ${ref.attributes.source}` : '', deg(this._value(h.reference_entity))],
      ['tado reads', 'the thermostat’s own sensor', deg(climate?.attributes.current_temperature)],
      [s.live ? 'Sent to tado' : 'Would send to tado', setpoint?.attributes.reason || '', deg(this._value(h.setpoint_entity))],
      ['Bias', 'tado minus bedroom, capped at ±3°', deg(this._value(h.bias_entity))],
      ['Boiler', 'as tado reports it', s.boiler ? s.boiler[0].toUpperCase() + s.boiler.slice(1) : '—'],
      ['Setback', 'between blocks', deg(s.setback)],
    ];
    const aside = `<div class="switch-row boxed">
      <span>HA controls tado <span class="muted">${s.live ? '' : '(off: shadow mode)'}</span></span>
      ${switchButton(s.live, h.live_entity, 'HA controls tado')}</div>`;
    const body = `<div class="grid"><div class="grid full" style="--min: 360px">
      <section class="card" aria-label="Target">${this._heatControl(true)}${this._today(s.setback)}</section>
      <section class="card" aria-label="Now"><h2>Now</h2>
        ${facts.map(([label, note, value]) => `<div class="row"><span class="stack"><span>${esc(label)}</span>
          <span class="small muted">${esc(note)}</span></span><span class="value">${esc(value)}</span></div>`).join('')}
      </section></div>
      ${this._heatChart()}
      ${this._week(s.setback)}
    </div>`;
    return ['Heating', esc(this._value(h.status_entity) || s.mode), aside, body];
  }

  _heatChart() {
    const h = this._config.heating;
    const series = [
      { id: h.setpoint_entity, name: this._heatingState().live ? 'Sent to tado' : 'Would send', colour: C.grey, step: true, width: 2 },
      { id: h.target_entity, name: 'Target', colour: C.water, step: true },
      { id: h.reference_entity, name: 'Bedroom', colour: C.heat },
    ];
    return figure('Last 24 hours', legend(series), this._chartState('heat24')
      || lineChart(this._data.heat24.value, series, { unit: '°', label: 'Heating target, bedroom and setpoint over the last 24 hours' }));
  }

  // Today's blocks as a list, the current one marked.
  _today(setback) {
    const week = this._schedule?.week;
    if (!week) return '';
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const parts = dayParts(week[WEEKDAYS[now.getDay()]] || [], setback);
    return `<h2 class="spaced">Today</h2>${parts.map((p) => {
      const here = m >= p.from && m < p.to;
      return `<div class="row ${here ? 'here' : ''}"><span>${clock(p.from)} – ${clock(p.to)}${here ? ' <span class="pill on">now</span>' : ''}</span>
        <span class="value">${p.target === null ? '—' : `${p.target.toFixed(1)}°`}${p.on ? '' : ' <span class="small muted">setback</span>'}</span></div>`;
    }).join('')}`;
  }

  _week(setback) {
    const week = this._schedule?.week;
    const today = WEEKDAYS[new Date().getDay()];
    const now = new Date();
    const marker = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100;
    const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const rows = week ? order.map((day) => {
      const parts = dayParts(week[day] || [], setback);
      const peak = Math.max(...parts.map((p) => p.target ?? 0));
      return `<div class="day ${day === today ? 'today' : ''}">
        <span class="day-name">${day[0].toUpperCase()}${day.slice(1, 3)}</span>
        <div class="week-bar">
          ${parts.map((p) => {
            const width = ((p.to - p.from) / 1440) * 100;
            const tone = !p.on ? '' : p.target === peak ? 'warm' : 'mild';
            return `<div class="block ${tone}" style="width:${width}%" title="${esc(`${clock(p.from)}–${clock(p.to)} ${p.target ?? '—'}°`)}">${width > 6 && p.target !== null ? `${p.target}°` : ''}</div>`;
          }).join('')}
          ${day === today ? `<div class="now" style="left:${marker}%"></div>` : ''}
        </div>
      </div>`;
    }).join('') : '<div class="chart-empty">Loading the schedule…</div>';
    return `<section class="card full" aria-label="Weekly schedule">
      <div class="title-row"><h2>Weekly schedule</h2><span class="note">Gaps run at the setback, ${esc(deg(setback))}. Set in packages/heating.yaml.</span></div>
      ${rows}
      <div class="hours"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    </section>`;
  }

  // ───────────────────────────── home ─────────────────────────────

  _home() {
    const c = this._config;
    const offline = (c.lights || []).filter((l) => this._state(l.entity)?.state === 'unavailable');
    const leaks = Object.values(this._hass.states)
      .filter((s) => s.attributes.device_class === 'moisture' && s.state === 'on')
      .map((s) => s.attributes.friendly_name || s.entity_id);
    const issues = [];
    if (leaks.length) issues.push(`<strong class="alert-text">Water leak: ${esc(leaks.join(', '))}</strong>`);
    if (offline.length) {
      issues.push(`<a class="alert-text" href="${esc(pageUrl('lights'))}" data-action="nav" data-page="lights">${plural(offline.length, 'light', 'lights')} offline</a>`);
    }
    const lede = issues.length ? `All fine, except ${issues.join(' and ')}` : 'All fine';

    const now = new Date();
    const wx = this._state(c.weather_entity);
    const temp = wx ? num(wx.attributes.temperature) : null;
    const condition = wx ? wx.state.replace('partlycloudy', 'partly cloudy').replace(/-/g, ' ') : '';
    const aside = `<div class="when">${esc(now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}, ${hhmm(now)}
      ${temp === null ? '' : ` · <strong>${temp.toFixed(1)}°</strong> ${esc(condition)}`}</div>`;

    const s = this._heatingState();
    const h = c.heating;
    const heating = `<section class="card" aria-label="Heating">
      <div class="title-row"><h2>Heating</h2>${this._link('heating', 'Schedule')}</div>
      ${this._heatControl(false)}
      <div class="note center">Bedroom ${esc(deg(this._value(h.reference_entity)))} · schedule ${esc(deg(s.scheduled))}${s.boiler ? ` · boiler ${esc(s.boiler)}` : ''}</div>
    </section>`;

    const rooms = `<section class="card" aria-label="Rooms"><h2>Rooms</h2>
      ${(c.rooms || []).map((r) => `<div class="row"><span>${esc(r.name)}</span>
        <span class="value">${esc(deg(this._value(r.temperature_entity)))}<span class="hum">${num(this._value(r.humidity_entity)) === null ? '' : `${num(this._value(r.humidity_entity)).toFixed(0)}%`}</span></span></div>`).join('')}
    </section>`;

    const lights = `<section class="card" aria-label="Lights">
      <div class="title-row"><h2>Lights</h2>${this._link('lights', 'All')}</div>
      ${(c.lights || []).map((l) => lightButton(this._state(l.entity), l)).join('')}
    </section>`;

    const summaries = [this._catSummary(), this._energySummary(), this._appliancesSummary(), this._networkSummary()]
      .map(([page, title, value, lines]) => `<section class="card" aria-label="${esc(title)}">
        <div class="title-row"><h2>${esc(title)}</h2>${this._link(page, 'More')}</div>
        <div class="mid">${esc(value)}</div>
        <div class="lines muted">${lines.filter(Boolean).map(esc).join('<br>')}</div>
      </section>`).join('');

    const series = [
      ...(c.rooms || []).map((r, i) => ({ id: r.temperature_entity, name: r.name, colour: ROOM_COLOURS[i % ROOM_COLOURS.length] })),
      { id: h.target_entity, name: 'Heating target', colour: C.ink, step: true, dash: true, width: 2 },
    ];
    const chart = figure('Last 24 hours', legend(series), this._chartState('rooms24')
      || lineChart(this._data.rooms24.value, series, { unit: '°', label: 'Room temperatures and the heating target over the last 24 hours' }));

    return ['Home', lede, aside, `<div class="grid">${heating}${rooms}${lights}
      <div class="grid full" style="--min: 240px">${summaries}</div>${chart}</div>`];
  }

  _catSummary() {
    const cat = this._config.cat || {};
    const level = num(this._value(cat.fountain_level_entity));
    const today = num(this._value(cat.fountain_today_entity));
    const yesterday = num(this._value(cat.fountain_yesterday_entity));
    const visit = this._state(cat.litter_occupancy_entity);
    const visits = this._value(cat.litter_visits_entity);
    return ['cat', 'Cat', level === null ? '—' : `${Math.min(level, 100).toFixed(0)}%`, [
      'Fountain level',
      today === null ? '' : `${today.toFixed(0)} mL drunk today${yesterday === null ? '' : ` (${(yesterday * dayFraction()).toFixed(0)} by now yesterday)`}`,
      visits === null ? '' : `${plural(Number(visits), 'litter box visit', 'litter box visits')}${visit ? (visit.state === 'on' ? ', in use now' : `, last ${ago(visit.last_changed)}`) : ''}`,
    ]];
  }

  _energySummary() {
    const devices = this._config.energy?.devices || [];
    const month = this._data.month?.value;
    if (!month) return ['energy', 'Energy', '—', ['Measured this month']];
    const per = devices.map((d) => [d.name, month.series[d.energy_entity]?.change.at(-1) ?? 0]);
    const total = per.reduce((sum, [, v]) => sum + v, 0);
    return ['energy', 'Energy', `${kwh(total)} kWh`, ['Measured this month',
      per.map(([name, v]) => `${name} ${kwh(v)}`).join(' · ')]];
  }

  _appliancesSummary() {
    const machines = this._config.appliances?.machines || [];
    const lines = machines.map((m) => `${m.name}: ${this._value(m.status_entity) ?? 'offline'}`);
    const busy = machines.filter((m) => !/^(idle|docked|finished|off)/i.test(this._value(m.status_entity) ?? 'idle'));
    return ['appliances', 'Appliances', busy.length ? busy.map((m) => m.name).join(', ') : 'All idle', lines];
  }

  _networkSummary() {
    const n = this._config.network || {};
    const ratio = num(this._value(n.ratio_entity));
    const queries = num(this._value(n.queries_entity));
    const speed = num(this._value(n.speed_entity));
    return ['network', 'Network', ratio === null ? '—' : `${ratio.toFixed(1)}%`, [
      queries === null ? '' : `blocked of ${queries.toLocaleString('en-GB')} DNS queries`,
      speed === null ? '' : `Answers in ${speed.toFixed(1)} ms on average`,
    ]];
  }

  // ────────────────────────────── cat ─────────────────────────────

  _cat() {
    const cat = this._config.cat || {};
    const v = (key) => num(this._value(cat[key]));
    const level = v('fountain_level_entity');
    const today = v('fountain_today_entity');
    const yesterday = v('fountain_yesterday_entity');
    const byNow = yesterday === null ? null : yesterday * dayFraction();
    const low = level !== null && level < (cat.refill_below ?? 25);
    const sessions = v('sessions_today_entity');
    const sessionsYesterday = v('sessions_yesterday_entity');
    const avg = v('average_drink_entity');
    const total = v('drink_time_entity');
    const visit = this._state(cat.litter_occupancy_entity);
    const visits = v('litter_visits_entity');
    const days = this._data.catDays?.value;
    const litterDays = days?.series[cat.litter_visits_entity]?.max || [];
    const counted = litterDays.slice(0, -1).filter((n) => n > 0);
    const lede = today === null ? '' : `${today.toFixed(0)} mL drunk so far today${byNow === null ? '' : `, against ${byNow.toFixed(0)} mL by this time yesterday`}`;

    const body = `<div class="grid">
      <section class="card" aria-label="Fountain">
        <div class="title-row"><h2>Fountain</h2><span class="pill ${low ? 'bad' : 'good'}">${low ? 'Refill' : 'Good'}</span></div>
        <div class="big">${level === null ? '—' : `${Math.min(level, 100).toFixed(0)}%`}</div>
        <div class="meter"><div style="width:${Math.min(level ?? 0, 100)}%"></div></div>
        <div class="note">Water left in the tank. Refill below ${cat.refill_below ?? 25}%.</div>
      </section>
      <section class="card" aria-label="Drinking today"><h2>Drinking today</h2>
        <div class="quad">
          ${stat(today === null ? '—' : today.toFixed(0), 'mL', 'drunk')}
          ${stat(sessions === null ? '—' : sessions.toFixed(0), '', sessionsYesterday === null ? 'sessions' : `sessions (${sessionsYesterday.toFixed(0)} yesterday)`)}
          ${stat(avg === null ? '—' : avg.toFixed(0), 's', 'average session')}
          ${stat(total === null ? '—' : `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}`, '', 'minutes in total')}
        </div>
      </section>
      <section class="card" aria-label="Litter box"><h2>Litter box</h2>
        <div class="big">${visits === null ? '—' : visits.toFixed(0)} <span class="unit">visits today</span></div>
        <div>${visit ? (visit.state === 'on' ? 'In use now' : `Last visit ${ago(visit.last_changed)}`) : ''}</div>
        <div class="note">${counted.length ? `${(counted.reduce((a, b) => a + b, 0) / counted.length).toFixed(1)} a day on average over the last ${plural(counted.length, 'day', 'days')}` : ''}</div>
      </section>
      ${this._fountainChart()}
      ${this._dayBars('catDays', 'Water drunk per day', cat.fountain_today_entity, 'change', C.water, 'mL', true)}
      <div class="grid full" style="--min: 360px">
        ${this._dayBars('catDays', 'Drinking sessions per day', cat.sessions_today_entity, 'change', C.water, 'sessions')}
        ${this._dayBars('catDays', 'Litter box visits per day', cat.litter_visits_entity, 'max', C.water, 'visits')}
      </div>
    </div>`;
    return ['Cat', esc(lede), '', body];
  }

  _fountainChart() {
    const id = this._config.cat?.fountain_today_entity;
    const empty = this._chartState('fountain48');
    const series = [{ name: 'Yesterday', colour: C.grey }, { name: 'Today', colour: C.water }];
    if (empty) return figure('Today against yesterday', legend(series), empty);
    const points = this._data.fountain48.value.series[id] || [];
    const midnight = startOfDay(new Date()).getTime();
    const yesterday = midnight - 86400000;
    // Both days on one 00–24 axis: shift yesterday forward a day.
    const pick = (from, to, shift) => {
      const out = [[from + shift, 0]];
      for (const [t, value] of points) if (t >= from && t < to && value !== null) out.push([t + shift, value]);
      return out;
    };
    const data = { from: midnight, to: midnight + 86400000, series: {
      yesterday: pick(yesterday, midnight, 86400000), today: pick(midnight, Date.now(), 0) } };
    const top = Math.max(100, ...points.map(([, value]) => value ?? 0));
    const totalOf = (list) => list.at(-1)?.[1] ?? 0;
    series[0].name = `Yesterday ${totalOf(data.series.yesterday).toFixed(0)} mL`;
    series[1].name = `Today ${totalOf(data.series.today).toFixed(0)} mL`;
    return figure('Today against yesterday', legend(series), lineChart(data,
      [{ ...series[0], id: 'yesterday', step: true, stopAt: midnight + 86400000 },
        { ...series[1], id: 'today', step: true, width: 3, stopAt: Date.now() }],
      { unit: ' mL', min: 0, max: Math.ceil((top * 1.1) / 150) * 150, hours: [0, 6, 12, 18], nowLine: true,
        label: 'Water drunk through the day, today against yesterday' }));
  }

  _dayBars(name, title, id, type, colour, unit, full) {
    const empty = this._chartState(name);
    if (empty) return figure(title, '', empty, Boolean(full));
    const { dates, series } = this._data[name].value;
    const values = series[id]?.[type] || [];
    const counted = values.slice(0, -1).filter((v) => v > 0);
    const avg = counted.length ? counted.reduce((a, b) => a + b, 0) / counted.length : 0;
    const bars = values.map((v, i) => ({
      tip: `${dates[i].toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: ${Math.round(v * 10) / 10} ${unit}${i === values.length - 1 ? ' so far' : ''}`,
      parts: [{ v, colour: i === values.length - 1 ? `${colour}66` : colour }],
    }));
    return figure(title, `<span class="note">Last ${DAYS} days · ${avg >= 10 ? avg.toFixed(0) : avg.toFixed(1)} ${unit} a day on average</span>`,
      barChart(bars, dayLabels(dates), full ? 180 : 140), Boolean(full));
  }

  // ──────────────────────────── energy ────────────────────────────

  _energy() {
    const e = this._config.energy || {};
    const devices = e.devices || [];
    const rate = num(this._value(e.rate_entity));
    const money = (v) => (rate ? `£${((v * rate) / 100).toFixed(2)}` : '');
    const months = this._data.energyMonths?.value;
    const month = (d) => months?.series[d.energy_entity]?.change.at(-1) ?? null;
    const total = devices.reduce((sum, d) => sum + (month(d) ?? 0), 0);
    const lastMonth = devices.reduce((sum, d) => sum + (months?.series[d.energy_entity]?.change.at(-2) ?? 0), 0);

    const cards = devices.map((d) => {
      const m = month(d);
      const power = num(this._value(d.power_entity));
      return `<section class="card device" style="--tone:${esc(d.colour)}" aria-label="${esc(d.name)}">
        <div class="strong">${esc(d.name)}</div>
        <div class="mid">${m === null ? '—' : kwh(m)} <span class="unit">kWh</span></div>
        <div class="note">this month${m !== null && rate ? ` · ${money(m)}` : ''}</div>
        <div class="small">${power === null ? '' : `Now ${power.toFixed(power < 10 ? 1 : 0)} W`}</div>
      </section>`;
    }).join('');

    const rateCard = e.rate_entity ? `<section class="card full" aria-label="Unit rate">
      <div class="title-row wrap-row">
        <div class="stack"><h2>Unit rate</h2><span class="note">From your bill. Turns the kWh above into pounds.</span></div>
        <label class="rate">
          <input type="number" inputmode="decimal" step="0.01" min="0" data-change="rate" placeholder="p"
            value="${rate === null || rate === 0 ? '' : esc(rate)}" aria-label="Unit rate in pence per kWh">p / kWh
        </label>
      </div>
      ${rate ? `<div>This month so far: ${money(total)} for the measured devices. Last month: ${money(lastMonth)}.</div>` : ''}
    </section>` : '';

    const legendItems = devices.map((d) => ({ name: d.name, colour: d.colour }));
    const body = `<div class="grid"><div class="grid full" style="--min: 220px">${cards}</div>${rateCard}
      ${this._stackBars('energyDays', 'Per day, last 31 days', devices, 'Today so far on the right. A steady ~0.1 kWh a day is a device on standby.', legendItems, rate)}
      ${this._stackBars('energyMonths', 'Per month', devices, 'The current month is so far.', legendItems, rate, true)}
      <section class="card full quiet" aria-label="Whole house"><h2>No whole-house figure</h2>
        <div class="prose">There’s no smart meter, so nothing measures the whole house: these are the devices that report their own energy. A plug with a meter, or a clamp on the meter tails, would add a real total.</div>
      </section>
    </div>`;
    const names = devices.map((d) => d.name).join(', ').replace(/, ([^,]*)$/, ' and $1');
    return ['Energy', months ? esc(`${kwh(total)} kWh measured this month across ${names}`) : '', '', body];
  }

  _stackBars(name, title, devices, note, legendItems, rate, monthly) {
    const empty = this._chartState(name);
    if (empty) return figure(title, legend(legendItems), empty, true);
    const { dates, series } = this._data[name].value;
    const last = dates.length - 1;
    const bars = dates.map((date, i) => {
      const parts = devices.map((d) => ({ v: series[d.energy_entity]?.change[i] ?? 0, colour: i === last && !monthly ? `${d.colour}88` : d.colour }));
      const sum = parts.reduce((a, p) => a + p.v, 0);
      const label = monthly ? date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
        : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      return { parts, tip: `${label}: ${kwh(sum)} kWh${rate ? ` (£${((sum * rate) / 100).toFixed(2)})` : ''} — `
        + devices.map((d, j) => `${d.name} ${kwh(parts[j].v)}`).join(', ') };
    });
    const labels = monthly ? dates.map((d) => d.toLocaleDateString('en-GB', { month: 'short' })) : dayLabels(dates);
    return figure(title, legend(legendItems), `${barChart(bars, labels, 200, monthly)}<div class="note">${esc(note)}</div>`, true);
  }

  // ────────────────────────── appliances ──────────────────────────

  _appliances() {
    const a = this._config.appliances || {};
    const machines = a.machines || [];
    const months = this._data.energyMonths?.value;
    const cards = machines.map((m) => {
      const status = this._value(m.status_entity) ?? 'Offline';
      const [head, ...rest] = status.split(' · ');
      const idle = /^(idle|docked|finished|off)/i.test(head);
      const count = months ? Math.round(months.series[m.cycles_entity]?.change.at(-1) ?? 0) : null;
      const energy = months?.series[m.energy_entity]?.change.at(-1);
      const rows = [
        ['Last', this._value(m.summary_entity) ?? '—'],
        ['Energy this month', energy === undefined ? '—' : `${kwh(energy)} kWh`],
        ...(rest.length ? [['Status', status]] : []),
      ];
      const toggles = (m.toggles || []).map((t) => {
        const s = this._state(t.entity);
        return `<div class="switch-row">${esc(t.name)}${s && s.state !== 'unavailable' ? switchButton(s.state === 'on', t.entity, t.name) : '<span class="muted">offline</span>'}</div>`;
      }).join('');
      const vacuum = m.vacuum_entity ? (() => {
        const cleaning = this._state(m.vacuum_entity)?.state === 'cleaning' || /clean/i.test(head);
        return `<button class="primary" data-action="vacuum" data-entity="${esc(m.vacuum_entity)}"
          data-service="${cleaning ? 'return_to_base' : 'start'}">${cleaning ? 'Send to dock' : 'Start cleaning'}</button>`;
      })() : '';
      return `<section class="card" aria-label="${esc(m.name)}">
        <div class="title-row"><h2>${esc(m.name)}</h2><span class="pill ${idle ? '' : 'on'}">${esc(head)}</span></div>
        <div class="mid">${count === null ? '—' : `${plural(count, m.one || 'cycle', m.many || 'cycles')}`} <span class="unit">this month</span></div>
        ${rows.map(([k, v]) => `<div class="row"><span class="muted">${esc(k)}</span><span class="right">${esc(v)}</span></div>`).join('')}
        ${toggles}${vacuum}
      </section>`;
    }).join('');
    const legendItems = machines.map((m) => ({ name: m.name, colour: m.colour }));
    const body = `<div class="grid">${cards}
      ${this._stackBars('energyDays', 'Energy per day, last 31 days', machines, 'A bar is a day the machine ran; the vacuum’s small steady bar is its dock.', legendItems)}
      ${this._stackBars('energyMonths', 'Energy per month', machines, 'The current month is so far.', legendItems, null, true)}
    </div>`;
    const busy = machines.filter((m) => !/^(idle|docked|finished|off)/i.test(this._value(m.status_entity) ?? 'idle'));
    return ['Appliances', busy.length ? esc(busy.map((m) => `${m.name}: ${this._value(m.status_entity)}`).join(' · ')) : 'All idle', '', body];
  }

  // ──────────────────────────── network ───────────────────────────

  _network() {
    const n = this._config.network || {};
    const v = (key) => num(this._value(n[key]));
    const queries = v('queries_entity');
    const blocked = v('blocked_entity');
    const ratio = v('ratio_entity');
    const speed = v('speed_entity');
    const protection = this._state(n.protection_entity)?.state;
    const stats = [
      ['Queries', queries === null ? '—' : queries.toLocaleString('en-GB'), 'past 24 hours'],
      ['Blocked', blocked === null ? '—' : blocked.toLocaleString('en-GB'), ratio === null ? '' : `${ratio.toFixed(1)}% of queries`],
      ['Answer time', speed === null ? '—' : `${speed.toFixed(1)} ms`, 'average'],
      ['Protection', protection === 'on' ? 'On' : protection === 'off' ? 'Off' : '—', protection === 'off' ? 'nothing is blocked' : 'blocking for every device'],
    ];
    const series = [{ id: n.queries_entity, name: 'Queries', colour: C.water }, { id: n.blocked_entity, name: 'Blocked', colour: C.heat }];
    const chart = figure('Queries over the past day', legend(series), `<div class="note">Each point is AdGuard’s count for the 24 hours before it, so the line moves slowly.</div>${
      this._chartState('dns24') || lineChart(this._data.dns24.value, series, { min: 0, unit: '', thousands: true, label: 'DNS queries and blocked queries over the past day' })}`);
    const switches = (n.switches || []).map((w) => {
      const s = this._state(w.entity);
      return `<div class="switch-row tall"><span class="stack"><span>${esc(w.name)}</span><span class="small muted">${esc(w.note || '')}</span></span>
        ${s && s.state !== 'unavailable' ? switchButton(s.state === 'on', w.entity, w.name) : '<span class="muted">offline</span>'}</div>`;
    }).join('');
    const body = `<div class="grid" style="--min: 240px">
      ${stats.map(([label, value, note]) => `<section class="card" aria-label="${esc(label)}"><div class="note">${esc(label)}</div>
        <div class="mid">${esc(value)}</div><div class="note">${esc(note)}</div></section>`).join('')}
      ${chart}
      <section class="card full" aria-label="AdGuard settings">
        <div class="title-row wrap-row"><h2>AdGuard settings</h2>
          ${n.protection_entity ? `<button class="${protection === 'off' ? 'primary' : ''}" data-action="toggle" data-entity="${esc(n.protection_entity)}">${protection === 'off' ? 'Resume protection' : 'Pause protection'}</button>` : ''}
        </div>
        <div class="two-col">${switches}</div>
      </section>
    </div>`;
    const lede = ratio === null ? '' : `AdGuard is blocking ${ratio.toFixed(1)}% of DNS lookups${speed === null ? '' : `, answering in ${speed.toFixed(1)} ms`}`;
    return ['Network', esc(lede), '', body];
  }

  // ──────────────────────────── lights ────────────────────────────

  _lights() {
    const c = this._config;
    const lights = c.lights || [];
    const cards = lights.map((l) => {
      const s = this._state(l.entity);
      const offline = !s || s.state === 'unavailable';
      const on = s?.state === 'on';
      const dimmable = l.entity.startsWith('light.') && on && (s.attributes.supported_color_modes || []).some((m) => m !== 'onoff');
      const level = Math.round(((s?.attributes.brightness ?? 255) / 255) * 100);
      return `<section class="card light-card ${offline ? 'offline' : ''} ${on ? 'on' : ''}" aria-label="${esc(l.name)}">
        <div class="title-row">
          <div class="light-title">${ICON}<span class="stack"><h2>${esc(l.name)}</h2><span class="note">${esc(l.kind || '')}</span></span></div>
          ${offline ? '<span class="alert-text strong">Offline</span>'
            : `<button class="${on ? 'primary' : ''}" data-action="toggle" data-entity="${esc(l.entity)}" aria-pressed="${on}">${on ? 'On' : 'Off'}</button>`}
        </div>
        <div>${offline ? 'Offline' : on ? 'On' : 'Off'}${s ? ` since ${esc(when(s.last_changed))}` : ''}</div>
        ${dimmable ? `<label class="slider">Brightness<input type="range" min="1" max="100" value="${level}" data-change="brightness" data-entity="${esc(l.entity)}"><span>${level}%</span></label>` : ''}
        ${offline && l.fix ? `<div class="fix">${esc(l.fix)}</div>` : ''}
      </section>`;
    }).join('');
    const plugs = (c.plugs || []).map((p) => {
      const s = this._state(p.entity);
      const power = num(this._value(p.power_entity));
      return `<div class="switch-row tall"><span class="stack"><span>${esc(p.name)}</span>
        <span class="small muted">${s ? `${s.state === 'on' ? 'On' : s.state === 'off' ? 'Off' : 'Offline'} since ${esc(when(s.last_changed))}` : ''}${power === null ? '' : ` · ${power.toFixed(1)} W`}</span></span>
        ${s && s.state !== 'unavailable' ? switchButton(s.state === 'on', p.entity, p.name) : ''}</div>`;
    }).join('');
    const on = lights.filter((l) => this._state(l.entity)?.state === 'on').length;
    const down = lights.filter((l) => (this._state(l.entity)?.state ?? 'unavailable') === 'unavailable').length;
    const lede = `${on ? `${on} on` : 'All off'}${down ? ` · ${down} of ${lights.length} offline` : ''}`;
    const aside = `<button data-action="all-off" ${on ? '' : 'disabled'}>Turn all lights off</button>`;
    const body = `<div class="grid">${cards}
      ${plugs ? `<section class="card full" aria-label="Plugs"><h2>Plugs</h2>${plugs}</section>` : ''}
    </div>`;
    return ['Lights', esc(lede), aside, body];
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const dayFraction = () => {
  const now = new Date();
  return (now.getHours() * 3600 + now.getMinutes() * 60) / 86400;
};

const clock = (minutes) => {
  const m = Math.round(minutes); // a block ending 23:59:59 reads 24:00
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

function dashboardPath() {
  return window.location.pathname.split('/')[1] || 'dashboard-laptop';
}

function pageUrl(page) {
  return `/${dashboardPath()}/${page}${window.location.search}`;
}

// HA's in-app navigation: no reload, same as clicking a view tab.
function navigate(page) {
  window.history.pushState(null, '', pageUrl(page));
  window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
}

// A day's schedule blocks plus the setback gaps between them, in minutes.
function dayParts(blocks, setback) {
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
  return parts;
}

function switchButton(on, entity, name) {
  return `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(name)}"
    data-action="toggle" data-entity="${esc(entity)}"><span></span></button>`;
}

function lightButton(s, l) {
  const offline = !s || s.state === 'unavailable';
  const on = s?.state === 'on';
  return `<button class="light ${offline ? 'offline' : ''} ${on ? 'on' : ''}" data-action="toggle"
    data-entity="${esc(l.entity)}" ${offline ? 'disabled' : ''} aria-pressed="${on}">
    ${ICON}<span class="light-name">${esc(l.name)}</span><span>${offline ? 'Offline' : on ? 'On' : 'Off'}</span></button>`;
}

function stat(value, unit, label) {
  return `<div><div class="mid">${esc(value)}${unit ? ` <span class="unit">${esc(unit)}</span>` : ''}</div><div class="note">${esc(label)}</div></div>`;
}

function legend(items) {
  return `<div class="legend">${items.map((s) => `<span><i style="background:${esc(s.colour)}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}

function figure(title, extra, chart, full = true) {
  return `<figure class="card ${full ? 'full' : ''}"><div class="title-row wrap-row"><figcaption>${esc(title)}</figcaption>${extra}</div>${chart}</figure>`;
}

function dayLabels(dates) {
  const first = dates[0];
  const firstOfMonth = dates.findIndex((d, i) => i > 0 && d.getDate() === 1);
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return [fmt(first), firstOfMonth > 0 ? fmt(dates[firstOfMonth]) : '', 'Today'].filter(Boolean);
}

// Lines over time. `data` is { from, to, series: { id: [[ms, value], ...] } };
// `series` picks ids, colours and whether a line steps (setpoints) or slopes.
function lineChart(data, series, opts = {}) {
  const W = 1000;
  const H = 220;
  const { from, to } = data;
  const values = series.flatMap((s) => (data.series[s.id] || []).map(([, v]) => v)).filter((v) => v !== null);
  if (!values.length) return '<div class="chart-empty">No history for this period.</div>';
  let min = opts.min ?? Math.floor(Math.min(...values) - 0.5);
  let max = opts.max ?? Math.ceil(Math.max(...values) + 0.5);
  if (opts.min === 0 && opts.max === undefined) max = niceTop((Math.max(...values) * 1.08) / 3) * 3;
  if (max - min < 2) { min -= 1; max += 1; }
  // Whole-degree ranges split into thirds, so the axis labels come out round.
  if (opts.max === undefined && opts.min === undefined) while ((max - min) % 3) max += 1;
  const x = (t) => (((Math.min(Math.max(t, from), to) - from) / (to - from)) * W).toFixed(1);
  const y = (v) => (H - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * H).toFixed(1);
  const lines = series.map((s) => {
    const pts = [];
    let prev = null;
    for (const [t, v] of data.series[s.id] || []) {
      if (v === null) continue;
      if (s.step && prev !== null) pts.push(`${x(t)},${y(prev)}`);
      pts.push(`${x(t)},${y(v)}`);
      prev = v;
    }
    // The last value holds until now (or the series' own end).
    if (prev !== null) pts.push(`${x(s.stopAt ?? to)},${y(prev)}`);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.colour}" stroke-width="${s.width || 2.5}"
      ${s.dash ? 'stroke-dasharray="6 5"' : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline>`;
  }).join('');
  const label = (v) => (opts.thousands && v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v * 10) / 10}${opts.unit ?? ''}`);
  const yTicks = [max, min + ((max - min) * 2) / 3, min + (max - min) / 3, min];
  const ticks = [];
  if (opts.hours) {
    for (const hour of opts.hours) ticks.push([((hour / 24) * 100).toFixed(2), `${String(hour).padStart(2, '0')}:00`]);
  } else {
    const t = new Date(from);
    t.setMinutes(0, 0, 0);
    while (t.getTime() < to) {
      t.setHours(t.getHours() + 1);
      const step = (to - from) > 30 * 3600000 ? 12 : 4;
      if (t.getHours() % step === 0 && t.getTime() < to) {
        ticks.push([(((t.getTime() - from) / (to - from)) * 100).toFixed(2),
          t.getHours() === 0 ? t.toLocaleDateString('en-GB', { weekday: 'short' }) : hhmm(t)]);
      }
    }
  }
  const nowLine = opts.nowLine ? `<div class="now-line" style="left:${x(Date.now()) / 10}%"></div>` : '';
  return `<div class="chart">
    <div class="y-axis">${yTicks.map((v) => `<span>${esc(label(v))}</span>`).join('')}</div>
    <div class="plot-col">
      <div class="plot">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || '')}">${lines}</svg>
        ${nowLine}
      </div>
      <div class="x-axis">${ticks.map(([left, text]) => `<span style="left:${left}%">${esc(text)}</span>`).join('')}</div>
    </div>
  </div>`;
}

function niceTop(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value || 1));
  const step = [1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((m) => m * magnitude >= value);
  return step * magnitude;
}

// Stacked bars: each bar is { tip, parts: [{ v, colour }] }, scaled to the tallest.
function barChart(bars, labels, height = 200, spaced = false) {
  const top = Math.max(...bars.map((b) => b.parts.reduce((sum, p) => sum + p.v, 0)), 0) || 1;
  return `<div class="bars ${spaced ? 'spaced' : ''}" style="height:${height}px">
    ${bars.map((b) => `<div class="bar" title="${esc(b.tip)}">${b.parts.slice().reverse()
      .map((p) => `<div style="height:${(p.v / top) * 100}%;background:${esc(p.colour)}"></div>`).join('')}</div>`).join('')}
  </div>
  <div class="bar-labels ${spaced ? 'even' : ''}">${labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`;
}

function loadFonts() {
  if (document.querySelector('link[data-laptop-dashboard-fonts]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONTS;
  link.dataset.laptopDashboardFonts = '';
  document.head.appendChild(link);
}

const STYLES = `
  :host { display: block; }
  * { box-sizing: border-box; }
  .page { min-height: 100vh; background: ${C.ground}; color: ${C.ink};
    font-family: 'Schibsted Grotesk', system-ui, sans-serif; }
  .wrap { max-width: 1440px; margin: 0 auto; padding: 24px; display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
  a { color: ${C.accent}; text-decoration: none; }
  a:hover { color: ${C.accentDark}; }
  :focus-visible { outline: 3px solid ${C.accent}; outline-offset: 2px; }

  nav { flex: 1 1 200px; max-width: 220px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: 24px; }
  .brand { font-size: 20px; font-weight: 700; padding: 8px 12px 16px; }
  nav a { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 12px; border-radius: 10px;
    color: ${C.ink}; font-size: 16px; font-weight: 500; }
  nav a:hover { background: ${C.faint}; color: ${C.ink}; }
  nav a.here { background: ${C.accentSoft}; color: ${C.accentDark}; font-weight: 600; }

  main { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
  .head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 8px 24px; padding-top: 8px; }
  .titles { display: flex; flex-direction: column; gap: 4px; }
  h1 { margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px; }
  .lede { font-size: 17px; }
  .when { font-size: 16px; color: ${C.muted}; }
  .when strong { color: ${C.ink}; font-weight: 600; }
  .alert-text { color: ${C.alertFg}; font-weight: 600; }
  a.alert-text:hover { color: ${C.alertFg}; text-decoration: underline; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(var(--min, 300px), 100%), 1fr)); gap: 16px; }
  .card { margin: 0; background: ${C.card}; border-radius: 18px; padding: 20px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .card.full, .grid.full { grid-column: 1 / -1; }
  .card.quiet { background: ${C.faint}; }
  h2, figcaption { margin: 0; font-size: 18px; font-weight: 600; }
  .title-row { display: flex; justify-content: space-between; align-items: center; gap: 8px 16px; }
  .wrap-row { flex-wrap: wrap; }
  .more { font-size: 14px; font-weight: 600; }
  .muted { color: ${C.muted}; }
  .note { font-size: 14px; color: ${C.muted}; }
  .small { font-size: 13px; }
  .strong { font-weight: 600; font-size: 16px; }
  .center { text-align: center; }
  h2.spaced { margin-top: 10px; }
  .row.here { font-weight: 600; }
  .target .muted { white-space: nowrap; letter-spacing: 0; }
  .prose { font-size: 15px; line-height: 1.5; max-width: 760px; }
  .stack { display: flex; flex-direction: column; }
  .big { font-size: 44px; font-weight: 600; letter-spacing: -1px; line-height: 1.1; }
  .mid { font-size: 30px; font-weight: 600; letter-spacing: -0.5px; line-height: 1.15; }
  .unit { font-size: 16px; font-weight: 500; color: ${C.muted}; letter-spacing: 0; }
  .lines { font-size: 15px; line-height: 1.45; }
  .quad { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; min-height: 40px;
    border-top: 1px solid ${C.line}; padding-top: 8px; font-size: 15px; }
  h2 + .row { border-top: none; }
  .row .value { font-size: 18px; font-weight: 600; white-space: nowrap; }
  .row .right { text-align: right; }
  .hum { display: inline-block; width: 52px; text-align: right; font-size: 15px; font-weight: 400; color: ${C.muted}; }
  .pill { font-size: 13px; font-weight: 600; padding: 3px 10px; border-radius: 10px; background: ${C.faint}; color: ${C.muted}; white-space: nowrap; }
  .pill.on { background: ${C.accentSoft}; color: ${C.accentDark}; }
  .pill.good { background: ${C.goodBg}; color: ${C.goodFg}; }
  .pill.bad { background: ${C.alertBg}; color: ${C.alertFg}; }
  .meter { height: 10px; border-radius: 5px; background: ${C.faint}; overflow: hidden; }
  .meter div { height: 100%; background: ${C.water}; border-radius: 5px; }

  button { font: 600 15px 'Schibsted Grotesk', system-ui, sans-serif; color: ${C.ink}; cursor: pointer;
    min-height: 44px; padding: 0 16px; border-radius: 12px; border: 1px solid ${C.control}; background: ${C.card}; }
  button:hover { background: ${C.faint}; }
  button.primary { background: ${C.accent}; border-color: ${C.accent}; color: #FFFFFF; }
  button.primary:hover { background: ${C.accentDark}; }
  button:disabled { opacity: .4; cursor: default; }
  button:active:not(:disabled) { filter: brightness(.92); }
  .pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .round { width: 48px; height: 48px; border-radius: 24px; padding: 0; font-size: 24px; font-weight: 500; background: ${C.ground}; }
  .stepper { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .stepper.big .round { width: 56px; height: 56px; border-radius: 28px; font-size: 28px; }
  .target { text-align: center; }
  .target .muted { font-size: 14px; }
  .target-value { font-size: 48px; font-weight: 600; letter-spacing: -1px; line-height: 1; color: ${C.heat}; }
  .stepper.big .target-value { font-size: 64px; letter-spacing: -2px; }
  .target-value.pending { opacity: .6; }

  .switch { flex: none; width: 46px; height: 28px; min-height: 0; border-radius: 14px; border: none; padding: 3px;
    background: #C3CAD0; display: flex; justify-content: flex-start; }
  .switch.on { background: ${C.accent}; justify-content: flex-end; }
  .switch:hover { background: #B3BBC2; }
  .switch.on:hover { background: ${C.accentDark}; }
  .switch span { width: 22px; height: 22px; border-radius: 11px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px;
    border-top: 1px solid ${C.line}; font-size: 15px; }
  .switch-row.tall { min-height: 56px; font-size: 16px; }
  h2 + .switch-row { border-top: none; }
  .switch-row.boxed { border: none; background: ${C.card}; border-radius: 12px; padding: 0 14px; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 0 32px; }

  .light { display: flex; align-items: center; gap: 10px; padding: 0 12px; font-weight: 500; text-align: left; }
  .light span:last-child { font-size: 14px; color: ${C.muted}; }
  .light.on { border-color: ${C.heat}; }
  .light.on span:last-child { color: ${C.heat}; }
  .light.offline, .light.offline:disabled { opacity: 1; background: ${C.alertBg}; color: ${C.alertFg}; border-color: ${C.alertLine}; }
  .light.offline span:last-child { color: ${C.alertFg}; }
  .light-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .light-card.offline { box-shadow: inset 0 0 0 1px ${C.alertLine}; }
  .light-card.offline .light-title { color: ${C.alertFg}; }
  .light-card.on .light-title svg { color: ${C.heat}; }
  .light-title { display: flex; align-items: center; gap: 12px; color: ${C.grey}; }
  .light-title h2 { color: ${C.ink}; }
  .fix { background: ${C.alertBg}; color: ${C.alertFg}; border-radius: 12px; padding: 12px 14px; font-size: 14px; line-height: 1.45; }
  .slider { display: flex; align-items: center; gap: 12px; font-size: 14px; color: ${C.muted}; }
  .slider input { flex: 1; accent-color: ${C.accent}; }
  .slider span { width: 40px; text-align: right; color: ${C.ink}; }

  .device { box-shadow: inset 4px 0 0 var(--tone); }
  .rate { display: flex; align-items: center; gap: 8px; font-size: 16px; }
  .rate input { width: 110px; min-height: 44px; padding: 0 12px; border: 1px solid ${C.control}; border-radius: 10px;
    font: 500 18px 'Schibsted Grotesk', system-ui, sans-serif; color: ${C.ink}; }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 14px; }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .legend i { width: 12px; height: 12px; border-radius: 3px; }
  .chart { display: flex; gap: 10px; }
  .y-axis { display: flex; flex-direction: column; justify-content: space-between; height: 220px; width: 44px;
    font-size: 12px; color: ${C.muted}; text-align: right; }
  .y-axis span { line-height: 1; }
  .plot-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .plot { position: relative; height: 220px; border-top: 1px solid ${C.faint}; border-bottom: 1px solid ${C.control};
    background: linear-gradient(${C.faint}, ${C.faint}) 0 33.3% / 100% 1px no-repeat,
      linear-gradient(${C.faint}, ${C.faint}) 0 66.6% / 100% 1px no-repeat; }
  .plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .now-line { position: absolute; top: 0; bottom: 0; border-left: 2px dashed ${C.grey}; }
  .x-axis { position: relative; height: 16px; font-size: 12px; color: ${C.muted}; }
  .x-axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .chart-empty { height: 160px; display: flex; align-items: center; justify-content: center; color: ${C.muted};
    border: 2px dashed ${C.control}; border-radius: 12px; font-size: 15px; }
  .bars { display: flex; align-items: flex-end; gap: 3px; border-bottom: 1px solid ${C.control}; }
  .bars.spaced { gap: 14px; }
  .bar { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
  .bar div:last-child { border-radius: 3px 3px 0 0; }
  .bar-labels { display: flex; justify-content: space-between; font-size: 12px; color: ${C.muted}; }
  .bar-labels.even { gap: 14px; }
  .bar-labels.even span { flex: 1; text-align: center; }

  .day { display: flex; align-items: center; gap: 14px; }
  .day-name { width: 44px; font-size: 15px; }
  .day.today .day-name { font-weight: 700; }
  .week-bar { position: relative; flex: 1; display: flex; height: 34px; border-radius: 8px; overflow: hidden; background: ${C.faint}; }
  .block { display: flex; align-items: center; padding-left: 8px; font-size: 13px; font-weight: 600; color: ${C.muted};
    border-right: 2px solid ${C.card}; white-space: nowrap; overflow: hidden; }
  .block.mild { background: #F6DCC8; color: ${C.ink}; }
  .block.warm { background: #F2C4A3; color: ${C.ink}; }
  .week-bar .now { position: absolute; top: 0; bottom: 0; width: 2px; background: ${C.ink}; }
  .hours { display: flex; justify-content: space-between; margin-left: 58px; font-size: 12px; color: ${C.muted}; }

  @media (max-width: 700px) {
    .wrap { padding: 16px; }
    nav { position: static; max-width: none; flex-direction: row; flex-wrap: wrap; }
    .brand { display: none; }
  }
`;

customElements.define('laptop-dashboard-card', LaptopDashboardCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'laptop-dashboard-card',
  name: 'Laptop dashboard',
  description: 'One page of the laptop dashboard: home, heating, cat, energy, appliances, network or lights.',
});
