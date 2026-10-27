// Drives the new picker end to end: task dialog -> "Pick time" -> typed time ->
// arrow keys -> clock dial -> save, then reports what actually landed in the DB.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Always act on the topmost dialog; a global querySelector would hit the editor
  // underneath the picker, which no user can reach through the scrim.
  const top = () => document.querySelectorAll('#modalHost .modal-layer');
  const q = (s) => top()[top().length - 1]?.querySelector(s) ?? document.querySelector(s);
  const out = { steps: [] };
  const note = (k, v) => out.steps.push({ [k]: v });

  openTaskEditor();
  await wait(250);
  q('[data-f="title"]').value = 'Picker flow task';

  note('layersBeforePick', top().length);
  q('[data-alarm-pick]').click();
  await wait(300);

  note('layersAfterPick', top().length);
  note('titles', [...document.querySelectorAll('.modal-title')].map((n) => n.textContent));
  note('editorDraftSurvived', q('[data-f="title"]')?.value);
  note('dialPresent', !!q('[data-dial]'));
  note('timeFieldPresent', !!q('[data-timeinput]'));
  note('timeFieldFocused', document.activeElement === q('[data-timeinput]'));

  // --- typed entry ----------------------------------------------------------
  const ti = q('[data-timeinput]');
  ti.focus();
  ti.value = '07:15pm';
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(80);
  note('typed_0715pm', {
    hh: q('[data-hhval]').textContent,
    mm: q('[data-mmval]').textContent,
    readout: q('[data-dialreadout]').textContent,
    summary: q('[data-summary]').textContent,
  });

  ti.value = '6:45';
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(80);
  note('typed_645', { readout: q('[data-dialreadout]').textContent });

  ti.value = '25:99';
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(80);
  note('rejects_nonsense', { readout: q('[data-dialreadout]').textContent, flagged: ti.classList.contains('is-bad') });

  // --- keyboard stepping ----------------------------------------------------
  ti.value = '08:00';
  ti.dispatchEvent(new Event('input', { bubbles: true }));
  ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
  await wait(80);
  note('shift_arrow_up_from_0800', q('[data-dialreadout]').textContent);
  ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await wait(80);
  note('arrow_down', q('[data-dialreadout]').textContent);

  // --- the clock face -------------------------------------------------------
  const dial = q('[data-dial]');
  const svg = dial.querySelector('svg');
  const box = svg.getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const r = box.width * 0.4;
  const pointAt = (deg) => ({
    x: cx + Math.sin(deg * Math.PI / 180) * r,
    y: cy - Math.cos(deg * Math.PI / 180) * r,
  });
  const fire = (type, p) => dial.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y,
  }));

  // 90deg is 3 o'clock -> hour 3
  let p = pointAt(90);
  fire('pointerdown', p); fire('pointerup', p);
  await wait(120);
  note('dial_point_3oclock', {
    readout: q('[data-dialreadout]').textContent,
    handMovedTo: dial.classList.contains('is-minute') ? 'minutes (auto-advanced)' : 'hours',
  });

  // Now in minute mode: 180deg is the bottom -> 30 minutes
  p = pointAt(180);
  fire('pointerdown', p); fire('pointerup', p);
  await wait(120);
  note('dial_point_minutes_180deg', q('[data-dialreadout]').textContent);

  // --- save through the stacked dialog --------------------------------------
  const before = (await window.__TAURI__.core.invoke('list_tasks', { onlyOpen: false })).length;
  q('[data-save]').click();   // topmost save = the picker
  await wait(250);
  note('afterPickerSave', {
    layers: top().length,
    alarmState: document.querySelector('[data-alarmstate]')?.textContent,
  });
  q('[data-save]').click();
  await wait(1200);

  const tasks = await window.__TAURI__.core.invoke('list_tasks', { onlyOpen: false });
  const created = tasks.find((t) => t.title === 'Picker flow task');
  note('taskCreated', !!created);
  note('task', created ? { id: created.id, alarmFireAt: created.alarmFireAt, localTime: created.alarmFireAt ? new Date(created.alarmFireAt * 1000).toLocaleTimeString('en-GB') : null } : null);
  const alarms = (await window.__TAURI__.core.invoke('list_alarms')).filter((a) => a.taskId === created?.id);
  note('linkedAlarms', alarms.map((a) => ({ label: a.label, state: a.state, localTime: new Date(a.fireAt * 1000).toLocaleTimeString('en-GB') })));
  note('tasksDelta', tasks.length - before);
  note('commandError', S.lastError);
  note('layersAtEnd', top().length);

  if (created) { try { await window.__TAURI__.core.invoke('delete_task', { id: created.id }); } catch (e) {} }
  note('cleanedUp', (await window.__TAURI__.core.invoke('list_tasks', { onlyOpen: false })).length === before);
  return out.steps;
})()
