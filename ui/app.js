/* DJ Task Manager — WebView layer. All persistence and scheduling lives in Rust;
   this file only renders state and calls `invoke`. */
'use strict';

const TAURI = window.__TAURI__;
const invoke = TAURI?.core?.invoke
  || (async (cmd) => { throw new Error(`IPC unavailable (asked for "${cmd}") — run inside DJ Task Manager.exe`); });
const listen = TAURI?.event?.listen || (async () => () => {});

/* ---------------------------------------------------------------- state -- */

const S = {
  view: 'tasks',
  info: null,
  stats: null,
  storage: null,
  settings: {},
  tasks: [],
  alarms: [],
  missed: [],
  selectedTask: null,
  draft: null,
  filter: 'all',
  query: '',
  calCursor: null,      // {y, m} — m is 1-based
  calDay: null,         // epoch seconds of the selected day
  calEvents: [],
  showResolved: false,
  driftMs: 0,
  lastError: null,
  schema: null,
  analytics: null,
  activity: [],
  health: null,
  autostart: null,
};

const PRIORITY = {
  p1: { label: 'P1 High', cls: 'tag-p1' },
  p2: { label: 'P2 Med', cls: 'tag-p2' },
  p3: { label: 'P3 Low', cls: 'tag-p3' },
  p4: { label: 'P4 Trivial', cls: 'tag-p4' },
};
const STATUS = { todo: 'Todo', doing: 'In Progress', done: 'Done' };
const SOUNDS = { chime: 'Chime — Modern Ping', bell: 'Subtle Bell — Haptic Echo', pulse: 'Synthetic Pulse (High Urgent)' };
const REPEATS = { none: 'One-off', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Selected days' };
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/* monochrome glyph map — keeps the UI readable with no icon webfont installed */
const GLYPH = {
  search: '⌕', add_task: '＋', alarm_add: '⏱', dark_mode: '◐', light_mode: '○', check_circle: '◉',
  timer: '⏲', calendar_today: '▦', notification_important: '⚠', settings: '⚙', play_arrow: '▶',
  pause: '❙❙', stop: '■', snooze: '↺', close: '✕', done_all: '✓', done: '✓', check: '✓', alarm: '⏰',
  alarm_off: '⏳', expand_more: '▾', swap_vert: '⇅', filter_list: '⚏', more_horiz: '⋯', link: '⌁',
  format_bold: 'B', code: '</>', event: '▤', volume_up: '♪', cloud_done: '☁', tune: '⚒', warning: '⚠',
  calendar_clock: '◷', notifications_active: '🔔', delete: '✕', edit: '✎', refresh: '↻', download: '⤓',
  upload: '⤒', database: '⛃', folder_open: '🗀', keyboard: '⌨', schedule: '⏲', add: '＋', task: '☑',
  notifications: '🔔', bolt: '⚡', history: '↩', save: '⛁', visibility: '👁', error: '⚠',
  search_off: '⌽', density_small: '≡', more_vert: '⋮', help: '?', rotate_right: '↻',
};

/* ------------------------------------------------------------- helpers -- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dayStart = (e) => { const d = new Date(e * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
const TODAY0 = () => dayStart(Math.floor(Date.now() / 1000));
const MIN = 60, HOUR = 3600, DAY = 86400;

function hhmm(e) {
  if (e == null) return '--:--';
  const d = new Date(e * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function clockLabel(e) {
  const d = new Date(e * 1000);
  return `${DOW[(d.getDay() + 6) % 7]} ${pad(d.getDate())} ${d.toLocaleString(undefined, { month: 'short' })} ${hhmm(e)}`;
}
function dayLabel(e) {
  if (e == null) return 'No date';
  const diff = Math.round((dayStart(e) - TODAY0()) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return new Date(e * 1000).toLocaleString(undefined, { weekday: 'long' });
  return new Date(e * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric' });
}
function dueLabel(e) {
  if (e == null) return { text: 'No Alarm', cls: 'is-none' };
  const now = Math.floor(Date.now() / 1000);
  const cls = e < now ? 'is-late' : (e - now < 2 * HOUR ? 'is-soon' : '');
  return { text: `${hhmm(e)} ${dayLabel(e)}`, cls };
}
function relLabel(e) {
  if (e == null) return '—';
  const delta = e - Math.floor(Date.now() / 1000);
  const abs = Math.abs(delta);
  const unit = abs < HOUR ? `${Math.max(1, Math.round(abs / MIN))}m` : abs < DAY ? `${Math.round(abs / HOUR)}h` : `${Math.round(abs / DAY)}d`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}
function mmss(sec) { return `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`; }
function recurrenceLabel(t) {
  const days = t.recurrence === 'weekly' && t.recurDays?.length ? ' ' + t.recurDays.map((d) => DOW[d]).join('') : '';
  return `repeats ${t.recurrence}${days}`;
}
function sparkline() {
  const series = S.analytics?.completions ?? [];
  if (!series.length) return '<span class="hint mono">no completions in this window</span>';
  const max = Math.max(1, ...series.map((c) => c.count));
  return series.slice(-14).map((c) =>
    `<div title="${esc(c.day)}: ${c.count}" style="flex:1;background:var(--tertiary-container);border-radius:2px 2px 0 0;height:${Math.max(8, Math.round((c.count / max) * 100))}%"></div>`).join('');
}
function activityFeed() {
  const rows = (S.activity ?? []).slice(0, 8);
  if (!rows.length) return '<span class="hint mono">nothing logged yet</span>';
  return rows.map((a) => `<div class="rowcount"><span>${esc(a.kind)} · ${esc(a.summary)}</span><b>${relLabel(a.at)}</b></div>`).join('');
}

function applyIcons(root = document) {
  $$('.mi', root).forEach((el) => {
    const key = (el.textContent || '').trim();
    if (GLYPH[key]) el.textContent = GLYPH[key];
  });
}

/// Builds a complete TaskInput from a loaded task. Rust treats an omitted field as the
/// serde default, so a partial payload would silently reset recurrence or tags.
function taskPayload(t, overrides = {}) {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    priority: t.priority,
    status: t.status,
    dueAt: t.dueAt,
    tags: t.tags ?? [],
    recurrence: t.recurrence ?? 'none',
    recurDays: t.recurDays ?? [],
    parentId: t.parentId ?? null,
    ...overrides,
  };
}

async function call(cmd, payload) {
  try {
    return await invoke(cmd, payload);
  } catch (err) {
    const message = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
    S.lastError = `${cmd}: ${message}`;
    toast('Command failed', S.lastError, [{ label: 'Dismiss', kind: 'btn-danger' }], 'error');
    console.error(`[dj-task-manager] ${cmd} failed`, err);
    return null;
  }
}

/* --------------------------------------------------------------- toasts -- */

function toast(title, body, actions = [], kind = '') {
  const host = $('#toastHost');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `
    <div class="toast-top">
      <span class="toast-app"><span class="sq"><span class="mi">alarm</span></span>DJ Task Manager</span>
      <span class="toast-when">Just now</span>
    </div>
    <div class="toast-title">${esc(title)}</div>
    ${body ? `<div class="toast-body">${esc(body)}</div>` : ''}
    ${actions.length ? `<div class="toast-actions">${actions.map((a, i) =>
      `<button class="btn ${a.kind || 'btn-ghost'}" data-i="${i}">${a.icon ? `<span class="mi">${a.icon}</span>` : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}`;
  applyIcons(el);
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.toast-top').insertAdjacentHTML('beforeend',
    `<button class="icon-btn" style="width:18px;height:18px" data-close><span class="mi">close</span></button>`);
  applyIcons(el);
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-close]')) return close();
    const btn = ev.target.closest('.toast-actions .btn');
    if (!btn) return;
    const action = actions[Number(btn.dataset.i)];
    if (action?.onClick) action.onClick();
    close();
  });
  if (!actions.length) {
    const bar = document.createElement('span');
    bar.className = 'toast-timer';
    bar.style.animationDuration = '6s';
    el.appendChild(bar);
    setTimeout(close, 6000);
  }
  host.appendChild(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  return close;
}

/* --------------------------------------------------------------- modals -- */

function openModal(html, onMount) {
  const host = $('#modalHost');
  // Each dialog gets its own layer so a picker can open over an editor without
  // wiping the draft underneath. Later layers paint above earlier ones.
  const layer = document.createElement('div');
  layer.className = 'modal-layer';
  layer.innerHTML = `<div class="scrim"><div class="modal">${html}</div></div>`;
  host.appendChild(layer);
  applyIcons(layer);
  const scrim = layer.querySelector('.scrim');
  const close = () => layer.remove();
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  scrim.addEventListener('click', (e) => { if (e.target.closest('[data-close-modal]')) close(); });
  onMount?.(layer.querySelector('.modal'), close);
  const first = layer.querySelector('input, select, button.btn-primary');
  first?.focus();
  return close;
}

/** Closes only the topmost dialog — Escape should not discard an editor below it. */
function closeTopModal() {
  const layers = document.querySelectorAll('#modalHost .modal-layer');
  layers[layers.length - 1]?.remove();
}

/* Builds a date + time picker with repeat rules. mode 'alarm' arms an alarm,
   mode 'due' just resolves a local time and hands it to onPick (task due dates). */
/* "07:15", "7:15pm", "19:15", "7.15", "7" all resolve; anything else returns null so
   a half-typed value never clobbers the current time. */
function parseTime(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[．．:：]/g, ':');
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?(am|pm)?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3];
  if (hh > 23 || mm > 59) return null;
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (ap && hh > 23) return null;
  return { hh, mm };
}

function openAlarmPicker({ alarm = null, presetAt = null, tasks = [], mode = 'alarm', onPick = null, title = null, cta = null, presetTaskId = null } = {}) {
  const base = alarm ? new Date(alarm.fireAt * 1000) : new Date((presetAt ?? Math.floor(Date.now() / 1000) + HOUR) * 1000);
  const pick = {
    y: base.getFullYear(), m: base.getMonth(), d: base.getDate(),
    hh: base.getHours(), mm: Math.round(base.getMinutes() / 5) * 5 % 60,
    repeat: alarm?.repeat || 'none',
    days: new Set(alarm?.days?.length ? alarm.days : [(new Date().getDay() + 6) % 7]),
    snooze: alarm?.snoozeMin ?? Number(S.settings.default_snooze ?? 5),
    sound: alarm?.sound || 'chime',
    label: alarm?.label || '',
    taskId: alarm?.taskId ?? presetTaskId ?? null,
    advanceMin: alarm?.advanceMin ?? 0,
    maxSnoozes: alarm?.maxSnoozes ?? 0,
    escalate: !!alarm?.escalate,
  };
  // The dial points at hours first, then minutes, which keeps one hand unambiguous.
  let dialMode = 'hour';

  const renderCal = () => {
    const first = new Date(pick.y, pick.m, 1);
    const lead = (first.getDay() + 6) % 7;
    const dim = new Date(pick.y, pick.m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) {
      const d = new Date(pick.y, pick.m, 0 - (lead - 1 - i));
      cells.push(`<button class="dtp-cell is-out" data-d="${d.getDate()}" data-mo="${d.getMonth()}" data-y="${d.getFullYear()}">${d.getDate()}</button>`);
    }
    for (let d = 1; d <= dim; d++) {
      const isToday = pick.y === new Date().getFullYear() && pick.m === new Date().getMonth() && d === new Date().getDate();
      cells.push(`<button class="dtp-cell ${isToday ? 'is-today' : ''} ${d === pick.d ? 'is-sel' : ''}" data-d="${d}" data-mo="${pick.m}" data-y="${pick.y}">${d}</button>`);
    }
    return `<div class="dtp-cal">
      <div class="card-row" style="padding:0 4px 6px">
        <button class="icon-btn" data-mo="-1" title="Previous month">‹</button>
        <b class="mono" style="font-size:12px">${first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</b>
        <button class="icon-btn" data-mo="1" title="Next month">›</button>
      </div>
      <div class="dtp-grid">${DOW.map((x) => `<span class="dtp-dow">${x}</span>`).join('')}</div>
      <div class="dtp-grid">${cells.join('')}</div>
    </div>`;
  };

  /* Analogue face, drawn once: paintDial() moves the hand afterwards so a drag
     never replaces the element under the pointer. */
  const renderDial = () => {
    const R = 66, CX = 80, CY = 80;
    const ticks = [];
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
      const r1 = R - (major ? 9 : 4);
      ticks.push(`<line x1="${(CX + Math.cos(a) * r1).toFixed(1)}" y1="${(CY + Math.sin(a) * r1).toFixed(1)}"
        x2="${(CX + Math.cos(a) * R).toFixed(1)}" y2="${(CY + Math.sin(a) * R).toFixed(1)}"
        class="dial-tick${major ? ' is-major' : ''}" />`);
    }
    const nums = [];
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      nums.push(`<text x="${(CX + Math.cos(a) * (R - 21)).toFixed(1)}" y="${(CY + Math.sin(a) * (R - 21) + 3.5).toFixed(1)}"
        class="dial-num" data-h="${i}">${i}</text>`);
    }
    return `<div class="dial" data-dial role="img" aria-label="Clock face" title="Point or drag to set the time">
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <circle cx="${CX}" cy="${CY}" r="${R}" class="dial-face" />
        ${ticks.join('')}${nums.join('')}
        <line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - R + 12}" class="dial-hand" />
        <circle cx="${CX}" cy="${CY}" r="3.5" class="dial-pin" />
        <circle cx="${CX}" cy="${CY - R + 12}" r="7" class="dial-knob" />
      </svg>
      <div class="dial-readout mono" data-dialreadout>${pad(pick.hh)}:${pad(pick.mm)}</div>
      <button class="btn btn-tiny dial-swap" data-dialmode>
        <span class="mi">rotate_right</span><span data-dialmode-label>set minutes</span>
      </button>
    </div>`;
  };

  const extras = mode === 'alarm' ? `
      <div class="stack">
        <label class="field-label" for="apLabel">Alarm label</label>
        <input id="apLabel" type="text" placeholder="Standup sync" value="${esc(pick.label)}" maxlength="120" />
      </div>` : '';

  const tail = mode === 'alarm' ? `
      <div class="grid-2">
        <div class="stack">
          <label class="field-label">Repeat</label>
          <div class="chips">${Object.entries(REPEATS).map(([k, v]) =>
            `<button class="chip ${pick.repeat === k ? 'is-on' : ''}" data-repeat="${k}">${v}</button>`).join('')}</div>
        </div>
        <div class="stack" data-dayswrap>
          <label class="field-label">Days</label>
          <div class="chips">${DOW.map((d, i) =>
            `<button class="chip wd ${pick.days.has(i) ? 'is-on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="stack">
          <label class="field-label">Snooze</label>
          <div class="chips">${[5, 10, 15, 30].map((m) =>
            `<button class="chip ${pick.snooze === m ? 'is-on' : ''}" data-snooze="${m}">${m} min</button>`).join('')}</div>
        </div>
        <div class="stack">
          <label class="field-label">Alert sound</label>
          <select data-sound>${Object.entries(SOUNDS).map(([k, v]) =>
            `<option value="${k}" ${pick.sound === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
      </div>
      <div class="stack">
        <label class="field-label">Link to task (optional)</label>
        <select data-task>
          <option value="">— none —</option>
          ${tasks.map((t) => `<option value="${t.id}" ${pick.taskId === t.id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}
        </select>
      </div>
      <div class="grid-2">
        <div class="stack">
          <label class="field-label">Advance warning</label>
          <div class="chips">${[0, 10, 20, 30, 60].map((m) =>
            `<button class="chip ${pick.advanceMin === m ? 'is-on' : ''}" data-advance="${m}">${m === 0 ? 'off' : `${m}m`}</button>`).join('')}</div>
          <div class="hint mono">Fires this many minutes before the linked task's due time.</div>
        </div>
        <div class="stack">
          <label class="field-label">Snooze budget</label>
          <div class="chips">${[0, 2, 3, 5].map((m) =>
            `<button class="chip ${pick.maxSnoozes === m ? 'is-on' : ''}" data-maxsnooze="${m}">${m === 0 ? 'unlimited' : `${m} max`}</button>`).join('')}</div>
          <div class="opt-row" style="border-top:0;padding-top:4px">
            <div><div class="opt-t">Escalate</div><div class="opt-d">Re-arm automatically instead of dismissing.</div></div>
            <button class="switch ${pick.escalate ? 'is-on' : ''}" data-escalate role="switch" aria-checked="${pick.escalate}"></button>
          </div>
        </div>
      </div>` : '';

  const html = `
    <div class="modal-head">
      <div>
        <div class="modal-title">${esc(title ?? (mode === 'due' ? 'Pick date & time' : (alarm ? 'Edit alarm' : 'Schedule alarm')))}</div>
        <div class="hint mono" data-summary></div>
      </div>
      <button class="icon-btn" data-close-modal><span class="mi">close</span></button>
    </div>
    <div class="modal-body">
      ${extras}
      <div class="dtp">
        ${renderCal()}
        <div class="time-wheel">
          ${renderDial()}
          <div class="stack">
            <label class="field-label" for="apTime">Time</label>
            <input id="apTime" type="text" data-timeinput inputmode="numeric" autocomplete="off"
                   placeholder="07:15 · 7:15pm · 19:15" value="${pad(pick.hh)}:${pad(pick.mm)}" maxlength="8" />
            <div class="hint mono">Type it, or point at the clock. ↑/↓ steps a minute, Shift+↑/↓ steps 15.</div>
          </div>
          <div class="grid-2">
            <div class="stack">
              <label class="field-label">Hour</label>
              <div class="stepper">
                <button class="btn btn-tiny" data-hh="-1" aria-label="Hour before">−</button>
                <div><div class="stepper-val" data-hhval>${pad(pick.hh)}</div><div class="stepper-l">24h</div></div>
                <button class="btn btn-tiny" data-hh="1" aria-label="Hour after">+</button>
              </div>
            </div>
            <div class="stack">
              <label class="field-label">Minute</label>
              <div class="stepper">
                <button class="btn btn-tiny" data-mm="-5" aria-label="Minutes before">−5</button>
                <div><div class="stepper-val" data-mmval>${pad(pick.mm)}</div><div class="stepper-l">step 5m</div></div>
                <button class="btn btn-tiny" data-mm="5" aria-label="Minutes after">+5</button>
              </div>
            </div>
          </div>
          <div class="stack">
            <label class="field-label">Quick set</label>
            <div class="chips">
              <button class="chip" data-quick="15">+15m</button>
              <button class="chip" data-quick="60">+1h</button>
              <button class="chip" data-quick="1440">Tomorrow 09:00</button>
            </div>
          </div>
        </div>
      </div>
      ${tail}
    </div>
    <div class="modal-foot">
      <span class="hint mono">Local time; stored as epoch seconds.</span>
      <div style="display:flex;gap:8px">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn btn-primary" data-save><span class="mi">check</span>${esc(cta ?? (mode === 'due' ? 'Set date' : (alarm ? 'Save alarm' : 'Arm alarm')))}</button>
      </div>
    </div>`;

  openModal(html, (modal, close) => {
    const sync = () => {
      $('[data-hhval]', modal).textContent = pad(pick.hh);
      $('[data-mmval]', modal).textContent = pad(pick.mm);
      const at = epoch();
      $('[data-summary]', modal).textContent = `${hhmm(at)} · ${dayLabel(at)} · ${relLabel(at)} · ${REPEATS[pick.repeat]}`;
      const hide = pick.repeat === 'daily' || pick.repeat === 'weekdays';
      const daysWrap = $('[data-dayswrap]', modal);
      if (daysWrap) daysWrap.classList.toggle('hidden', hide);
      $$('.chip[data-day]', modal).forEach((c) => c.classList.toggle('is-on', pick.days.has(Number(c.dataset.day))));
      $$('.chip[data-repeat]', modal).forEach((c) => c.classList.toggle('is-on', c.dataset.repeat === pick.repeat));
      $$('.chip[data-snooze]', modal).forEach((c) => c.classList.toggle('is-on', Number(c.dataset.snooze) === pick.snooze));
      $$('.chip[data-advance]', modal).forEach((c) => c.classList.toggle('is-on', Number(c.dataset.advance) === pick.advanceMin));
      $$('.chip[data-maxsnooze]', modal).forEach((c) => c.classList.toggle('is-on', Number(c.dataset.maxsnooze) === pick.maxSnoozes));
      const escBtn = $('[data-escalate]', modal);
      if (escBtn) { escBtn.classList.toggle('is-on', pick.escalate); escBtn.setAttribute('aria-checked', String(pick.escalate)); }
      // Leave the field alone while it has focus, or typing "7:" would be rewritten.
      const timeInput = $('[data-timeinput]', modal);
      if (timeInput && document.activeElement !== timeInput) {
        timeInput.value = `${pad(pick.hh)}:${pad(pick.mm)}`;
        timeInput.classList.remove('is-bad');
      }
      paintDial();
    };
    /* Moves the hand and the readout; the face itself is drawn once so a drag is
       never interrupted by its own repaint. */
    const paintDial = () => {
      const dial = $('[data-dial]', modal);
      if (!dial) return;
      const R = 66, CX = 80, CY = 80;
      const span = dialMode === 'hour' ? 12 : 60;
      const value = dialMode === 'hour' ? (pick.hh % 12) + pick.mm / 60 : pick.mm;
      const a = (value / span) * Math.PI * 2 - Math.PI / 2;
      const x = CX + Math.cos(a) * (R - 12);
      const y = CY + Math.sin(a) * (R - 12);
      dial.classList.toggle('is-minute', dialMode === 'minute');
      const hand = $('.dial-hand', dial), knob = $('.dial-knob', dial);
      if (hand) { hand.setAttribute('x2', x.toFixed(1)); hand.setAttribute('y2', y.toFixed(1)); }
      if (knob) { knob.setAttribute('cx', x.toFixed(1)); knob.setAttribute('cy', y.toFixed(1)); }
      const shown = dialMode === 'hour' ? (pick.hh % 12 || 12) : pick.mm;
      $$('.dial-num', dial).forEach((n) => n.classList.toggle('is-sel', dialMode === 'hour' && Number(n.dataset.h) === shown));
      const readout = $('[data-dialreadout]', dial);
      if (readout) readout.textContent = `${pad(pick.hh)}:${pad(pick.mm)}`;
      const label = $('[data-dialmode-label]', dial);
      if (label) label.textContent = dialMode === 'hour' ? 'set minutes' : 'set hours';
      dial.setAttribute('aria-label', `Clock face, ${dialMode} hand at ${pad(shown)}. Point to set, or use the time field.`);
    };
    const epoch = () => Math.floor(new Date(pick.y, pick.m, pick.d, pick.hh, pick.mm, 0, 0).getTime() / 1000);
    const repaintCal = () => {
      const old = $('.dtp-cal', modal);
      const tmp = document.createElement('div');
      tmp.innerHTML = renderCal();
      old.replaceWith(tmp.firstElementChild);
      applyIcons(modal);
      bind();
      sync();
    };
    function bind() {
      $$('.dtp-cell', modal).forEach((c) => c.addEventListener('click', () => {
        pick.d = Number(c.dataset.d);
        const mo = Number(c.dataset.mo), yr = Number(c.dataset.y);
        if (mo !== pick.m) { pick.m = mo; pick.y = yr; repaintCal(); return; }
        repaintCal();
      }));
      $$('[data-mo]', modal).forEach((b) => b.addEventListener('click', () => {
        pick.m += Number(b.dataset.mo);
        if (pick.m < 0) { pick.m = 11; pick.y--; }
        if (pick.m > 11) { pick.m = 0; pick.y++; }
        const probe = new Date(pick.y, pick.m, pick.d);
        pick.d = Math.min(pick.d, new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate());
        repaintCal();
      }));
    }
    bind();

    /* Clock face: point or drag. Hours first, then it flips to minutes on release,
       which is what makes a single hand readable. */
    const dial = $('[data-dial]', modal);
    if (dial) {
      let dragging = false;
      const fromPointer = (ev) => {
        const box = dial.querySelector('svg').getBoundingClientRect();
        if (!box.width) return;
        const dx = ev.clientX - (box.left + box.width / 2);
        const dy = ev.clientY - (box.top + box.height / 2);
        if (Math.hypot(dx, dy) < box.width * 0.14) return;   // too near the pin to read an angle
        // 0 degrees at 12 o'clock, increasing clockwise.
        const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        if (dialMode === 'hour') {
          const h = Math.round(deg / 30) % 12;
          pick.hh = pick.hh >= 12 ? (h === 0 ? 12 : h + 12) : h;
        } else {
          pick.mm = Math.round(deg / 6) % 60;
        }
        sync();
      };
      dial.addEventListener('pointerdown', (ev) => {
        if (ev.target.closest('[data-dialmode]')) return;
        dragging = true;
        // A synthetic or stale pointer id throws; capturing is a convenience, not a requirement.
        try { dial.setPointerCapture?.(ev.pointerId); } catch { /* fall back to bubbling events */ }
        dial.classList.add('is-live');
        fromPointer(ev);
        ev.preventDefault();
      });
      dial.addEventListener('pointermove', (ev) => { if (dragging) fromPointer(ev); });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        dial.classList.remove('is-live');
        if (dialMode === 'hour') { dialMode = 'minute'; sync(); }
      };
      dial.addEventListener('pointerup', endDrag);
      dial.addEventListener('pointercancel', endDrag);
    }

    /* Typed time, so the keyboard stays a first-class way in. */
    const timeInput = $('[data-timeinput]', modal);
    if (timeInput) {
      timeInput.addEventListener('input', () => {
        const t = parseTime(timeInput.value);
        if (!t) {
          timeInput.classList.toggle('is-bad', timeInput.value.trim().length >= 3);
          return;
        }
        timeInput.classList.remove('is-bad');
        pick.hh = t.hh;
        pick.mm = t.mm;
        // Repaint everything except the field itself, which sync() skips while focused.
        $('[data-hhval]', modal).textContent = pad(pick.hh);
        $('[data-mmval]', modal).textContent = pad(pick.mm);
        paintDial();
        const at = epoch();
        $('[data-summary]', modal).textContent = `${hhmm(at)} · ${dayLabel(at)} · ${relLabel(at)} · ${REPEATS[pick.repeat]}`;
      });
      timeInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); $('[data-save]', modal)?.click(); return; }
        if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
        ev.preventDefault();
        const step = ev.shiftKey ? 15 : 1;
        pick.mm += ev.key === 'ArrowUp' ? step : -step;
        while (pick.mm >= 60) { pick.mm -= 60; pick.hh = (pick.hh + 1) % 24; }
        while (pick.mm < 0) { pick.mm += 60; pick.hh = (pick.hh + 23) % 24; }
        sync();
      });
      timeInput.addEventListener('blur', () => {
        timeInput.value = `${pad(pick.hh)}:${pad(pick.mm)}`;
        timeInput.classList.remove('is-bad');
      });
    }

    modal.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('[data-dialmode]')) { dialMode = dialMode === 'hour' ? 'minute' : 'hour'; sync(); return; }
      const hh = t.closest('[data-hh]'), mm = t.closest('[data-mm]');
      if (hh) { pick.hh = (pick.hh + Number(hh.dataset.hh) + 24) % 24; sync(); }
      if (mm) {
        let v = pick.mm + Number(mm.dataset.mm);
        if (v >= 60) { v -= 60; pick.hh = (pick.hh + 1) % 24; }
        if (v < 0) { v += 60; pick.hh = (pick.hh + 23) % 24; }
        pick.mm = v; sync();
      }
      const rep = t.closest('[data-repeat]');
      if (rep) { pick.repeat = rep.dataset.repeat; sync(); }
      const dy = t.closest('[data-day]');
      if (dy) {
        const i = Number(dy.dataset.day);
        pick.days.has(i) ? pick.days.delete(i) : pick.days.add(i);
        sync();
      }
      const sn = t.closest('[data-snooze]');
      if (sn) { pick.snooze = Number(sn.dataset.snooze); sync(); }
      const adv = t.closest('[data-advance]');
      if (adv) { pick.advanceMin = Number(adv.dataset.advance); sync(); }
      const ms = t.closest('[data-maxsnooze]');
      if (ms) { pick.maxSnoozes = Number(ms.dataset.maxsnooze); sync(); }
      if (t.closest('[data-escalate]')) { pick.escalate = !pick.escalate; sync(); }
      const q = t.closest('[data-quick]');
      if (q) {
        const mins = Number(q.dataset.quick);
        const d = new Date(Math.floor(Date.now() / 1000) * 1000);
        if (mins === 1440) { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
        else d.setMinutes(d.getMinutes() + mins);
        pick.y = d.getFullYear(); pick.m = d.getMonth(); pick.d = d.getDate();
        pick.hh = d.getHours(); pick.mm = Math.round(d.getMinutes() / 5) * 5 % 60;
        repaintCal();
      }
      if (t.closest('[data-save]')) save();
    });
    modal.querySelector('[data-sound]')?.addEventListener('change', (e) => { pick.sound = e.target.value; });
    modal.querySelector('[data-task]')?.addEventListener('change', (e) => { pick.taskId = e.target.value ? Number(e.target.value) : null; });
    modal.querySelector('#apLabel')?.addEventListener('input', (e) => { pick.label = e.target.value; });

    async function save() {
      if (modal.closest('.modal-layer')?.nextElementSibling) return;  // another dialog is on top
      const at = epoch();
      if (mode === 'due') {
        if (onPick) onPick(at);
        close();
        return;
      }
      if (!pick.label.trim()) {
        toast('Label required', 'Give the alarm a name so the toast is recognisable.', [], 'error');
        return;
      }
      if (pick.repeat === 'none' && at <= Math.floor(Date.now() / 1000)) {
        toast('Time is in the past', 'A one-off alarm in the past fires immediately on the next scheduler tick.', [], 'error');
      }
      const input = {
        id: alarm?.id ?? null,
        label: pick.label.trim(),
        fireAt: at,
        repeat: pick.repeat,
        days: pick.repeat === 'weekly' ? [...pick.days].sort() : [],
        snoozeMin: pick.snooze,
        sound: pick.sound,
        taskId: pick.taskId,
        advanceMin: pick.advanceMin,
        maxSnoozes: pick.maxSnoozes,
        escalate: pick.escalate,
      };
      const saved = await call('save_alarm', { input });
      if (saved) {
        close();
        toast('Alarm armed', `${saved.label} — ${hhmm(saved.fireAt)} ${dayLabel(saved.fireAt)}`, [], 'is-ok');
        await refresh();
      }
    }
    sync();
  });
}

function openTaskEditor(task = null) {
  const draft = {
    id: task?.id ?? null,
    title: task?.title ?? '',
    notes: task?.notes ?? '',
    priority: task?.priority ?? 'p3',
    status: task?.status ?? 'todo',
    dueAt: task?.dueAt ?? null,
    tags: task?.tags ?? [],
    recurrence: task?.recurrence ?? 'none',
    recurDays: task?.recurDays ?? [],
  };
  let alarmAt = task?.alarmFireAt ?? null;
  const html = `
    <div class="modal-head">
      <div class="modal-title">${task ? 'Edit task' : 'New task'}</div>
      <button class="icon-btn" data-close-modal><span class="mi">close</span></button>
    </div>
    <div class="modal-body">
      <div class="stack">
        <label class="field-label">Title</label>
        <input type="text" data-f="title" placeholder="Finalize SQLite IPC handlers" value="${esc(draft.title)}" maxlength="160" />
      </div>
      <div class="grid-3">
        <div class="stack">
          <label class="field-label">Priority</label>
          <select data-f="priority">${Object.entries(PRIORITY).map(([k, v]) =>
            `<option value="${k}" ${draft.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        </div>
        <div class="stack">
          <label class="field-label">Status</label>
          <select data-f="status">${Object.entries(STATUS).map(([k, v]) =>
            `<option value="${k}" ${draft.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <div class="stack">
          <label class="field-label">Due</label>
          <input type="text" readonly data-due value="${draft.dueAt ? `${hhmm(draft.dueAt)} ${dayLabel(draft.dueAt)}` : 'unset'}" style="cursor:pointer" />
        </div>
      </div>
      <div class="stack">
        <label class="field-label">Tags (comma separated)</label>
        <input type="text" data-f="tags" placeholder="backend, release" value="${esc(draft.tags.join(', '))}" />
      </div>
      <div class="stack">
        <label class="field-label">Notes / runbook</label>
        <textarea data-f="notes" placeholder="Verification checklist…">${esc(draft.notes)}</textarea>
      </div>
      <div class="grid-2">
        <div class="stack">
          <label class="field-label">Repeat</label>
          <div class="chips">${[['none','Once'],['daily','Daily'],['weekdays','Weekdays'],['weekly','Weekly']].map(([k, v]) =>
            `<button class="chip ${draft.recurrence === k ? 'is-on' : ''}" data-recur="${k}">${v}</button>`).join('')}</div>
        </div>
        <div class="stack" data-recurdays-wrap>
          <label class="field-label">On days (weekly)</label>
          <div class="chips">${DOW.map((d, i) =>
            `<button class="chip wd ${draft.recurDays.includes(i) ? 'is-on' : ''}" data-recurday="${i}">${d}</button>`).join('')}</div>
        </div>
      </div>
      <div class="card" style="background:var(--sc-low)">
        <div class="card-row">
          <div>
            <div class="card-title">Attach alarm</div>
            <div class="hint mono" data-alarmstate>none</div>
            <div class="hint">Opens the clock and keyboard picker; the alarm is linked to this task.</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-tiny" data-alarm-pick><span class="mi">alarm_add</span>Pick time</button>
            <button class="btn btn-tiny" data-alarm-clear><span class="mi">close</span>Clear</button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <span class="hint mono">Stored in the local SQLite tasks table.</span>
      <div style="display:flex;gap:8px">
        <button class="btn" data-close-modal>Cancel</button>
        <button class="btn btn-primary" data-save><span class="mi">check</span>Save task</button>
      </div>
    </div>`;

  openModal(html, (modal, close) => {
    // A dialog buried under another one must not act. Its buttons sit behind a scrim
    // for a pointer, but Enter and scripted clicks still reach them. A later sibling
    // layer was opened after this one, so it covers it.
    const buried = () => !!modal.closest('.modal-layer')?.nextElementSibling;
    const read = () => {
      $$('[data-f]', modal).forEach((el) => {
        const k = el.dataset.f;
        if (k === 'tags') draft.tags = el.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        else draft[k] = el.value;
      });
    };
    const syncAlarm = () => {
      $('[data-alarmstate]', modal).textContent = alarmAt ? `${hhmm(alarmAt)} · ${dayLabel(alarmAt)} · ${relLabel(alarmAt)}` : 'none';
    };
    $('[data-due]', modal).addEventListener('click', () => {
      openAlarmPicker({
        mode: 'due',
        presetAt: draft.dueAt ?? Math.floor(Date.now() / 1000) + DAY,
        onPick: (at) => {
          draft.dueAt = at;
          $('[data-due]', modal).value = `${hhmm(at)} ${dayLabel(at)}`;
        },
      });
    });
    $('[data-alarm-pick]', modal).addEventListener('click', () => {
      // Opens over this dialog instead of replacing it, so the draft survives the
      // detour. Previously this silently picked the next top of hour, which read as
      // "I cannot attach the alarm at the time I want".
      openAlarmPicker({
        mode: 'due',
        title: 'Attach alarm — pick a time',
        cta: 'Use this time',
        presetAt: alarmAt ?? Math.floor(Date.now() / 1000) + HOUR,
        onPick: (at) => { alarmAt = at; syncAlarm(); },
      });
    });
    $('[data-alarm-clear]', modal).addEventListener('click', () => { alarmAt = null; syncAlarm(); });
    const syncRecur = () => {
      $$('.chip[data-recur]', modal).forEach((c) => c.classList.toggle('is-on', c.dataset.recur === draft.recurrence));
      $$('.chip[data-recurday]', modal).forEach((c) => c.classList.toggle('is-on', draft.recurDays.includes(Number(c.dataset.recurday))));
      const wrap = $('[data-recurdays-wrap]', modal);
      if (wrap) wrap.classList.toggle('hidden', draft.recurrence !== 'weekly');
    };
    modal.addEventListener('click', (e) => {
      const r = e.target.closest('[data-recur]');
      if (r) { draft.recurrence = r.dataset.recur; syncRecur(); }
      const rd = e.target.closest('[data-recurday]');
      if (rd) {
        const i = Number(rd.dataset.recurday);
        draft.recurDays = draft.recurDays.includes(i) ? draft.recurDays.filter((x) => x !== i) : [...draft.recurDays, i].sort();
        syncRecur();
      }
    });
    syncRecur();
    modal.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-save]')) return;
      if (buried()) return;
      read();
      if (!draft.title.trim()) { toast('Title required', 'A task needs a title.', [], 'error'); return; }
      const input = {
        id: draft.id,
        title: draft.title.trim(),
        notes: draft.notes,
        priority: draft.priority,
        status: draft.status,
        dueAt: draft.dueAt,
        tags: draft.tags,
        recurrence: draft.recurrence,
        recurDays: draft.recurDays,
        parentId: task?.parentId ?? null,
      };
      const out = await call('create_task_with_alarm', {
        input,
        alarmAt,
        alarmLabel: alarmAt ? `Reminder: ${input.title}` : null,
        snoozeMin: Number(S.settings.default_snooze ?? 5),
      });
      if (out) {
        close();
        S.selectedTask = out.id;
        toast(task ? 'Task updated' : 'Task created', out.title, [], 'is-ok');
        await refresh();
      }
    });
    syncAlarm();
  });
}

/* ------------------------------------------------------------- rendering -- */

function navChrome() {
  $('#navTasks').textContent = S.stats ? S.stats.tasksTotal : '—';
  $('#navAlarms').textContent = S.stats ? `${S.stats.alarmsArmed} active` : '—';
  $('#navMissed').textContent = S.stats ? S.stats.missedUnhandled : '—';
  const now = new Date();
  const onejan = new Date(now.getFullYear(), 0, 1);
  $('#navWeek').textContent = `W${Math.ceil((((now - onejan) / 86400000) + onejan.getDay() + 1) / 7)}`;
  $('#appVersion').textContent = `v${S.info?.version ?? '2.4.1'}`;
}

function metricsBar() {
  const st = S.stats || { dueToday: 0, overdue: 0, alarmsArmed: 0 };
  return `<div class="metrics">
    <div class="metric"><span class="metric-k">Due Today</span>
      <span class="metric-row"><span class="metric-v">${pad(st.dueToday)}</span><span class="mi mi-accent" style="color:var(--primary)">calendar_clock</span></span></div>
    <div class="metric is-error"><span class="metric-k">Overdue</span>
      <span class="metric-row"><span class="metric-v">${pad(st.overdue)}</span><span class="mi" style="color:var(--error)">warning</span></span></div>
    <div class="metric is-mint"><span class="metric-k">Alarms Set</span>
      <span class="metric-row"><span class="metric-v">${pad(st.alarmsArmed)}</span><span class="mi" style="color:var(--tertiary)">alarm</span></span></div>
  </div>`;
}

function taskRow(t) {
  const due = dueLabel(t.dueAt);
  const late = t.dueAt && t.dueAt < Date.now() / 1000 && t.status !== 'done';
  const pill = t.alarmFireAt
    ? `<span class="alarm-pill ${late ? 'is-missed' : 'is-hot'}"><span class="mi">${late ? 'alarm_off' : 'alarm'}</span>${hhmm(t.alarmFireAt)} ${dayLabel(t.alarmFireAt)}</span>`
    : `<span class="alarm-pill is-none">No Alarm</span>`;
  return `<article class="row ${S.selectedTask === t.id ? 'is-selected' : ''} ${t.status === 'done' ? 'is-done' : ''}" data-task="${t.id}" tabindex="0">
    <input type="checkbox" class="row-check" data-toggle="${t.id}" ${t.status === 'done' ? 'checked' : ''} aria-label="Complete ${esc(t.title)}" />
    <div class="row-main">
      <span class="row-title">${esc(t.title)}</span>
      <div class="tags">
        ${t.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}
        <span class="tag ${PRIORITY[t.priority]?.cls || 'tag-p3'}">${esc(PRIORITY[t.priority]?.label || t.priority)}</span>
        ${t.subtaskTotal ? `<span class="tag">${t.subtaskDone}/${t.subtaskTotal}</span>` : ''}
        ${t.recurrence && t.recurrence !== 'none' ? `<span class="tag" style="color:var(--primary);border-color:var(--primary-container)">${esc(recurrenceLabel(t))}</span>` : ''}
      </div>
    </div>
    <div class="row-side">
      <span class="due ${due.cls}">${t.dueAt ? `${hhmm(t.dueAt)} ${dayLabel(t.dueAt)}` : '—'}</span>
      ${pill}
    </div>
  </article>`;
}

function inspector(t) {
  if (!t) {
    return `<div class="pane"><div class="empty"><span class="mi">check_circle</span>
      <div class="empty-t">No task selected</div>
      <div class="hint">Pick a row on the left, or press <kbd>Ctrl</kbd><kbd>N</kbd> to create one.</div></div></div>`;
  }
  const subs = t.subtasks || [];
  const pct = t.subtaskTotal ? Math.round((t.subtaskDone / t.subtaskTotal) * 100) : 0;
  return `<div class="pane inspector">
    <div class="insp-strip">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="insp-id">TASK-${String(t.id).padStart(4, '0')}</span>
        <span class="hint mono">${STATUS[t.status] ?? t.status}</span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-tiny" data-edit="${t.id}"><span class="mi">edit</span>Edit</button>
        <button class="btn btn-tiny btn-danger" data-del="${t.id}"><span class="mi">delete</span>Delete</button>
      </div>
    </div>

    <div class="stack">
      <input class="title-input" type="text" value="${esc(t.title)}" data-title="${t.id}" aria-label="Task title" />
      <div class="hint mono">Created ${clockLabel(t.createdAt)} · updated ${relLabel(t.updatedAt)}</div>
    </div>

    <div class="meta-3">
      <div class="stack">
        <span class="field-label">Status State</span>
        <div class="seg" style="background:var(--sc-lowest)">${Object.entries(STATUS).map(([k, v]) =>
          `<button data-status="${k}" class="${t.status === k ? 'is-active' : ''}" style="flex:1;justify-content:center">${v.split(' ')[0]}</button>`).join('')}</div>
      </div>
      <div class="stack">
        <span class="field-label">Urgency Priority</span>
        <select data-priority="${t.id}">${Object.entries(PRIORITY).map(([k, v]) =>
          `<option value="${k}" ${t.priority === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      </div>
      <div class="stack">
        <span class="field-label">Target Milestone</span>
        <button class="btn" data-pickdue="${t.id}" style="justify-content:space-between">
          <span style="display:flex;gap:6px;align-items:center"><span class="mi" style="color:var(--primary)">event</span>
          <span class="mono">${t.dueAt ? `${hhmm(t.dueAt)} ${dayLabel(t.dueAt)}` : 'unset'}</span></span>
          <span class="hint mono">${t.dueAt ? relLabel(t.dueAt) : ''}</span>
        </button>
      </div>
    </div>

    <div class="card is-alarm">
      <div class="card-row">
        <div style="display:flex;gap:10px;align-items:center">
          <div class="icon-sq"><span class="mi">notifications_active</span></div>
          <div>
            <div style="display:flex;gap:8px;align-items:center">
              <span class="card-title">Attached Alarm</span>
              ${t.alarmId ? `<span class="tag" style="background:color-mix(in srgb,var(--tertiary-container) 45%,transparent);color:var(--tertiary)">Trigger Armed</span>` : ''}
            </div>
            <div class="card-sub ${t.alarmId ? '' : 'is-ok'}">${t.alarmId
              ? `Scheduled for ${dayLabel(t.alarmFireAt)} at ${hhmm(t.alarmFireAt)} (${relLabel(t.alarmFireAt)})`
              : 'No alarm attached to this task'}</div>
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-tiny" data-testalarm="${t.alarmId ?? ''}" ${t.alarmId ? '' : 'disabled'}><span class="mi">play_arrow</span>Test</button>
          ${t.alarmId
            ? `<button class="btn btn-tiny btn-danger" data-alarmdel="${t.alarmId}"><span class="mi">alarm_off</span>Detach</button>`
            : `<button class="btn btn-tiny" data-alarmnew="${t.id}"><span class="mi">alarm_add</span>Attach</button>`}
        </div>
      </div>
      ${t.alarmId ? `<div class="grid-2">
        <div class="stack">
          <span class="field-label">Default Snooze Period</span>
          <div class="chips">${[5, 10, 15, 30].map((m) =>
            `<button class="chip ${t.alarmSnooze === m ? 'is-on' : ''}" data-snoozeSet="${m}">${m} min</button>`).join('')}</div>
        </div>
        <div class="stack">
          <span class="field-label">Alert Sound Profile</span>
          <select data-soundSet="${t.alarmId}">${Object.entries(SOUNDS).map(([k, v]) =>
            `<option value="${k}" ${t.alarmSound === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
      </div>` : ''}
    </div>

    <div class="stack">
      <div class="card-row">
        <span class="field-label" style="margin:0">Task Specification &amp; Runbook</span>
        <span class="hint mono">auto-saved to local DB</span>
      </div>
      <textarea data-notes="${t.id}" placeholder="Verification checklist before build…">${esc(t.notes)}</textarea>
    </div>

    <div class="stack">
      <div class="card-row">
        <span class="field-label" style="margin:0">Sub-routines &amp; Verification (${t.subtaskDone}/${t.subtaskTotal})</span>
        <span class="hint mono" style="color:var(--tertiary)">${pct}% complete</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div>
        ${subs.map((s) => `<div class="sub-row ${s.done ? 'is-done' : ''}">
          <input type="checkbox" class="row-check" data-sub="${s.id}" ${s.done ? 'checked' : ''} />
          <span>${esc(s.title)}</span>
          <button class="icon-btn" data-subdel="${s.id}" style="width:20px;height:20px"><span class="mi" style="font-size:12px">close</span></button>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:6px">
        <input type="text" data-newsub="${t.id}" placeholder="Add a verification step…" style="flex:1" />
        <button class="btn" data-subadd="${t.id}"><span class="mi">add</span>Add</button>
      </div>
    </div>
  </div>`;
}

function viewTasks() {
  const counts = {
    all: S.tasks.length,
    today: S.tasks.filter((t) => t.dueAt && dayStart(t.dueAt) === TODAY0() && t.status !== 'done').length,
    high: S.tasks.filter((t) => ['p1', 'p2'].includes(t.priority) && t.status !== 'done').length,
    completed: S.tasks.filter((t) => t.status === 'done').length,
  };
  const sel = S.tasks.find((t) => t.id === S.selectedTask) || null;
  return `<div class="view split-5-7">
    <section class="pane" style="background:var(--sc-lowest)">
      ${metricsBar()}
      <div class="filterbar">
        <div class="seg">${[['all', 'All Tasks'], ['today', 'Today'], ['high', 'High Priority'], ['completed', 'Completed']].map(([k, label]) =>
          `<button data-filter="${k}" class="${S.filter === k ? 'is-active' : ''}">${label}<span class="count">${counts[k]}</span></button>`).join('')}</div>
        <button class="icon-btn" data-newtask title="New task"><span class="mi">add_task</span></button>
      </div>
      <div class="filterbar" style="padding-top:0">
        <input type="search" data-search placeholder="Filter by title, note or tag…" value="${esc(S.query)}" style="height:28px" />
      </div>
      <div class="pane-body"><div class="rows">
        ${S.tasks.length ? S.tasks.map(taskRow).join('') : `<div class="empty"><span class="mi">search_off</span><div class="empty-t">Nothing matches</div><div class="hint">Clear the filter or add a task.</div></div>`}
      </div></div>
      <div class="pane-foot">
        <div class="hint mono"><kbd>J</kbd><kbd>K</kbd> navigate · <kbd>X</kbd> toggle · <kbd>1</kbd>–<kbd>5</kbd> views · <kbd>Ctrl</kbd><kbd>K</kbd> palette</div>
        <span class="hint mono">Local scheduler · 1s tick</span>
      </div>
    </section>
    ${inspector(sel)}
  </div>`;
}

function viewAlarms() {
  const armed = S.alarms.filter((a) => a.state === 'armed');
  const other = S.alarms.filter((a) => a.state !== 'armed');
  const card = (a) => {
    const overdueOneOff = a.state === 'armed' && a.nextFireAt != null && a.nextFireAt < Date.now() / 1000;
    return `<div class="alarm-card ${a.state === 'paused' ? 'is-paused' : ''}">
      <div class="card-row">
        <div class="stack" style="gap:0">
          <span class="alarm-time">${hhmm(a.fireAt)}</span>
          <span class="alarm-when">${a.nextFireAt ? `${dayLabel(a.nextFireAt)} · ${relLabel(a.nextFireAt)}` : 'not scheduled'}</span>
        </div>
        <button class="switch ${a.state === 'armed' ? 'is-on' : ''}" data-alarmtoggle="${a.id}" role="switch"
          aria-checked="${a.state === 'armed'}" title="${a.state === 'armed' ? 'Pause' : 'Resume'}"></button>
      </div>
      <div>
        <div class="card-title">${esc(a.label)}</div>
        <div class="hint mono">${REPEATS[a.repeat] ?? a.repeat}${a.repeat === 'weekly' && a.days?.length ? ` · ${a.days.map((d) => DOW[d]).join(' ')}` : ''} · snooze ${a.snoozeMin}m · ${SOUNDS[a.sound] ?? a.sound}</div>
        <div class="hint mono">${a.advanceMin ? `<span style="color:var(--primary)">warns ${a.advanceMin}m early</span> · ` : ''}<span>snoozed ${a.snoozeCount ?? 0}${a.maxSnoozes ? ` of ${a.maxSnoozes}` : ' (unlimited)'}</span>${a.escalate ? ' · <span style="color:var(--secondary)">escalating</span>' : ''}</div>
        ${a.taskTitle ? `<div class="hint mono" style="color:var(--primary)">↳ ${esc(a.taskTitle)}</div>` : ''}
        ${overdueOneOff ? `<div class="hint mono" style="color:var(--error)">due ${relLabel(a.nextFireAt)} — firing on next tick</div>` : ''}
        ${a.state === 'dismissed' ? `<div class="hint mono" style="color:var(--outline)">fired · dismissed</div>` : ''}
      </div>
      <div class="card-row">
        <div style="display:flex;gap:6px">
          <button class="btn btn-tiny" data-alarmsnooze="${a.id}"><span class="mi">snooze</span>+${a.snoozeMin}m</button>
          <button class="btn btn-tiny" data-alarmtest="${a.id}"><span class="mi">play_arrow</span>Test</button>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-tiny" data-alarmedit="${a.id}"><span class="mi">edit</span></button>
          <button class="btn btn-tiny btn-danger" data-alarmdel="${a.id}"><span class="mi">close</span></button>
        </div>
      </div>
    </div>`;
  };
  return `<div class="view view-single">
    <div class="pane-head" style="background:var(--sc-lowest)">
      <div>
        <div class="pane-title">Alarms &amp; Timers</div>
        <div class="hint mono">${armed.length} armed · ${S.alarms.length} total · scheduler ticks once per second</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn" data-timertest><span class="mi">bolt</span>Fire demo in 3s</button>
        <button class="btn btn-primary" data-newalarm><span class="mi">alarm_add</span>New Alarm</button>
      </div>
    </div>
    ${metricsBar()}
    ${S.alarms.length ? `<div class="alarm-grid">${[...armed, ...other].map(card).join('')}</div>`
      : `<div class="empty"><span class="mi">alarm</span><div class="empty-t">No alarms yet</div>
          <div class="hint">Arm one and DJ Task Manager raises a native Windows toast at the scheduled second.</div>
          <button class="btn btn-primary" data-newalarm style="margin-top:8px"><span class="mi">alarm_add</span>New Alarm</button></div>`}
  </div>`;
}

function viewCalendar() {
  const cur = S.calCursor;
  const first = new Date(cur.y, cur.m, 1);
  const lead = (first.getDay() + 6) % 7;
  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const byDay = new Map();
  for (const ev of S.calEvents) {
    const k = dayStart(ev.at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(ev);
  }
  const cells = [];
  for (let i = 0; i < lead; i++) {
    const d = new Date(cur.y, cur.m, 0 - (lead - 1 - i));
    cells.push({ date: d, out: true });
  }
  for (let d = 1; d <= dim; d++) cells.push({ date: new Date(cur.y, cur.m, d), out: false });
  while (cells.length % 7) {
    const last = cells[cells.length - 1].date;
    cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), out: true });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const selKey = S.calDay;
  const dayEvents = (byDay.get(selKey) || []).slice().sort((a, b) => a.at - b.at);

  const timeline = [];
  for (let h = 0; h < 24; h++) {
    const items = dayEvents.filter((e) => new Date(e.at * 1000).getHours() === h);
    timeline.push(`<div class="tl-hour ${selKey === dayStart(nowSec) && new Date().getHours() === h ? 'tl-now' : ''}">
      <span class="tl-h">${pad(h)}:00</span>
      <div class="tl-items">${items.map((e) => {
        const late = e.kind === 'alarm' ? false : (e.at < nowSec && e.status !== 'done');
        const cls = e.kind === 'alarm' ? 'is-alarm' : (late ? 'is-late' : '');
        return `<div class="tl-item ${cls}" title="${esc(e.title)}">${hhmm(e.at)} · ${esc(e.title)}</div>`;
      }).join('')}</div>
    </div>`);
  }

  return `<div class="view cal">
    <div class="cal-grid">
      <div class="card-row">
        <div>
          <div class="pane-title">Calendar View</div>
          <div class="modal-title" style="font-size:24px">${first.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn btn-tiny" data-cal="-1">◀</button>
          <button class="btn btn-tiny" data-cal-today>Today</button>
          <button class="btn btn-tiny" data-cal="1">▶</button>
        </div>
      </div>
      <div class="cal-head">${DOW.map((d) => `<span class="cal-dow">${d}</span>`).join('')}</div>
      <div class="cal-days">${cells.map((c) => {
        const key = Math.floor(new Date(c.date.getFullYear(), c.date.getMonth(), c.date.getDate()).getTime() / 1000);
        const evs = byDay.get(key) || [];
        const isToday = key === TODAY0();
        return `<button class="cal-cell ${c.out ? 'is-out' : ''} ${isToday ? 'is-today' : ''} ${key === selKey ? 'is-sel' : ''}" data-day="${key}">
          <span class="cal-daynum">${c.date.getDate()}</span>
          ${evs.slice(0, 2).map((e) => `<span class="cal-mini">${hhmm(e.at)} ${esc(e.title.slice(0, 18))}</span>`).join('')}
          <span class="cal-dots">
            ${evs.slice(0, 8).map((e) => `<span class="cdot ${e.kind === 'alarm' ? 'cdot-alarm' : (e.at < nowSec && e.status !== 'done' ? 'cdot-late' : 'cdot-task')}"></span>`).join('')}
          </span>
        </button>`;
      }).join('')}</div>
      <div class="hint mono">Legend: <span style="color:var(--primary)">■</span> task · <span style="color:var(--tertiary)">■</span> alarm · <span style="color:var(--error)">■</span> overdue · ${S.calEvents.length} events in view</div>
    </div>
    <div class="timeline">
      <div style="padding:var(--sp-md) var(--sp-lg);border-bottom:1px solid var(--outline-variant)">
        <div class="pane-title">${selKey ? dayLabel(selKey) : '—'}</div>
        <div class="hint mono">${dayEvents.length} scheduled item${dayEvents.length === 1 ? '' : 's'}</div>
      </div>
      ${timeline.join('')}
    </div>
  </div>`;
}

function viewMissed() {
  const rows = S.missed.filter((m) => (S.showResolved ? true : m.resolution === 'unhandled'));
  const open = S.missed.filter((m) => m.resolution === 'unhandled').length;
  return `<div class="view view-single">
    <div class="pane-head" style="background:var(--sc-lowest)">
      <div>
        <div class="pane-title">Missed Alarms &amp; Catch-up Log</div>
        <div class="hint mono">${open} unhandled · entries appear when an alarm's time passed by more than 90 seconds</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn" data-toggleResolved>${S.showResolved ? 'Show open only' : 'Show all'}</button>
        <button class="btn" data-catchupall><span class="mi">snooze</span>Snooze all +10m</button>
        <button class="btn btn-danger" data-clearmissed><span class="mi">check</span>Clear unhandled</button>
      </div>
    </div>
    ${metricsBar()}
    ${rows.length ? `<div class="log">${rows.map((m) => {
      const handled = m.resolution !== 'unhandled';
      return `<div class="log-item ${handled ? 'is-handled' : ''}">
        <div class="icon-sq ${handled ? 'is-mint' : ''}" style="${handled ? '' : 'background:color-mix(in srgb,var(--error-container) 45%,transparent);color:var(--error)'}">
          <span class="mi">${handled ? 'done_all' : 'notification_important'}</span></div>
        <div>
          <div class="log-t">${esc(m.label)}</div>
          <div class="log-m">was due ${clockLabel(m.dueAt)} (${relLabel(m.dueAt)}) · detected ${relLabel(m.detectedAt)}
            ${m.resolvedAt ? ` · ${m.resolution} ${relLabel(m.resolvedAt)}` : ''}</div>
        </div>
        <div class="log-actions">
          <span class="src ${m.source === 'runtime' ? 'is-runtime' : (handled ? 'is-handled' : '')}">${m.source === 'offline' ? 'missed offline' : m.source}</span>
          ${handled ? '' : `
            <button class="btn btn-tiny" data-missnooze="${m.id}" data-alarm="${m.alarmId ?? ''}"><span class="mi">snooze</span>Snooze</button>
            <button class="btn btn-tiny" data-missack="${m.id}"><span class="mi">done</span>Ack</button>
            <button class="btn btn-tiny btn-danger" data-missdis="${m.id}"><span class="mi">close</span>Dismiss</button>`}
        </div>
      </div>`;
    }).join('')}</div>`
    : `<div class="empty"><span class="mi">done_all</span>
        <div class="empty-t">Catch-up log is clear</div>
        <div class="hint">Nothing slipped past the scheduler. Alarms that fire while the window is hidden still land here.</div></div>`}
  </div>`;
}

function viewSettings() {
  const st = S.storage || {};
  const rows = Object.entries(st.rowCounts || {});
  const bytes = (n) => n > 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
  const toggle = (key, label, desc) => `<div class="opt-row">
    <div><div class="opt-t">${label}</div><div class="opt-d">${desc}</div></div>
    <button class="switch ${S.settings[key] !== 'false' ? 'is-on' : ''}" data-setting="${key}" role="switch" aria-checked="${S.settings[key] !== 'false'}"></button>
  </div>`;
  const a = S.autostart;
  const autostartNote = !a ? 'Checking…'
    : !a.enabled ? 'Off — alarms only fire while the app is running'
    : a.registered ? 'Registered in Windows startup'
    : 'On — re-registered on every launch';
  return `<div class="view view-single">
    <div class="pane-head" style="background:var(--sc-lowest)">
      <div>
        <div class="pane-title">Settings &amp; Storage Architecture</div>
        <div class="hint mono">SQLite ${st.journalMode || '—'} journal · WAL sidecar · single-writer mutex in Rust</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn" data-export><span class="mi">download</span>Export JSON</button>
        <button class="btn" data-import><span class="mi">upload</span>Import</button>
        <button class="btn" data-vacuum><span class="mi">refresh</span>VACUUM</button>
      </div>
    </div>
    <div class="settings">
      <div class="s-block">
        <h3>Storage Engine</h3>
        <dl class="kv">
          <dt>Database</dt><dd>${esc(st.path ?? '—')}</dd>
          <dt>Data dir</dt><dd>${esc(st.dir ?? '—')}</dd>
          <dt>Main file</dt><dd>${st.bytes ? bytes(st.bytes) : '—'} (${st.pageCount ?? 0} × ${st.pageSize ?? 0} B pages)</dd>
          <dt>WAL sidecar</dt><dd>${st.walBytes ? bytes(st.walBytes) : '0 B'} · shm ${st.shmBytes ? bytes(st.shmBytes) : '0 B'}</dd>
          <dt>Journal mode</dt><dd>${esc(st.journalMode ?? '—')} · synchronous=NORMAL · foreign_keys=ON</dd>
          <dt>Platform</dt><dd>${esc(S.info?.platform ?? '—')} · IPC over tauri::command</dd>
        </dl>
        <div class="hint mono">next_fire() is a Rust scalar function registered on the connection, so SQL and the scheduler thread share one rule.</div>
      </div>

      <div class="s-block">
        <h3>Schema &amp; Row Counts</h3>
        ${rows.map(([t, n]) => `<div class="rowcount"><span>${t}</span><b>${n}</b></div>`).join('')}
        <div class="schema">tasks(id, title, notes, priority, status,
      due_at, tags, created_at, updated_at,
      recurrence, recur_days, parent_id,
      completed_at, archived)
subtasks(id, task_id → tasks, title, done)
alarms(id, label, fire_at, repeat, days,
       snooze_min, sound, state, task_id,
       last_fired_at, created_at, advance_min,
       snooze_count, max_snoozes, escalate,
       last_preflight_for)
missed_alarms(id, alarm_id, label, due_at,
              detected_at, source, resolution, resolved_at)
alarm_history(id, alarm_id, label, event,
              due_at, at, note)
activity_log(id, task_id, kind, summary, at)
schema_history(version PK, name, applied_at)
settings(key PK, value)
tasks_fts(title, notes, tags) — FTS5, trigger-synced</div>
      </div>

      <div class="s-block">
        <h3>Notifications &amp; Scheduling</h3>
        ${toggle('native_toasts', 'Native OS toasts', 'Windows notification centre alongside the in-app banner.')}
        ${toggle('catch_up', 'Catch-up on launch', 'Log alarms whose time passed while the app was closed.')}
        <div class="opt-row">
          <div><div class="opt-t">Default snooze</div><div class="opt-d">Minutes applied to new alarms and quick snoozes.</div></div>
          <select data-snoozedefault style="width:110px">${[5, 10, 15, 30].map((m) =>
            `<option value="${m}" ${Number(S.settings.default_snooze) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select>
        </div>
        <div class="opt-row">
          <div><div class="opt-t">Send a test toast</div><div class="opt-d">Exercises the real notification path from Rust.</div></div>
          <button class="btn btn-tiny" data-toast-test><span class="mi">notifications</span>Test</button>
        </div>
      </div>

      <div class="s-block">
        <h3>Appearance</h3>
        <div class="opt-row">
          <div><div class="opt-t">Theme</div><div class="opt-d">Dark is the Material 3 baseline from the design.</div></div>
          <div class="seg"><button data-theme="dark" class="${!document.documentElement.classList.contains('light') ? 'is-active' : ''}">Dark</button>
          <button data-theme="light" class="${document.documentElement.classList.contains('light') ? 'is-active' : ''}">Light</button></div>
        </div>
        ${toggle('compact_rows', 'Compact rows', 'Tighter task and alarm cards.')}
        <div class="hint mono">Scheduler uptime ${S.info ? relLabel(S.info.startedAt).replace(' ago', '') : '—'} · worst tick lateness ±${(S.driftMs / 1000).toFixed(2)}s</div>
      </div>

      <div class="s-block">
        <h3>Database Health &amp; Analytics</h3>
        <div class="card-row">
          <div class="hint mono">schema v${S.schema?.userVersion ?? '—'} of ${S.schema?.targetVersion ?? '—'} · ${S.schema?.upToDate ? 'migrations current' : 'migrations pending'} · FTS5 ${S.schema?.fts5 ? 'on' : 'off'}</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-tiny" data-integrity><span class="mi">visibility</span>Integrity</button>
            <button class="btn btn-tiny" data-checkpoint><span class="mi">save</span>Checkpoint</button>
            <button class="btn btn-tiny" data-backup><span class="mi">download</span>Backup .db</button>
          </div>
        </div>
        ${S.health ? `<div class="hint mono" style="color:${S.health.ok ? 'var(--tertiary)' : 'var(--error)'}">${esc(S.health.message)}</div>` : ''}
        <div class="grid-2">
          <div class="stack">
            <span class="field-label">On-time completion</span>
            <div class="metric-v" style="font-size:26px">${S.analytics?.onTime?.rate ?? 0}%</div>
            <div class="hint mono">${S.analytics?.onTime?.onTime ?? 0} of ${S.analytics?.onTime?.total ?? 0} finished by their deadline</div>
          </div>
          <div class="stack">
            <span class="field-label">Alarm delivery (${S.analytics?.windowDays ?? 14}d)</span>
            <div class="rowcount"><span>fired</span><b>${S.analytics?.alarmEvents?.fired ?? 0}</b></div>
            <div class="rowcount"><span>missed</span><b style="color:var(--error)">${S.analytics?.alarmEvents?.missed ?? 0}</b></div>
            <div class="rowcount"><span>advance warnings</span><b>${S.analytics?.alarmEvents?.preflight ?? 0}</b></div>
          </div>
        </div>
        <div class="stack">
          <span class="field-label">Completions per day</span>
          <div style="display:flex;align-items:flex-end;gap:3px;height:56px">${sparkline()}</div>
        </div>
        <div class="card-row">
          <span class="field-label" style="margin:0">Recent activity</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-tiny" data-csv="tasks"><span class="mi">download</span>tasks.csv</button>
            <button class="btn btn-tiny" data-csv="alarms"><span class="mi">download</span>alarms.csv</button>
            <button class="btn btn-tiny" data-prune><span class="mi">refresh</span>Prune 90d</button>
          </div>
        </div>
        <div>${activityFeed()}</div>
      </div>

      <div class="s-block">
        <h3>Background &amp; Startup</h3>
        <div class="opt-row">
          <div><div class="opt-t">Launch at sign-in</div><div class="opt-d">${autostartNote} · ${esc(a?.exePath ?? '')}</div></div>
          <button class="switch ${a?.enabled ? 'is-on' : ''}" data-autostart role="switch" aria-checked="${!!a?.enabled}"></button>
        </div>
        ${toggle('start_hidden', 'Start hidden in the tray', 'Opens with no window; the scheduler still runs.')}
        <div class="hint mono">
          ${S.autostart?.installed
            ? 'Installed build · Windows brands the toast as DJ Task Manager and the sticky alarm toast can offer actions.'
            : 'Running unpackaged · Windows cannot brand the toast or route its buttons. Install the app for the full notification experience.'}
        </div>
        <div class="hint mono">Alarms are scheduled by a native Rust thread, so they fire whenever the app is running — window open or not.</div>
      </div>

      <div class="s-block">
        <h3>About</h3>
        <dl class="kv">
          <dt>Build</dt><dd>DJ Task Manager v${esc(S.info?.version ?? '—')} · Tauri 2 / Rust</dd>
          <dt>Started</dt><dd>${S.info ? clockLabel(S.info.startedAt) : '—'}</dd>
          <dt>Storage</dt><dd>Local only — no network sync</dd>
        </dl>
        <div class="opt-row">
          <div><div class="opt-t">Start from my own data</div><div class="opt-d">Clears every task, alarm and log row. Preferences are kept.</div></div>
          <button class="btn btn-tiny btn-danger" data-reset><span class="mi">delete</span>Clear workspace</button>
        </div>
        <div class="card-row">
          <span class="hint mono">Import replaces every table with the snapshot contents.</span>
          <button class="btn btn-tiny btn-danger" data-quit><span class="mi">close</span>Quit app</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------- render -- */

const VIEWS = { tasks: viewTasks, alarms: viewAlarms, calendar: viewCalendar, missed: viewMissed, settings: viewSettings };

function render() {
  const root = $('#content');
  // Re-rendering replaces the DOM; keep search focus and caret stable while typing.
  const active = document.activeElement;
  const keepFocus = active?.hasAttribute?.('data-search') ? 'search' : (active?.dataset?.newsub ? 'newsub' : null);
  const caret = keepFocus === 'search' ? active.selectionStart : null;
  const subFor = keepFocus === 'newsub' ? active.dataset.newsub : null;
  const scroll = root.querySelector('.view')?.scrollTop ?? 0;
  root.innerHTML = (VIEWS[S.view] || viewTasks)();
  applyIcons(root);
  root.querySelector('.view')?.scrollTo?.(0, scroll);
  if (keepFocus === 'search') {
    const el = $('[data-search]');
    el?.focus();
    if (caret != null) el.setSelectionRange(caret, caret);
  } else if (subFor) {
    const el = $(`[data-newsub="${subFor}"]`);
    el?.focus();
  }
  $$('.nav-item').forEach((b) => {
    const on = b.dataset.view === S.view;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  navChrome();
  document.body.classList.toggle('compact', S.settings.compact_rows === 'true');
}

/* --------------------------------------------------------------- events -- */

function setView(v) {
  S.view = v;
  if (v === 'calendar') loadCalendar();
  if (v === 'missed') loadMissed();
  if (v === 'settings') loadHealth().then(render);
  render();
}

async function refresh() {
  const [alarms, stats, storage, settings, info] = await Promise.all([
    call('list_alarms'),
    call('stats'),
    call('storage_report'),
    call('settings_all'),
    call('app_info'),
  ]);
  // The list is filtered server-side; when a search term is present, FTS5 (stemmed and
  // bm25-ranked) decides which tasks appear and in what order.
  let tasks = await call('list_tasks', { filter: S.filter, query: '' });
  if (tasks && S.query.trim()) {
    const hits = (await call('search_tasks', { query: S.query, limit: 200 })) || [];
    const order = new Map(hits.map((h, i) => [h.id, i]));
    tasks = tasks.filter((t) => order.has(t.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  if (tasks) S.tasks = tasks;
  if (alarms) S.alarms = alarms;
  if (stats) S.stats = stats;
  if (storage) S.storage = storage;
  if (settings) S.settings = { ...S.settings, ...settings };
  if (info) { S.info = info; renderTimer(info.timer); }
  if (S.selectedTask && !S.tasks.some((t) => t.id === S.selectedTask)) S.selectedTask = S.tasks[0]?.id ?? null;
  else if (!S.selectedTask) S.selectedTask = S.tasks[0]?.id ?? null;
  await loadSubtasks();
  applyTheme();
  render();
  updateStatus();
  if (S.view === 'settings') loadHealth().then(render);
}

async function loadSubtasks() {
  if (!S.selectedTask) return;
  const subs = await call('list_subtasks', { taskId: S.selectedTask });
  const t = S.tasks.find((x) => x.id === S.selectedTask);
  const a = S.alarms.find((x) => x.id === t?.alarmId);
  if (t) {
    t.subtasks = subs || [];
    t.alarmSnooze = a?.snoozeMin;
    t.alarmSound = a?.sound;
  }
}

async function loadMissed() {
  const rows = await call('list_missed', { onlyOpen: false });
  if (rows) S.missed = rows;
}

async function loadCalendar() {
  const cur = S.calCursor;
  const evs = await call('month_events', { year: cur.y, month: cur.m + 1 });
  S.calEvents = evs?.events || [];
}

async function loadHealth() {
  const [schema, analytics, activity, autostart] = await Promise.all([
    call('schema_report'),
    call('analytics', { days: 14 }),
    call('list_activity', { limit: 30 }),
    call('autostart_state'),
  ]);
  if (autostart) S.autostart = autostart;
  if (schema) S.schema = schema;
  if (analytics) S.analytics = analytics;
  if (activity) S.activity = activity;
}

async function loadStats() {
  const st = await call('stats');
  if (st) S.stats = st;
}

function applyTheme() {
  const light = S.settings.theme === 'light';
  document.documentElement.classList.toggle('light', light);
  document.documentElement.classList.toggle('dark', !light);
  const icon = $('#btnTheme .mi');
  if (icon) icon.textContent = light ? 'light_mode' : 'dark_mode';
  applyIcons($('#btnTheme'));
}

function updateStatus() {
  const ok = !!S.info;
  $('#dbDot').classList.toggle('is-bad', !ok);
  $('#dbLabel').textContent = ok ? 'Local DB connected (SQLite)' : 'DB unavailable';
  const b = S.storage?.bytes;
  $('#dbSizeLabel').textContent = b ? `DB ${(b / 1024).toFixed(0)} KiB · ${S.storage.rowCounts?.tasks ?? 0} tasks` : 'DB —';
  $('#driftLabel').textContent = `±${(S.driftMs / 1000).toFixed(1)}s`;
  const t = new Date();
  $('#clockLabel').textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
}

/* delegated UI events --------------------------------------------------- */

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  const near = (sel) => t.closest(sel);

  if (near('.nav-item')) return setView(near('.nav-item').dataset.view);
  if (near('#btnTheme')) {
    const next = S.settings.theme === 'light' ? 'dark' : 'light';
    await call('set_setting', { key: 'theme', value: next });
    S.settings.theme = next; applyTheme(); render(); return;
  }
  if (near('#btnNewTask') || near('[data-newtask]')) return openTaskEditor();
  if (near('#btnSetAlarm') || near('[data-newalarm]')) return openAlarmPicker({ tasks: S.tasks });
  if (near('#paletteBtn')) return openPalette();
  if (near('[data-win]')) {
    const what = near('[data-win]').dataset.win;
    if (what === 'close') return call('window_hide');
    if (what === 'minimise') return call('window_hide');
    return call('window_show');
  }
  if (near('#navDensity')) {
    const next = S.settings.compact_rows === 'true' ? 'false' : 'true';
    await call('set_setting', { key: 'compact_rows', value: next });
    S.settings.compact_rows = next; render(); return;
  }

  /* task list */
  const row = near('[data-task]');
  if (row && !near('.row-check')) {
    S.selectedTask = Number(row.dataset.task);
    await loadSubtasks();
    return render();
  }
  const chk = near('[data-toggle]');
  if (chk) {
    const id = Number(chk.dataset.toggle);
    const task = S.tasks.find((x) => x.id === id);
    await call('set_task_status', { id, status: task?.status === 'done' ? 'todo' : 'done' });
    await Promise.all([refresh(), loadStats()]);
    return;
  }
  const filt = near('[data-filter]');
  if (filt) { S.filter = filt.dataset.filter; return refresh(); }

  /* inspector */
  const stat = near('[data-status]');
  if (stat) {
    await call('set_task_status', { id: S.selectedTask, status: stat.dataset.status });
    return refresh();
  }
  const edit = near('[data-edit]');
  if (edit) return openTaskEditor(S.tasks.find((x) => x.id === Number(edit.dataset.edit)));
  const del = near('[data-del]');
  if (del) {
    const id = Number(del.dataset.del);
    const task = S.tasks.find((x) => x.id === id);
    toast('Delete task?', task?.title, [
      { label: 'Keep', kind: 'btn-ghost' },
      {
        label: 'Delete', kind: 'btn-danger', onClick: async () => {
          await call('delete_task', { id });
          if (S.selectedTask === id) S.selectedTask = null;
          await refresh();
        },
      },
    ], 'is-missed');
    return;
  }
  const pickDue = near('[data-pickdue]');
  if (pickDue) {
    const id = Number(pickDue.dataset.pickdue);
    const task = S.tasks.find((x) => x.id === id);
    if (!task) return;
    openAlarmPicker({
      mode: 'due',
      presetAt: task.dueAt ?? Math.floor(Date.now() / 1000) + HOUR,
      onPick: async (at) => {
        const out = await call('save_task', { input: taskPayload(task, { dueAt: at }) });
        if (out) {
          toast('Due date set', `${hhmm(at)} ${dayLabel(at)}`, [], 'is-ok');
          refresh();
        }
      },
    });
    return;
  }
  const alarmNew = near('[data-alarmnew]');
  if (alarmNew) {
    const id = Number(alarmNew.dataset.alarmnew);
    const task = S.tasks.find((x) => x.id === id);
    openAlarmPicker({
      tasks: S.tasks,
      presetAt: task?.dueAt ? task.dueAt - 1800 : null,
      presetTaskId: id,
    });
    return;
  }
  const alarmDel = near('[data-alarmdel]');
  if (alarmDel) { await call('delete_alarm', { id: Number(alarmDel.dataset.alarmdel) }); return refresh(); }
  const alarmTest = near('[data-alarmtest]') || near('[data-testalarm]');
  if (alarmTest) {
    const raw = alarmTest.dataset.alarmtest ?? alarmTest.dataset.testalarm;
    const id = Number(raw);
    if (!id) return toast('No alarm attached', 'Attach an alarm to this task first.', [], 'error');
    const out = await call('test_alarm', { id });
    if (out) toast('Test scheduled', `${out.label} fires in ~3 seconds.`, [], 'is-ok');
    return;
  }
  const snoozeSet = near('[data-snoozeSet]');
  if (snoozeSet) {
    const task = S.tasks.find((x) => x.id === S.selectedTask);
    const a = S.alarms.find((x) => x.id === task?.alarmId);
    if (a) {
      await call('save_alarm', { input: { id: a.id, label: a.label, fireAt: a.fireAt, repeat: a.repeat, days: a.days, snoozeMin: Number(snoozeSet.dataset.snoozeSet), sound: a.sound, taskId: a.taskId } });
      return refresh();
    }
  }
  const subAdd = near('[data-subadd]');
  if (subAdd) {
    const id = Number(subAdd.dataset.subadd);
    const input = $(`[data-newsub="${id}"]`);
    if (input?.value.trim()) {
      await call('add_subtask', { taskId: id, title: input.value.trim() });
      return refresh();
    }
    return;
  }
  const sub = near('[data-sub]');
  if (sub) { await call('toggle_subtask', { id: Number(sub.dataset.sub) }); return refresh(); }
  const subdel = near('[data-subdel]');
  if (subdel) { await call('delete_subtask', { id: Number(subdel.dataset.subdel) }); return refresh(); }

  /* alarms view */
  const atoggle = near('[data-alarmtoggle]');
  if (atoggle) {
    const id = Number(atoggle.dataset.alarmtoggle);
    const a = S.alarms.find((x) => x.id === id);
    await call('set_alarm_state', { id, newState: a.state === 'armed' ? 'paused' : 'armed' });
    return refresh();
  }
  const asnooze = near('[data-alarmsnooze]');
  if (asnooze) {
    const id = Number(asnooze.dataset.alarmsnooze);
    const a = S.alarms.find((x) => x.id === id);
    const out = await call('snooze_alarm', { id, minutes: a?.snoozeMin ?? 5 });
    if (out) toast('Snoozed', `${out.label} → ${hhmm(out.fireAt)} (${relLabel(out.fireAt)})`, [], 'is-ok');
    return refresh();
  }
  const aedit = near('[data-alarmedit]');
  if (aedit) return openAlarmPicker({ alarm: S.alarms.find((x) => x.id === Number(aedit.dataset.alarmedit)), tasks: S.tasks });
  const adel = near('[data-alarmdel]');
  if (adel) { await call('delete_alarm', { id: Number(adel.dataset.alarmdel) }); return refresh(); }
  if (near('[data-timertest]')) {
    const armed = S.alarms.find((a) => a.state === 'armed');
    if (!armed) return toast('No armed alarm', 'Create an alarm first.', [], 'error');
    const out = await call('test_alarm', { id: armed.id });
    return toast('Demo fired in 3s', `${out.label} — watch for the native toast and the in-app banner.`, [], 'is-ok');
  }

  /* calendar */
  const calNav = near('[data-cal]');
  if (calNav) {
    S.calCursor.m += Number(calNav.dataset.cal);
    if (S.calCursor.m < 0) { S.calCursor.m = 11; S.calCursor.y--; }
    if (S.calCursor.m > 11) { S.calCursor.m = 0; S.calCursor.y++; }
    await loadCalendar(); return render();
  }
  if (near('[data-cal-today]')) {
    const n = new Date();
    S.calCursor = { y: n.getFullYear(), m: n.getMonth() };
    S.calDay = TODAY0();
    await loadCalendar(); return render();
  }
  const day = near('[data-day]');
  if (day) { S.calDay = Number(day.dataset.day); return render(); }

  /* missed */
  if (near('[data-toggleResolved]')) { S.showResolved = !S.showResolved; return render(); }
  const mn = near('[data-missnooze]');
  if (mn) {
    const id = Number(mn.dataset.missnooze);
    const aid = Number(mn.dataset.alarm);
    await call('resolve_missed', { id, resolution: 'snoozed' });
    if (aid) await call('snooze_alarm', { id: aid, minutes: 10 });
    await Promise.all([loadMissed(), loadStats()]);
    return render();
  }
  const ma = near('[data-missack]');
  if (ma) { await call('resolve_missed', { id: Number(ma.dataset.missack), resolution: 'acknowledged' }); await Promise.all([loadMissed(), loadStats()]); return render(); }
  const md = near('[data-missdis]');
  if (md) { await call('resolve_missed', { id: Number(md.dataset.missdis), resolution: 'dismissed' }); await Promise.all([loadMissed(), loadStats()]); return render(); }
  if (near('[data-catchupall]')) {
    const out = await call('catch_up_snooze_all', { minutes: 10 });
    if (out) toast('Catch-up applied', out.message, [], 'is-ok');
    await Promise.all([loadMissed(), loadStats(), refresh()]);
    return render();
  }
  if (near('[data-clearmissed]')) {
    const out = await call('clear_missed');
    if (out) toast('Catch-up log cleared', out.message, [], 'is-ok');
    await Promise.all([loadMissed(), loadStats()]);
    return render();
  }

  /* settings */
  const sw = near('[data-setting]');
  if (sw) {
    const key = sw.dataset.setting;
    const next = S.settings[key] === 'false' ? 'true' : 'false';
    await call('set_setting', { key, value: next });
    S.settings[key] = next;
    return render();
  }
  if (near('[data-snoozedefault]')) return;   // handled by change
  const theme = near('[data-theme]');
  if (theme) {
    await call('set_setting', { key: 'theme', value: theme.dataset.theme });
    S.settings.theme = theme.dataset.theme;
    applyTheme(); return render();
  }
  if (near('[data-toast-test]')) {
    const out = await call('test_notification', { title: 'DJ Task Manager', body: 'Native Windows toast delivery is working.' });
    return toast('Test toast sent', out?.message ?? 'failed', [], out?.ok ? 'is-ok' : 'is-error');
  }
  if (near('[data-export]')) {
    const out = await call('export_snapshot');
    if (out) toast(out.ok ? 'Snapshot exported' : 'Export cancelled', out.message, [], out.ok ? 'is-ok' : 'is-missed');
    return;
  }
  if (near('[data-import]')) {
    const out = await call('import_snapshot');
    if (out) toast(out.ok ? 'Snapshot restored' : 'Import cancelled', out.message, [], out.ok ? 'is-ok' : 'is-missed');
    return refresh();
  }
  if (near('[data-integrity]')) {
    const out = await call('db_integrity');
    if (out) {
      const ok = out.integrity === 'ok';
      S.health = { ok, message: `integrity_check: ${out.integrity} · quick_check: ${out.quick}` };
      toast(ok ? 'Database is consistent' : 'Integrity problem', S.health.message, [], ok ? 'is-ok' : 'is-error');
      render();
    }
    return;
  }
  if (near('[data-checkpoint]')) {
    const out = await call('db_checkpoint');
    if (out) {
      S.health = { ok: out.ok, message: out.message };
      toast(out.ok ? 'WAL checkpointed' : 'Checkpoint deferred', out.message, [], out.ok ? 'is-ok' : 'is-missed');
      render();
    }
    return;
  }
  if (near('[data-backup]')) {
    const out = await call('backup_database');
    if (out) toast(out.ok ? 'Binary backup written' : 'Backup cancelled', out.message, [], out.ok ? 'is-ok' : 'is-missed');
    return;
  }
  const csvBtn = near('[data-csv]');
  if (csvBtn) {
    const out = await call('export_csv', { table: csvBtn.dataset.csv });
    if (out) toast(out.ok ? `Exported ${csvBtn.dataset.csv}` : 'Export cancelled', out.message, [], out.ok ? 'is-ok' : 'is-missed');
    return;
  }
  if (near('[data-prune]')) {
    const out = await call('prune_history', { keepDays: 90 });
    if (out) {
      toast('History pruned', out.message, [], 'is-ok');
      await loadHealth();
      render();
    }
    return;
  }
  if (near('[data-vacuum]')) {
    const out = await call('vacuum');
    if (out) toast('Database compacted', out.message, [], 'is-ok');
    return refresh();
  }
  if (near('[data-reset]')) {
    toast('Clear the workspace?', 'This deletes all tasks, alarms and history. Preferences stay.', [
      { label: 'Cancel', kind: 'btn-ghost' },
      {
        label: 'Clear everything', kind: 'btn-danger', onClick: async () => {
          const out = await call('reset_workspace');
          if (out) {
            toast(out.ok ? 'Workspace cleared' : 'Reset failed', out.message, [], out.ok ? 'is-ok' : 'is-error');
            S.selectedTask = null;
            await Promise.all([refresh(), loadMissed(), loadHealth()]);
            render();
          }
        },
      },
    ], 'is-missed');
    return;
  }
  if (near('[data-autostart]')) {
    const next = !S.autostart?.enabled;
    const out = await call('set_autostart', { enabled: next });
    if (out) {
      S.autostart = out;
      toast(out.enabled ? 'Launches at sign-in' : 'Will not start at sign-in', out.enabled ? 'The scheduler starts with Windows and sits in the tray.' : 'Start DJ Task Manager manually to resume alarms.', [], out.enabled ? 'is-ok' : 'is-missed');
    }
    return render();
  }
  if (near('[data-quit]')) return call('app_quit');

  /* timer */
  if (near('#btnTimerStart')) {
    const out = await call('timer_start', { input: { label: 'Deep Focus', minutes: 25, taskId: S.selectedTask } });
    if (out) renderTimer(out);
    return;
  }
  if (near('#btnTimerPause')) {
    const st = S.timerState || {};
    const out = st.paused ? await call('timer_resume') : await call('timer_pause');
    if (out) renderTimer(out);
    return;
  }
  if (near('#btnTimerStop')) {
    const out = await call('timer_stop');
    if (out) renderTimer(out);
    return;
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.dataset.snoozedefault) {
    await call('set_setting', { key: 'default_snooze', value: t.value });
    S.settings.default_snooze = t.value;
    return toast('Default snooze saved', `${t.value} minutes for new alarms.`, [], 'is-ok');
  }
  const pri = t.closest?.('[data-priority]');
  if (pri) {
    const id = Number(pri.dataset.priority);
    const task = S.tasks.find((x) => x.id === id);
    await call('save_task', { input: taskPayload(task, { priority: pri.value }) });
    return refresh();
  }
  const snd = t.closest?.('[data-soundSet]');
  if (snd) {
    const id = Number(snd.dataset.soundSet);
    const a = S.alarms.find((x) => x.id === id);
    if (a) {
      await call('save_alarm', { input: { id, label: a.label, fireAt: a.fireAt, repeat: a.repeat, days: a.days, snoozeMin: a.snoozeMin, sound: snd.value, taskId: a.taskId } });
      return refresh();
    }
  }
});

/* live text edits: commit on blur so we do not write on every keystroke */
document.addEventListener('blur', async (ev) => {
  const t = ev.target;
  const title = t.closest?.('[data-title]');
  const notes = t.closest?.('[data-notes]');
  if (!title && !notes) return;
  const id = Number((title || notes).dataset.title ?? (title || notes).dataset.notes);
  const task = S.tasks.find((x) => x.id === id);
  if (!task) return;
  const nextTitle = title ? t.value.trim() || task.title : task.title;
  const nextNotes = notes ? t.value : task.notes;
  if (nextTitle === task.title && nextNotes === task.notes) return;
  await call('save_task', { input: taskPayload(task, { title: nextTitle, notes: nextNotes }) });
  await refresh();
}, true);

document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); return openPalette(); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'n') { ev.preventDefault(); return openTaskEditor(); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') { ev.preventDefault(); return openAlarmPicker({ tasks: S.tasks }); }
  if (ev.key === 'Escape') { closeTopModal(); return; }
  if (typing) return;
  /* 1..5 jump between workspace views */
  const viewByDigit = { 1: 'tasks', 2: 'alarms', 3: 'calendar', 4: 'missed', 5: 'settings' };
  if (viewByDigit[ev.key]) { ev.preventDefault(); return setView(viewByDigit[ev.key]); }
  if (S.view !== 'tasks' || !S.tasks.length) return;
  const idx = S.tasks.findIndex((t) => t.id === S.selectedTask);
  if (ev.key.toLowerCase() === 'j' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    S.selectedTask = S.tasks[Math.min(S.tasks.length - 1, idx + 1)]?.id;
    loadSubtasks().then(render);
  }
  if (ev.key.toLowerCase() === 'k' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    S.selectedTask = S.tasks[Math.max(0, idx - 1)]?.id;
    loadSubtasks().then(render);
  }
  if (ev.key.toLowerCase() === 'x') {
    const task = S.tasks[idx];
    if (task) call('set_task_status', { id: task.id, status: task.status === 'done' ? 'todo' : 'done' }).then(refresh);
  }
});

/* search input keeps focus across re-renders */
document.addEventListener('input', (ev) => {
  const s = ev.target.closest?.('[data-search]');
  if (!s) return;
  S.query = s.value;
  clearTimeout(s._deb);
  s._deb = setTimeout(refresh, 220);
});

/* ------------------------------------------------------------- palette -- */

function openPalette() {
  const commands = [
    { kind: 'go', label: 'Go to Tasks', run: () => setView('tasks'), icon: 'check_circle' },
    { kind: 'go', label: 'Go to Alarms & Timers', run: () => setView('alarms'), icon: 'timer' },
    { kind: 'go', label: 'Go to Calendar View', run: () => setView('calendar'), icon: 'calendar_today' },
    { kind: 'go', label: 'Go to Missed Alarms', run: () => setView('missed'), icon: 'notification_important' },
    { kind: 'go', label: 'Go to Settings', run: () => setView('settings'), icon: 'settings' },
    { kind: 'cmd', label: 'New task', run: () => openTaskEditor(), icon: 'add_task' },
    { kind: 'cmd', label: 'Arm a new alarm', run: () => openAlarmPicker({ tasks: S.tasks }), icon: 'alarm_add' },
    { kind: 'cmd', label: 'Start 25 minute focus timer', run: async () => renderTimer(await call('timer_start', { input: { label: 'Deep Focus', minutes: 25, taskId: S.selectedTask } })), icon: 'play_arrow' },
    { kind: 'cmd', label: 'Send a test toast', run: async () => { const o = await call('test_notification', {}); toast('Test toast', o?.message, [], 'is-ok'); }, icon: 'notifications' },
    { kind: 'cmd', label: 'Hide to tray', run: () => call('window_hide'), icon: 'dark_mode' },
    { kind: 'cmd', label: 'Compact the database (VACUUM)', run: async () => { await call('vacuum'); refresh(); }, icon: 'refresh' },
  ];
  const items = [
    ...S.tasks.map((t) => ({ kind: 'task', label: t.title, run: () => { S.view = 'tasks'; S.selectedTask = t.id; loadSubtasks().then(render); }, icon: 'task', sub: t.status })),
    ...S.alarms.map((a) => ({ kind: 'alarm', label: a.label, run: () => setView('alarms'), icon: 'alarm', sub: a.nextFireAt ? `${hhmm(a.nextFireAt)} ${dayLabel(a.nextFireAt)}` : a.state })),
    ...commands,
  ];
  const html = `<div class="modal palette">
    <input type="text" placeholder="Search tasks, alarms, or type a command…" data-q />
    <div class="palette-list" data-list></div>
  </div>`;
  openModal(html, (modal, close) => {
    const list = $('[data-list]', modal);
    const input = $('[data-q]', modal);
    let active = 0;
    let shown = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = (q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items).slice(0, 40);
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length ? shown.map((i, n) => `<button class="p-item ${n === active ? 'is-active' : ''}" data-n="${n}">
        <span class="mi">${i.icon}</span><span class="p-text">${esc(i.label)}</span>
        ${i.sub ? `<span class="hint mono">${esc(i.sub)}</span>` : ''}<span class="p-kind">${i.kind}</span></button>`).join('')
        : `<div class="empty" style="padding:24px"><span class="mi">search</span><div class="hint">No match</div></div>`;
      applyIcons(list);
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
      if (e.key === 'Enter') { shown[active]?.run(); close(); e.preventDefault(); }
    });
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-n]');
      if (!b) return;
      shown[Number(b.dataset.n)]?.run();
      close();
    });
    draw();
  });
}

/* ----------------------------------------------------------- scheduler -- */

function renderTimer(t) {
  if (!t) return;
  S.timerState = t;
  document.querySelector('.timer-card')?.classList.toggle('is-running', !!t.running && !t.paused);
  $('#timerLabel').textContent = t.running ? t.label : 'No focus block';
  $('#timerSub').textContent = t.running ? (t.paused ? 'PAUSED' : `of ${mmss(t.totalSec)} remaining`) : 'Start one from any task';
  $('#timerClock').textContent = t.running ? mmss(t.remainingSec) : '00:00';
  $('#timerFlag').textContent = t.running ? (t.paused ? 'PAUSED' : 'RUNNING') : 'IDLE';
  $('#btnTimerPause').disabled = !t.running;
  $('#btnTimerStop').disabled = !t.running;
}

function onAlarmEvent(p) {
  const kind = p.missed ? 'is-missed' : '';
  const body = p.missed
    ? `Due ${clockLabel(p.fireAt)} — logged to the catch-up queue.`
    : (p.taskTitle ? `Linked task: ${p.taskTitle}` : 'Snooze or dismiss from here.');
  toast(p.missed ? `Missed: ${p.label}` : `Alarm: ${p.label}`, body, [
    {
      label: `Snooze (${p.snoozeMin}m)`, kind: 'btn-ghost', icon: 'snooze', onClick: async () => {
        const out = await call('snooze_alarm', { id: p.id, minutes: p.snoozeMin });
        if (p.missed && p.loggedId) await call('resolve_missed', { id: p.loggedId, resolution: 'snoozed' });
        if (out) toast('Snoozed', `${out.label} → ${hhmm(out.fireAt)}`, [], 'is-ok');
        refresh();
      },
    },
    {
      label: 'Dismiss', kind: 'btn-primary', icon: 'done_all', onClick: async () => {
        await call('set_alarm_state', { id: p.id, newState: 'dismissed' });
        if (p.missed && p.loggedId) await call('resolve_missed', { id: p.loggedId, resolution: 'dismissed' });
        refresh();
      },
    },
  ], kind);
  loadMissed();
  loadStats();
}

/* ----------------------------------------------------------------- init -- */

async function boot() {
  const now = new Date();
  S.calCursor = { y: now.getFullYear(), m: now.getMonth() };
  S.calDay = TODAY0();

  await refresh();
  await loadMissed();
  render();

  listen('app://alarm', (e) => onAlarmEvent(e.payload));
  listen('app://timer', (e) => renderTimer(e.payload));
  listen('app://timer-done', (e) => toast('Timer finished', `“${e.payload}” is complete.`, [{ label: 'Start another', kind: 'btn-primary', onClick: () => $('#btnTimerStart').click() }], 'is-ok'));
  listen('app://tick', (e) => {
    S.driftMs = e.payload.driftMs ?? 0;
    $('#syncLabel').textContent = `${Math.max(1, Math.round((e.payload.now - e.payload.startedAt) / 60))}m Sync`;
    updateStatus();
    loadStats().then(navChrome);
  });
  listen('app://ready', () => {
    $('#syncLabel').textContent = 'scheduler live';
    toast('Scheduler online', `${S.stats?.alarmsArmed ?? 0} alarms armed · SQLite journal ${S.storage?.journalMode ?? 'WAL'}`, [], 'is-ok');
  });

  setInterval(updateStatus, 1000);
  setInterval(() => { if (S.view === 'tasks' || S.view === 'alarms') refresh(); }, 60000);

  if (S.missed.some((m) => m.resolution === 'unhandled')) {
    setView('missed');
    const open = S.missed.filter((m) => m.resolution === 'unhandled');
    toast(`${open.length} alarm${open.length === 1 ? '' : 's'} missed offline`, 'Handled from the catch-up log — snooze all or clear.', [
      { label: 'Snooze all +10m', kind: 'btn-primary', icon: 'snooze', onClick: async () => { await call('catch_up_snooze_all', { minutes: 10 }); await Promise.all([loadMissed(), refresh()]); render(); } },
      { label: 'Review', kind: 'btn-ghost', onClick: () => setView('missed') },
    ], 'is-missed');
  }
}

window.addEventListener('error', (e) => console.error('[dj-task-manager ui]', e.message));
applyIcons(document);   // static chrome (title bar, sidebar, status bar) before any data lands
boot();
