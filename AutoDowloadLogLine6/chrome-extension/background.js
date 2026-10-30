const JOB_KEY = 'lwsMachineEventJob';
const NEXT_TASK_ALARM = 'lwsNextMachineEventTask';
const DAILY_ALARM = 'lwsDailyMachineEventTask';
const DAILY_CATCHUP_ALARM = 'lwsDailyMachineEventCatchup';
const DAILY_STATUS_KEY = 'lwsMachineEventDailyStatus';
const STATUS_CLEANUP_ALARM = 'lwsMachineEventStatusCleanup';
const STATUS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_KEY = 'lwsMachineEventLogs';
const LOG_LIMIT = 1000;

async function writeLog(level, event, details = {}) {
  try {
    const { [LOG_KEY]: current = [] } = await chrome.storage.local.get(LOG_KEY);
    current.push({ time: new Date().toISOString(), level, event, details });
    await chrome.storage.local.set({ [LOG_KEY]: current.slice(-LOG_LIMIT) });
  } catch (error) {
    console.error('LWS could not save diagnostic log:', error);
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function pruneDailyStatus() {
  const { [DAILY_STATUS_KEY]: status } = await chrome.storage.local.get(DAILY_STATUS_KEY);
  if (status?.updatedAt && Date.now() - status.updatedAt >= STATUS_RETENTION_MS) {
    await chrome.storage.local.remove(DAILY_STATUS_KEY);
  }
}

async function ensureStatusCleanupAlarm() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(0, 15, 0, 0);
  await chrome.alarms.create(STATUS_CLEANUP_ALARM, {
    when: next.getTime(),
    periodInMinutes: 1440,
  });
}

async function scheduleCatchupIfMissed(force = false) {
  const now = new Date();
  if (now.getHours() < 8) return false;
  const [{ lwsMachineEventDaily: daily }, { [DAILY_STATUS_KEY]: status }] = await Promise.all([
    chrome.storage.local.get('lwsMachineEventDaily'),
    chrome.storage.local.get(DAILY_STATUS_KEY),
  ]);
  const today = localDateKey(now);
  if (!daily) return false;
  if (status?.runDate === today) {
    if (status.status === 'completed') return false;
    if (status.status === 'failed' && !force) return false;
    if (status.status === 'running' && Date.now() - (status.updatedAt || Date.now()) < 15 * 60_000) return false;
  }
  if (await chrome.alarms.get(DAILY_CATCHUP_ALARM)) return true;
  await chrome.alarms.create(DAILY_CATCHUP_ALARM, { when: Date.now() + 60_000 });
  return true;
}

async function ensureDailyAlarm() {
  const { lwsMachineEventDaily: daily } = await chrome.storage.local.get('lwsMachineEventDaily');
  if (!daily) return;
  if (!(await chrome.alarms.get(DAILY_ALARM))) {
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    await chrome.alarms.create(DAILY_ALARM, { when: next.getTime(), periodInMinutes: 1440 });
    await writeLog('info', 'daily-alarm-restored', { scheduledAt: next.toISOString() });
  }
  await scheduleCatchupIfMissed();
}

// Reconcile alarms whenever Chrome starts this MV3 service worker. The worker
// can be started by an alarm, message, or popup, so catch-up must not depend on
// the popup's checkCatchup message to recover a missed daily run.
void ensureDailyAlarm().catch((error) => writeLog('error', 'startup-alarm-check-failed', { message: errorText(error) }));

void pruneDailyStatus();
void ensureStatusCleanupAlarm();
chrome.runtime.onStartup.addListener(() => {
  void pruneDailyStatus();
  void ensureStatusCleanupAlarm();
  void ensureDailyAlarm().catch((error) => writeLog('error', 'startup-alarm-check-failed', { message: errorText(error) }));
});
chrome.runtime.onInstalled.addListener(() => {
  void pruneDailyStatus();
  void ensureStatusCleanupAlarm();
  void ensureDailyAlarm().catch((error) => writeLog('error', 'install-alarm-check-failed', { message: errorText(error) }));
});

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function previousDateKey(date = new Date()) {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return localDateKey(previous);
}

async function saveDailyStatus(status) {
  await chrome.storage.local.set({ [DAILY_STATUS_KEY]: { ...status, updatedAt: Date.now() } });
}

function registerDownloadFoldering() {
  if (!chrome.downloads || registerDownloadFoldering.registered) return;
  if (chrome.downloads.onDeterminingFilename) {
    chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
      const filename = String(downloadItem.filename || '').split(/[\\/]/).pop();
      const match = filename.match(/^(\d{4})(\d{2})(\d{2})_.*\.csv$/i);
      if (!match) {
        suggest();
        return;
      }

      const dateFolder = `${match[1]}-${match[2]}-${match[3]}`;
      suggest({ filename: `${dateFolder}/${filename}`, conflictAction: 'uniquify' });
    });
  }
  if (chrome.downloads.onCreated) {
    chrome.downloads.onCreated.addListener((item) => {
      void writeLog('info', 'download-created', { id: item.id, filename: item.filename, state: item.state, tabId: item.tabId });
    });
  }
  if (chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (delta.error?.current) {
        void writeLog('error', 'download-failed', { id: delta.id, error: delta.error.current });
      } else if (delta.state?.current) {
        void writeLog('info', 'download-state-changed', { id: delta.id, state: delta.state.current });
      }
    });
  }
  registerDownloadFoldering.registered = true;
}

registerDownloadFoldering();
chrome.permissions.onAdded.addListener(registerDownloadFoldering);

async function getJob() {
  return (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || null;
}

async function saveJob(job) {
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

async function waitForTabLoad(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Machine Event tab load timed out'));
    }, 30000);
    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function runDailyFlow(tabId, eventUrl) {
  let loginSubmitted = false;
  let redirectedToEvent = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const result = await chrome.tabs.sendMessage(tabId, {
      action: 'dailyStart',
      canSubmitLogin: !loginSubmitted,
    });
    if (result?.state === 'started') {
      await writeLog('info', 'daily-login-ready', { tabId });
      return { ok: true };
    }
    if (result?.state === 'submitted') {
      loginSubmitted = true;
      await writeLog('info', 'daily-login-submitted', { tabId });
    }
    else if (result?.state === 'navigate-event-url') {
      redirectedToEvent = true;
      await writeLog('info', 'daily-opening-machine-event-link', { tabId, url: result.url });
      await chrome.tabs.update(tabId, { url: result.url });
    }
    else if (result?.state === 'login-failed' || result?.state === 'login-unavailable') {
      await writeLog('error', 'daily-login-failed', { state: result.state, message: result.message, tabId });
      console.warn(`LWS daily login stopped: ${result.message}`);
      return { ok: false, message: result.message };
    } else if (result?.state === 'no-date') {
      await writeLog('error', 'daily-data-unavailable', { message: result.message, tabId });
      return { ok: false, message: result.message };
    } else if (result?.state === 'unknown-page') {
      if (redirectedToEvent) {
        console.warn(`LWS daily flow stopped: ${result.message}`);
        return { ok: false, message: result.message };
      }
      redirectedToEvent = true;
      await writeLog('info', 'daily-returning-to-event-page', { tabId });
      await chrome.tabs.update(tabId, { url: eventUrl });
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await waitForTabLoad(tabId);
  }
  console.warn('LWS daily flow stopped after too many page transitions.');
  return { ok: false, message: 'Quá nhiều lần chuyển trang khi đăng nhập.' };
}

async function triggerCurrentTask() {
  const job = await getJob();
  if (!job?.running) return;
  if (job.position >= job.tasks.length) {
    job.running = false;
    job.clickPending = false;
    await saveJob(job);
    if (job.source === 'daily') {
      const skipped = job.failedTasks?.length || 0;
      await saveDailyStatus({ runDate: job.runDate, dataDate: job.dataDate, status: 'completed', total: job.total, skipped, message: skipped ? `Hoàn tất; đã bỏ qua ${skipped} lượt lỗi.` : 'Đã bấm tải đủ các machine.' });
    }
    return;
  }

  const task = job.tasks[job.position];
  job.clickPending = true;
  await saveJob(job);

  try {
    await chrome.scripting.executeScript({ target: { tabId: job.tabId }, files: ['content.js'] });
    const result = await chrome.tabs.sendMessage(job.tabId, { action: 'downloadTask', task });
    const current = await getJob();
    if (current?.id !== job.id) return;
    current.clickPending = false;
    if (!result?.ok) {
      if (result?.fatal) {
        current.running = false;
        current.error = result.message || 'Trang Machine Event không sẵn sàng.';
        await saveJob(current);
        await writeLog('error', 'task-halted', {
          date: task.date, machine: task.machineLabel, position: job.position,
          message: current.error, url: result.url, pageText: result.pageText,
          selectors: result.selectors, availableMachines: result.availableMachines, availableDates: result.availableDates,
        });
        if (current.source === 'daily') {
          await saveDailyStatus({ runDate: current.runDate, dataDate: current.dataDate, status: 'failed', total: current.total,
            message: `Đã dừng tại lượt ${current.position + 1}/${current.total}: ${current.error}` });
        }
        return;
      }
      await skipFailedTask(current, job.position, result?.message || 'Không thể bấm xuất file ở lượt hiện tại.');
      return;
    }
    await writeLog('info', 'task-clicked', { date: task.date, machine: task.machineLabel, position: job.position, url: result.url });
    current.position = Math.max(current.position, job.position + 1);
    current.error = null;
    if (current.position >= current.total) {
      current.running = false;
      if (current.source === 'daily') {
        const skipped = current.failedTasks?.length || 0;
        await saveDailyStatus({ runDate: current.runDate, dataDate: current.dataDate, status: 'completed', total: current.total, skipped, message: skipped ? `Hoàn tất; đã bỏ qua ${skipped} lượt lỗi.` : 'Đã bấm tải đủ các machine.' });
      }
    }
    await saveJob(current);
    if (current.running) await chrome.alarms.create(NEXT_TASK_ALARM, { when: Date.now() + 15000 });
  } catch (error) {
    const current = await getJob();
    if (current?.id !== job.id) return;
    await writeLog('error', 'download-task-failed', { message: errorText(error), position: job.position, source: job.source });
    await skipFailedTask(current, job.position, error.message || 'Không kết nối được với trang Machine Event.');
  }
}

async function skipFailedTask(job, position, reason) {
  const task = job.tasks[position];
  job.position = Math.max(job.position, position + 1);
  job.clickPending = false;
  job.failedTasks = [...(job.failedTasks || []), {
    date: task?.date || null,
    machine: task?.machineLabel || 'không rõ',
    reason,
  }];
  job.error = null;
  await writeLog('error', 'task-skipped', { date: task?.date || null, machine: task?.machineLabel || 'không rõ', reason, position });
  job.running = job.position < job.total;
  await saveJob(job);

  const skipped = job.failedTasks.length;
  if (job.source === 'daily' && !job.running) {
    await saveDailyStatus({
      runDate: job.runDate, dataDate: job.dataDate, status: 'completed',
      total: job.total, skipped, message: `Hoàn tất; đã bỏ qua ${skipped} lượt lỗi.`,
    });
  }
  if (job.running) await chrome.alarms.create(NEXT_TASK_ALARM, { when: Date.now() + 15000 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action === 'checkCatchup') {
      return { scheduled: await scheduleCatchupIfMissed(true) };
    }
    if (message.action === 'exportLogs') {
      const { [LOG_KEY]: logs = [] } = await chrome.storage.local.get(LOG_KEY);
      return { logs };
    }
    if (message.action === 'updateDailyPage') {
      if (!sender.tab?.id || !message.url) return { ok: false };
      const { lwsMachineEventDaily: daily } = await chrome.storage.local.get('lwsMachineEventDaily');
      if (!daily) return { ok: false };
      const oldOrigin = new URL(daily.url).origin;
      const newUrl = new URL(message.url);
      if (newUrl.origin !== oldOrigin || /\/Login\.do$/i.test(newUrl.pathname)) return { ok: false };
      daily.url = newUrl.href;
      daily.tabId = sender.tab.id;
      await chrome.storage.local.set({ lwsMachineEventDaily: daily });
      await writeLog('info', 'daily-machine-event-url-updated', { url: daily.url, tabId: daily.tabId });
      return { ok: true };
    }
    if (message.action === 'beginJob') {
      const tasks = message.tasks;
      if (!sender.tab?.id || !Array.isArray(tasks) || !tasks.length) return { message: 'Không có lượt tải hợp lệ.' };
      const job = {
        id: crypto.randomUUID(), running: true, clickPending: false, tasks,
        position: 0, total: tasks.length, tabId: sender.tab.id, error: null,
        source: message.source || 'manual', runDate: message.runDate || null, dataDate: message.dataDate || null,
      };
      await saveJob(job);
      await triggerCurrentTask();
      return { message: `Bắt đầu tự tải ${tasks.length} lượt.` };
    }

    if (message.action === 'enableDaily') {
      if (!sender.tab?.id || !sender.tab.url) return { message: 'Hãy bật lịch trên tab Machine Event.' };
      await chrome.storage.local.set({ lwsMachineEventDaily: { tabId: sender.tab.id, url: sender.tab.url } });
      const next = new Date();
      next.setHours(8, 0, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      await chrome.alarms.create(DAILY_ALARM, { when: next.getTime(), periodInMinutes: 1440 });
      await writeLog('info', 'daily-schedule-enabled', { url: sender.tab.url, nextRun: next.toISOString() });
      await scheduleCatchupIfMissed();
      return { message: 'Đã bật lịch 08:00 mỗi ngày. Nếu hôm nay quá 08:00 mà chưa hoàn tất, extension sẽ tự chạy bù trong khoảng một phút.' };
    }

    if (message.action === 'disableDaily') {
      await chrome.storage.local.remove('lwsMachineEventDaily');
      await chrome.alarms.clear(DAILY_ALARM);
      await writeLog('info', 'daily-schedule-disabled');
      return { message: 'Đã tắt lịch tải tự động hằng ngày.' };
    }

    if (message.action === 'resumeJob') {
      const job = await getJob();
      if (!job || job.position >= job.total) return { message: 'Không còn lượt nào để tiếp tục.' };
      if (job.running && (job.clickPending || job.position < job.total)) return { message: `Đang tự bấm tải ${Math.min(job.position + 1, job.total)}/${job.total}.` };
      job.tabId = sender.tab?.id ?? job.tabId;
      job.running = true;
      job.error = null;
      await saveJob(job);
      if (job.clickPending) return { message: `Đang bấm lượt ${job.position + 1}/${job.total}.` };
      await triggerCurrentTask();
      return { message: `Tiếp tục tự tải từ lượt ${job.position + 1}/${job.total}.` };
    }

    if (message.action === 'stopJob') {
      const job = await getJob();
      if (job) {
        job.running = false;
        await saveJob(job);
      }
      await chrome.alarms.clear(NEXT_TASK_ALARM);
      return { message: 'Đã dừng các lượt bấm tiếp theo.' };
    }

    if (message.action === 'resetJob') {
      await chrome.storage.local.remove(JOB_KEY);
      await chrome.alarms.clear(NEXT_TASK_ALARM);
      return { message: 'Đã xóa tiến độ. Nhập khoảng ngày mới rồi nhấn Start.' };
    }
  })().then(sendResponse).catch(async (error) => {
    await writeLog('error', 'message-handler-failed', { action: message.action, message: errorText(error) });
    sendResponse({ message: error.message || 'Có lỗi khi thao tác.' });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
  await writeLog('info', 'alarm-fired', { name: alarm.name, scheduledTime: alarm.scheduledTime });
  if (alarm.name === STATUS_CLEANUP_ALARM) {
    await pruneDailyStatus();
    return;
  }
  if (alarm.name === NEXT_TASK_ALARM) {
    const job = await getJob();
    if (job?.running && !job.clickPending) await triggerCurrentTask();
    return;
  }
  if (alarm.name === DAILY_ALARM || alarm.name === DAILY_CATCHUP_ALARM) {
    const { lwsMachineEventDaily: daily } = await chrome.storage.local.get('lwsMachineEventDaily');
    if (!daily?.tabId) return;
    const job = await getJob();
    if (job?.running) return;
    const runDate = localDateKey();
    const dataDate = previousDateKey();
    const { [DAILY_STATUS_KEY]: previousStatus } = await chrome.storage.local.get(DAILY_STATUS_KEY);
    if (previousStatus?.runDate === runDate && previousStatus.status === 'completed') return;
    await saveDailyStatus({ runDate, dataDate, status: 'running', message: 'Đang mở trang và tải log.' });
    await writeLog('info', 'daily-run-started', { runDate, dataDate });
    try {
      const origin = new URL(daily.url).origin;
      let tabId = daily.tabId;
      let tab = null;
      try { tab = await chrome.tabs.get(tabId); } catch { /* Find or reopen it below. */ }
      if (!tab || !tab.url?.startsWith(origin)) {
        const [existingTab] = await chrome.tabs.query({ url: `${origin}/*` });
        tab = existingTab || await chrome.tabs.create({ url: daily.url, active: false });
        tabId = tab.id;
        if (existingTab && new URL(existingTab.url).pathname !== new URL(daily.url).pathname) {
          await chrome.tabs.update(tabId, { url: daily.url });
          await waitForTabLoad(tabId);
        } else if (!existingTab) {
          await waitForTabLoad(tabId);
        }
        daily.tabId = tabId;
        await chrome.storage.local.set({ lwsMachineEventDaily: daily });
      } else if (new URL(tab.url).pathname !== new URL(daily.url).pathname) {
        await chrome.tabs.update(tabId, { url: daily.url });
        await waitForTabLoad(tabId);
      }
      const result = await runDailyFlow(tabId, daily.url);
      if (!result?.ok) {
        await writeLog('error', 'daily-run-failed', { message: result?.message || 'Không hoàn tất được lượt tải.', runDate });
        await saveDailyStatus({ runDate, dataDate, status: 'failed', message: result?.message || 'Không hoàn tất được lượt tải.' });
      } else await writeLog('info', 'daily-run-dispatched', { runDate, tabId });
    } catch (error) {
      await writeLog('error', 'daily-run-exception', { message: errorText(error), runDate });
      await saveDailyStatus({ runDate, dataDate, status: 'failed', message: 'Không mở được trang Machine Event.' });
      console.warn('LWS daily download skipped: the saved Machine Event tab is unavailable.');
    }
  }
  } catch (error) {
    await writeLog('error', 'alarm-handler-failed', { name: alarm.name, message: errorText(error) });
  }
});
