// One clean pass with a future time, then deletes the task to watch the alarm be
// disarmed rather than left firing at a task that no longer exists.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const layers = () => document.querySelectorAll('#modalHost .modal-layer');
  const q = (s) => layers()[layers().length - 1].querySelector(s);
  const invoke = window.__TAURI__.core.invoke;
  const out = [];

  openTaskEditor();
  await wait(250);
  q('[data-f="title"]').value = 'Disarm probe';
  q('[data-alarm-pick]').click();
  await wait(250);
  const ti = q('[data-timeinput]');
  ti.focus();
  ti.value = '23:45';
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(120);
  out.push({ chosen: q('[data-dialreadout]').textContent, summary: q('[data-summary]').textContent });
  q('[data-save]').click();
  await wait(200);
  out.push({ backToEditor: layers().length, alarmState: document.querySelector('[data-alarmstate]')?.textContent?.trim() });
  q('[data-save]').click();
  await wait(1200);

  const task = (await invoke('list_tasks', { onlyOpen: false })).find((t) => t.title === 'Disarm probe');
  const alarm = (await invoke('list_alarms')).find((a) => a.taskId === task?.id);
  out.push({
    taskAlarmFireAt: task?.alarmFireAt ? new Date(task.alarmFireAt * 1000).toLocaleTimeString('en-GB') : null,
    alarmLabel: alarm?.label,
    alarmState: alarm?.state,
  });

  await invoke('delete_task', { id: task.id });
  await wait(150);
  const after = (await invoke('list_alarms')).find((a) => a.id === alarm.id);
  out.push({
    afterTaskDelete: { exists: !!after, state: after?.state, stillLinked: after?.taskId ?? null },
  });
  const hist = await invoke('list_alarm_history', { alarmId: null, limit: 8, alarm_id: null, limit: 8 });
  out.push({ lastEvents: hist.slice(0, 4).map((h) => `${h.event}${h.note ? ' — ' + h.note : ''}`) });

  if (after) await invoke('delete_alarm', { id: after.id });
  out.push({ cleanedUp: (await invoke('list_alarms')).filter((a) => a.label === 'Reminder: Disarm probe').length === 0 });
  return out;
})()
