// Drives the actual New Task dialog: opens it, types a title, clicks "Pick", then
// "Save", and reports what the app ended up with. This is the path a user takes,
// which a direct invoke() probe cannot cover.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = {};

  openTaskEditor();
  await wait(250);
  const title = document.querySelector('[data-f="title"]');
  step.modalOpened = !!title;
  if (!title) return { step, error: 'task editor did not open' };

  title.value = 'DOM flow task';
  title.dispatchEvent(new Event('input', { bubbles: true }));

  const pick = document.querySelector('[data-alarm-pick]');
  step.pickButtonFound = !!pick;
  step.alarmStateBefore = document.querySelector('[data-alarmstate]')?.textContent?.trim();
  pick?.click();
  await wait(150);
  step.alarmStateAfterPick = document.querySelector('[data-alarmstate]')?.textContent?.trim();

  // Also exercise the priority dropdown, which saves through a different handler.
  const sel = document.querySelector('[data-f="priority"]');
  if (sel) { sel.value = 'high'; sel.dispatchEvent(new Event('change', { bubbles: true })); }

  S.lastError = null;
  const save = document.querySelector('[data-save]');
  step.saveButtonFound = !!save;
  save?.click();
  await wait(1400);

  step.modalClosed = !document.querySelector('[data-save]');
  step.commandError = S.lastError;
  const tasks = await window.__TAURI__.core.invoke('list_tasks', { onlyOpen: false });
  const created = tasks.find((t) => t.title === 'DOM flow task');
  step.taskCreated = !!created;
  step.task = created ? { id: created.id, priority: created.priority, alarmFireAt: created.alarmFireAt } : null;
  step.toastText = [...document.querySelectorAll('.toast, [data-toast]')].map((n) => n.textContent.trim().slice(0, 90));

  if (created) {
    try { await window.__TAURI__.core.invoke('delete_task', { id: created.id }); } catch (e) { /* ignore */ }
  }
  step.tasksLeftBehind = (await window.__TAURI__.core.invoke('list_tasks', { onlyOpen: false })).length;
  return step;
})()
