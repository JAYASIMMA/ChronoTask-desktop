// TEST HARNESS ONLY — not part of the app.
// Serves ui/index.html with a stubbed window.__TAURI__ injected ahead of app.js, so the
// real renderer can be exercised in a browser and screenshotted view by view.
// Fixtures mirror the shapes the Rust commands return (serde camelCase).
const http = require('http');
const fs = require('fs');
const path = require('path');

const UI = path.resolve(__dirname, '..', 'ui');
const now = Math.floor(Date.now() / 1000);
const at = (d, h, mi) => { const x = new Date(); x.setDate(x.getDate() + d); x.setHours(h, mi, 0, 0); return Math.floor(x.getTime() / 1000); };

const tasks = [
  { id: 1, title: 'Finalize SQLite IPC contextBridge Handlers', notes: 'Ensure every main-thread query through contextBridge.exposeInMainWorld is guarded by a payload validation schema.', priority: 'p1', status: 'doing', dueAt: at(0, 15, 0), tags: ['backend', 'release'], alarmId: 1, alarmLabel: 'Code freeze — IPC handlers', alarmFireAt: at(0, 14, 30), createdAt: at(-3, 9, 0), updatedAt: now - 180, subtaskTotal: 3, subtaskDone: 2 },
  { id: 2, title: 'Implement Multi-threaded Cron Clock Tick Drift', notes: 'Compensate for scheduler drift by re-anchoring each tick to the monotonic clock.', priority: 'p2', status: 'todo', dueAt: at(0, 16, 45), tags: ['core'], alarmId: 3, alarmLabel: 'Deep focus block ends', alarmFireAt: at(0, 17, 15), createdAt: at(-2, 9, 0), updatedAt: now - 900, subtaskTotal: 1, subtaskDone: 0 },
  { id: 3, title: 'Notion Calendar OAuth2 Refresh Handshake', notes: 'Handle refresh-token rotation and the 401 retry path.', priority: 'p3', status: 'todo', dueAt: at(1, 10, 0), tags: ['auth', 'frontend'], alarmId: null, alarmLabel: null, alarmFireAt: null, createdAt: at(-2, 11, 0), updatedAt: now - 4000, subtaskTotal: 1, subtaskDone: 1 },
  { id: 4, title: 'Audit Audio Chime Latency on macOS Sonoma', notes: 'Measure the gap between scheduler fire and the first audible sample.', priority: 'p1', status: 'todo', dueAt: at(-1, 9, 30), tags: ['audio'], alarmId: null, alarmLabel: null, alarmFireAt: null, createdAt: at(-4, 8, 0), updatedAt: now - 9000, subtaskTotal: 0, subtaskDone: 0 },
  { id: 5, title: 'Sign Electron Distribution Binaries', notes: 'Notarisation completed for both architectures.', priority: 'p3', status: 'done', dueAt: at(-2, 11, 15), tags: ['devops'], alarmId: null, alarmLabel: null, alarmFireAt: null, createdAt: at(-6, 8, 0), updatedAt: now - 40000, subtaskTotal: 0, subtaskDone: 0 },
];

const alarms = [
  { id: 1, label: 'Code freeze — IPC handlers', fireAt: at(0, 14, 30), repeat: 'none', days: [], snoozeMin: 5, sound: 'chime', state: 'armed', taskId: 1, taskTitle: 'Finalize SQLite IPC contextBridge Handlers', lastFiredAt: null, nextFireAt: at(0, 14, 30), createdAt: at(-1, 9, 0) },
  { id: 2, label: 'Standup sync', fireAt: at(0, 9, 45), repeat: 'weekdays', days: [0, 1, 2, 3, 4], snoozeMin: 10, sound: 'bell', state: 'armed', taskId: null, taskTitle: null, lastFiredAt: at(0, 9, 45), nextFireAt: at(1, 9, 45), createdAt: at(-8, 9, 0) },
  { id: 3, label: 'Deep focus block ends', fireAt: at(0, 17, 15), repeat: 'none', days: [], snoozeMin: 5, sound: 'pulse', state: 'armed', taskId: 2, taskTitle: 'Implement Multi-threaded Cron Clock Tick Drift', lastFiredAt: null, nextFireAt: at(0, 17, 15), createdAt: at(-1, 9, 0) },
  { id: 4, label: 'Friday retro', fireAt: at(2, 16, 0), repeat: 'weekly', days: [4], snoozeMin: 15, sound: 'chime', state: 'paused', taskId: null, taskTitle: null, lastFiredAt: null, nextFireAt: null, createdAt: at(-20, 9, 0) },
];

const missed = [
  { id: 1, alarmId: 1, label: 'Audio chime latency check', dueAt: at(-1, 9, 30), detectedAt: now - 600, source: 'offline', resolution: 'unhandled', resolvedAt: null },
  { id: 2, alarmId: null, label: 'Weekly build review', dueAt: at(-2, 15, 0), detectedAt: now - 3600, source: 'offline', resolution: 'snoozed', resolvedAt: now - 3500 },
  { id: 3, alarmId: 3, label: 'Deep focus block ends', dueAt: at(0, 16, 40), detectedAt: now - 120, source: 'runtime', resolution: 'unhandled', resolvedAt: null },
];

const storage = {
  path: 'C:\\Users\\jayas\\AppData\\Roaming\\app.chronotask.desktop\\chronotask.db',
  dir: 'C:\\Users\\jayas\\AppData\\Roaming\\app.chronotask.desktop',
  bytes: 65536, pageSize: 4096, pageCount: 16, journalMode: 'wal',
  tables: ['alarms', 'meta', 'missed_alarms', 'settings', 'subtasks', 'tasks'],
  rowCounts: { alarms: 4, meta: 0, missed_alarms: 3, settings: 6, subtasks: 5, tasks: 12 },
  walBytes: 206032, shmBytes: 32768,
};

const settings = { theme: 'dark', close_to_tray: 'true', native_toasts: 'true', default_snooze: '5', catch_up: 'true', compact_rows: 'false' };

const handlers = {
  app_info: () => ({ version: '2.5.0', appName: 'DJ Task Manager', dbPath: storage.path, dataDir: storage.dir, startedAt: now - 900, platform: 'windows', timer: { running: true, paused: false, label: 'Deep Focus #4', taskId: 2, totalSec: 1500, remainingSec: 1412 } }),
  stats: () => ({ dueToday: 4, overdue: 1, alarmsArmed: 3, tasksOpen: 4, tasksTotal: 5, missedUnhandled: 2 }),
  storage_report: () => storage,
  list_tasks: () => tasks,
  list_alarms: () => alarms,
  list_missed: () => missed,
  list_subtasks: () => [
    { id: 1, taskId: 1, title: 'Sanitize prepared statement inputs with sqlstring', done: true },
    { id: 2, taskId: 1, title: 'Enforce IPC timeout at a 3000ms threshold', done: true },
    { id: 3, taskId: 1, title: 'Register high-precision alert callback before window closure', done: false },
  ],
  settings_all: () => settings,
  month_events: ({ year, month }) => {
    const events = [];
    for (let d = 1; d <= 31; d++) {
      const t = new Date(year, month - 1, d, 9, 45);
      if (t.getMonth() !== month - 1) break;
      if (d % 5 === 0) events.push({ kind: 'task', id: d, title: `Milestone review ${d}`, priority: 'p2', status: 'todo', at: Math.floor(t.getTime() / 1000) });
      if (d % 7 === 0) events.push({ kind: 'alarm', id: d, title: 'Recurring sync', state: 'armed', repeat: 'weekly', at: Math.floor(new Date(year, month - 1, d, 14, 30).getTime() / 1000) });
    }
    return { year, month, start: 0, end: 0, events };
  },
  save_task: ({ input }) => ({ ...tasks[0], ...input, id: input.id ?? 99, updatedAt: now }),
  save_alarm: ({ input }) => ({ ...alarms[0], ...input, id: input.id ?? 99, state: 'armed', nextFireAt: input.fireAt }),
  create_task_with_alarm: ({ input }) => ({ ...tasks[0], ...input, id: 99, alarmId: null, alarmFireAt: null, subtaskTotal: 0, subtaskDone: 0 }),
  set_task_status: ({ id, status }) => ({ ...tasks.find((t) => t.id === id), status }),
  task_by_id: () => tasks[0],
  delete_task: () => ({ ok: true, message: 'task deleted' }),
  delete_alarm: () => ({ ok: true, message: 'alarm deleted' }),
  set_alarm_state: ({ id, newState }) => ({ ...alarms.find((a) => a.id === id), state: newState }),
  snooze_alarm: ({ id, minutes }) => ({ ...alarms.find((a) => a.id === id), fireAt: now + minutes * 60, state: 'armed' }),
  test_alarm: ({ id }) => ({ ...alarms.find((a) => a.id === id), fireAt: now + 3 }),
  test_notification: () => ({ ok: true, message: 'notification handed to Windows' }),
  resolve_missed: () => ({ ok: true, message: 'acknowledged' }),
  clear_missed: () => ({ ok: true, message: '2 entries cleared' }),
  catch_up_snooze_all: ({ minutes }) => ({ ok: true, message: `2 alarms snoozed +${minutes}m` }),
  set_setting: ({ key, value }) => ({ ok: true, message: `${key}=${value}` }),
  timer_start: ({ input }) => ({ running: true, paused: false, label: input.label, taskId: input.taskId ?? null, totalSec: input.minutes * 60, remainingSec: input.minutes * 60 }),
  timer_pause: () => ({ running: true, paused: true, label: 'Deep Focus #4', taskId: 2, totalSec: 1500, remainingSec: 1412 }),
  timer_resume: () => ({ running: true, paused: false, label: 'Deep Focus #4', taskId: 2, totalSec: 1500, remainingSec: 1412 }),
  timer_stop: () => ({ running: false, paused: false, label: '', taskId: null, totalSec: 0, remainingSec: 0 }),
  timer_state: () => ({ running: false, paused: false, label: '', taskId: null, totalSec: 0, remainingSec: 0 }),
  vacuum: () => ({ ok: true, message: 'VACUUM + ANALYZE complete' }),
  export_snapshot: () => ({ ok: true, message: 'wrote C:\\backups\\chronotask.json' }),
  import_snapshot: () => ({ ok: true, message: 'restored 30 rows' }),
  add_subtask: () => [],
  toggle_subtask: () => ({ ok: true, message: 'toggled' }),
  delete_subtask: () => ({ ok: true, message: 'deleted' }),
  window_hide: () => ({ ok: true, message: 'minimised to tray' }),
  window_show: () => ({ ok: true, message: 'shown' }),
  app_quit: () => null,

  // --- v2 backend surface ---
  search_tasks: ({ query }) => {
    const q = String(query || '').toLowerCase();
    return tasks.filter((t) =>
      (t.title + ' ' + t.notes + ' ' + t.tags.join(' ')).toLowerCase().includes(q))
      .slice(0, 20)
      .map((t, i) => ({
        id: t.id, title: t.title, priority: t.priority, status: t.status, dueAt: t.dueAt,
        snippet: t.title.replace(new RegExp(`(${q})`, 'i'), '<b>$1</b>'),
        score: -i, engine: 'fts5',
      }));
  },
  analytics: ({ days }) => ({
    windowDays: days || 14,
    since: NOW - (days || 14) * 86400,
    completions: [
      { day: '2026-10-20', count: 3 }, { day: '2026-10-21', count: 5 }, { day: '2026-10-22', count: 2 },
      { day: '2026-10-23', count: 7 }, { day: '2026-10-24', count: 4 }, { day: '2026-10-26', count: 6 },
    ],
    onTime: { onTime: 9, total: 12, rate: 75 },
    alarmEvents: { fired: 14, missed: 3, snoozed: 5, preflight: 4, armed: 6, disabled: 1 },
    missedBySource: [{ source: 'offline', resolution: 'unhandled', count: 2 }, { source: 'runtime', resolution: 'snoozed', count: 1 }],
    topTags: [{ tag: 'backend', count: 6 }, { tag: 'core', count: 4 }, { tag: 'ui', count: 3 }],
    oldestTaskAt: NOW - 30 * 86400,
    generatedAt: NOW,
  }),
  schema_report: () => ({
    userVersion: 3, targetVersion: 3, upToDate: true, fts5: true,
    applied: [
      { version: 1, name: 'baseline', at: NOW - 900 },
      { version: 2, name: 'alarm-policy-and-recurrence', at: NOW - 900 },
      { version: 3, name: 'history-and-fts', at: NOW - 900 },
    ],
    indexes: [{ name: 'idx_tasks_due', table: 'tasks' }, { name: 'idx_alarms_state', table: 'alarms' }],
  }),
  list_activity: () => [
    { id: 1, taskId: 1, kind: 'status', summary: 'done: Finalize SQLite IPC handlers', at: NOW - 300 },
    { id: 2, taskId: 2, kind: 'recurrence', summary: 'occurrence archived as task 41; next due at 27 Oct 09:00', at: NOW - 900 },
    { id: 3, taskId: 3, kind: 'created', summary: 'Notion Calendar OAuth2 · p3 · due 27 Oct', at: NOW - 1800 },
    { id: 4, taskId: 1, kind: 'updated', summary: 'Finalize SQLite IPC handlers · p1 · due today', at: NOW - 3600 },
  ],
  list_alarm_history: () => [
    { id: 1, alarmId: 1, label: 'Code freeze — IPC handlers', event: 'fired', dueAt: NOW - 60, at: NOW - 55, note: '' },
    { id: 2, alarmId: 2, label: 'Standup sync', event: 'missed', dueAt: NOW - 7200, at: NOW - 60, note: 'offline' },
    { id: 3, alarmId: 3, label: 'Deep focus block ends', event: 'snoozed', dueAt: NOW + 300, at: NOW - 30, note: '+5m (1 of 3)' },
  ],
  list_occurrences: () => tasks.slice(0, 2).map((t) => ({ ...t, archived: true, status: 'done', recurrence: 'none' })),
  db_integrity: () => ({ integrity: 'ok', quick: 'ok', checkedAt: NOW }),
  db_checkpoint: () => ({ ok: true, message: 'WAL checkpointed (0 of 0 frames, sidecar truncated)' }),
  backup_database: () => ({ ok: true, message: 'C:\\backups\\chronotask.db (72 KiB)' }),
  export_csv: ({ table }) => ({ ok: true, message: `12 rows exported to C:\\backups\\chronotask-${table}.csv` }),
  prune_history: () => ({ ok: true, message: 'removed 4 alarm events and 2 activity rows older than 90d' }),
  reset_workspace: () => ({ ok: true, message: 'cleared 0 rows; preferences kept' }),
  autostart_state: () => ({ enabled: true, installed: false, exePath: 'D:\\chronotask-desktop\\src-tauri\\target\\release\\dj-task-manager.exe' }),
  set_autostart: ({ enabled }) => ({ enabled: !!enabled, installed: false, exePath: 'D:\\chronotask-desktop\\src-tauri\\target\\release\\dj-task-manager.exe' }),
  install_state: () => ({ installed: false, identifier: 'app.djtaskmanager.desktop', productName: 'DJ Task Manager', version: '2.5.0' }),
};


// The mock needs the fixtures too, so ship them as a global and evaluate inline.
const MOCK_JS = `
(function(){
  const NOW = ${now};
  const AT = ${at.toString()};
  const TASKS = ${JSON.stringify(tasks)};
  const ALARMS = ${JSON.stringify(alarms)};
  const MISSED = ${JSON.stringify(missed)};
  const STORAGE = ${JSON.stringify(storage)};
  const SETTINGS = ${JSON.stringify(settings)};
  const STATS = ${JSON.stringify(handlers.stats())};
  const INFO = ${JSON.stringify(handlers.app_info())};
  const SUBS = ${JSON.stringify(handlers.list_subtasks())};
  // Alias the fixtures under the names the Node handler closures use, so the same
  // function bodies work verbatim in the page.
  const H = (function (now, at, tasks, alarms, missed, storage, settings) {
    return {${Object.entries(handlers).map(([k, fn]) => JSON.stringify(k) + ':' + String(fn)).join(',')}};
  })(NOW, AT, TASKS, ALARMS, MISSED, STORAGE, SETTINGS);
  window.__invokeLog = [];
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        window.__invokeLog.push([cmd, args]);
        const f = H[cmd];
        if (!f) { console.warn('mock missing command', cmd); return null; }
        return JSON.parse(JSON.stringify(f(args || {})));
      },
    },
    event: { listen: async (e, cb) => { (window.__listeners = window.__listeners || {})[e] = cb; return () => {}; } },
  };
  window.__fire = (e, payload) => { const cb = (window.__listeners || {})[e]; if (cb) cb({ payload }); };
})();
`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/harness.html' || url === '/harness') {
    let html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
    html = html.replace('<script src="./app.js"></script>', `<script>${MOCK_JS}</script>\n<script src="./app.js"></script>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  const file = path.join(UI, url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, ''));
  if (!file.startsWith(UI) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8' });
  fs.createReadStream(file).pipe(res);
});

server.listen(8931, '127.0.0.1', () => console.log('harness on http://127.0.0.1:8931/harness.html'));
