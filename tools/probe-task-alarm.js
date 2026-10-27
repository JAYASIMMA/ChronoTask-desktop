// Runs the same IPC the New Task dialog runs, so a "cannot create" report can be
// reproduced against the real backend instead of guessed at.
// Edit CASES to add a shape, then: node tools/cdp-eval.js @tools/probe-task-alarm.js --async
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const now = Math.floor(Date.now() / 1000);
  const hourAhead = new Date(); hourAhead.setHours(hourAhead.getHours() + 1, 0, 0, 0);

  const base = {
    id: null, title: 'Probe task', notes: '', priority: 'med', status: 'todo',
    dueAt: null, tags: [], recurrence: 'none', recurDays: [], parentId: null,
  };

  const cases = {
    // exactly what openTaskEditor sends for a brand-new task with no alarm
    'plain task, alarmAt null': { input: base, alarmAt: null, alarmLabel: null, snoozeMin: 5 },
    // what it sends after clicking Pick
    'plain task + alarm an hour ahead': {
      input: base, alarmAt: Math.floor(hourAhead.getTime() / 1000),
      alarmLabel: 'Reminder: Probe task', snoozeMin: 5,
    },
    // the shapes a UI bug could accidentally produce
    'alarmAt undefined (field dropped)': { input: base, alarmAt: undefined, snoozeMin: 5 },
    'alarmAt in the past': { input: base, alarmAt: now - 600, snoozeMin: 5 },
    'snoozeMin undefined': { input: base, alarmAt: Math.floor(hourAhead.getTime() / 1000), snoozeMin: undefined },
    'recurDays as strings': {
      input: { ...base, recurrence: 'weekly', recurDays: ['1', '3'] },
      alarmAt: Math.floor(hourAhead.getTime() / 1000), snoozeMin: 5,
    },
    'priority unrecognised': { input: { ...base, priority: 'urgent' }, alarmAt: null, snoozeMin: 5 },
  };

  const report = [];
  for (const [name, payload] of Object.entries(cases)) {
    try {
      const task = await invoke('create_task_with_alarm', payload);
      const alarms = (await invoke('list_alarms')).filter((a) => a.taskId === task.id);
      report.push({ case: name, ok: true, taskId: task.id, linkedAlarms: alarms.length, alarmFireAt: task.alarmFireAt });
    } catch (err) {
      report.push({ case: name, ok: false, error: typeof err === 'string' ? err : JSON.stringify(err) });
    }
  }
  // Clean up so probing never leaves the workspace dirty.
  const tasks = await invoke('list_tasks', { onlyOpen: false });
  for (const t of tasks.filter((x) => x.title === 'Probe task')) {
    try { await invoke('delete_task', { id: t.id }); } catch (e) { /* already gone */ }
  }
  return { report, leftBehind: (await invoke('list_tasks', { onlyOpen: false })).length };
})()
