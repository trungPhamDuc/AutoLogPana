const statusEl = document.getElementById('status');
const fromEl = document.getElementById('from');
const toEl = document.getElementById('to');
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('Không tìm thấy tab đang mở.');
  return tab;
}

async function allowMultipleDownloads(tab) {
  let url;
  try { url = new URL(tab.url); }
  catch { throw new Error('Không đọc được địa chỉ trang hiện tại.'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Chỉ bật tải nhiều tệp được trên trang web HTTP hoặc HTTPS.');
  }

  await chrome.contentSettings.automaticDownloads.set({
    primaryPattern: `${url.origin}/*`,
    setting: 'allow',
    scope: 'regular',
  });
}

async function send(action, data = {}) {
  const tab = await activeTab();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tab.id, { action, ...data });
  } catch {
    throw new Error('Không thể chạy trên tab này. Hãy mở trang Machine Event rồi bấm lại biểu tượng extension.');
  }
}

function yesterdayLocal() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

const yesterday = yesterdayLocal();
fromEl.value = yesterday;
toEl.value = yesterday;


document.getElementById('start').addEventListener('click', async () => {
  if (!fromEl.value || !toEl.value) {
    statusEl.textContent = 'Chọn ngày bắt đầu và kết thúc.';
    return;
  }
  if (toEl.value < fromEl.value) {
    statusEl.textContent = 'Ngày kết thúc phải bằng hoặc sau ngày bắt đầu.';
    return;
  }
  try {
    const granted = await chrome.permissions.request({ permissions: ['contentSettings', 'downloads'] });
    if (!granted) throw new Error('Cần cấp quyền tải xuống để tự cho phép nhiều tệp và xếp file vào thư mục theo ngày.');
    const tab = await activeTab();
    await allowMultipleDownloads(tab);
    const result = await send('start', {
      from: fromEl.value,
      to: toEl.value,
    });
    statusEl.textContent = result.message;
  } catch (error) { statusEl.textContent = error.message; }
});

document.getElementById('stop').addEventListener('click', async () => {
  try { statusEl.textContent = (await send('stop')).message; }
  catch (error) { statusEl.textContent = error.message; }
});

document.getElementById('daily').addEventListener('click', async () => {
  try {
    const { lwsMachineEventDaily: existing } = await chrome.storage.local.get('lwsMachineEventDaily');
    if (existing) {
      const result = await send('disableDaily');
      statusEl.textContent = result.message;
      if (result.message === 'Đã tắt lịch tải tự động hằng ngày.') {
        document.getElementById('daily').textContent = 'Bật tự tải hằng ngày';
        document.getElementById('dailyStatus').textContent = 'Lịch tải tự động đang tắt.';
      }
      return;
    }
    const tab = await activeTab();
    let url;
    try { url = new URL(tab.url); } catch { throw new Error('Không đọc được địa chỉ trang hiện tại.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Hãy mở trang Machine Event trước.');
    const host = `${url.origin}/*`;
    const granted = await chrome.permissions.request({
      permissions: ['contentSettings', 'downloads'],
      origins: [host],
    });
    if (!granted) throw new Error('Cần cấp quyền trang và tải xuống để chạy tự động hằng ngày.');
    await allowMultipleDownloads(tab);
    const result = await send('enableDaily');
    statusEl.textContent = result.message;
    if (result.message.startsWith('Đã bật lịch')) {
      document.getElementById('daily').textContent = 'Tắt tự tải hằng ngày';
      document.getElementById('dailyStatus').textContent = 'Lịch đang bật; chưa ghi nhận lượt tải hôm nay.';
    }
  } catch (error) { statusEl.textContent = error.message; }
});

document.getElementById('reset').addEventListener('click', async () => {
  try { statusEl.textContent = (await send('reset')).message; }
  catch (error) { statusEl.textContent = error.message; }
});

document.getElementById('downloadLogs').addEventListener('click', async () => {
  const button = document.getElementById('downloadLogs');
  button.disabled = true;
  try {
    const { logs = [] } = await chrome.runtime.sendMessage({ action: 'exportLogs' });
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), logs }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lws-machine-event-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    statusEl.textContent = `Đã tạo file log (${logs.length} mục).`;
  } catch (error) {
    statusEl.textContent = `Không tạo được file log: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

chrome.storage.local.get('lwsMachineEventJob').then(({ lwsMachineEventJob: job }) => {
  if (!job) return;
  if (job.error) statusEl.textContent = job.error;
  else if (job.running) statusEl.textContent = `Đang tải ${Math.min(job.position + 1, job.total)}/${job.total}.`;
  else if (job.position < job.total) statusEl.textContent = `Đã dừng tại ${job.position}/${job.total}. Start để tiếp tục hoặc Reset để làm mới.`;
  else statusEl.textContent = `Hoàn tất ${job.total}/${job.total} lượt.${job.failedTasks?.length ? ` Đã bỏ qua ${job.failedTasks.length} lượt lỗi.` : ''}`;
});

chrome.storage.local.get('lwsMachineEventDaily').then(({ lwsMachineEventDaily: daily }) => {
  if (daily) document.getElementById('daily').textContent = 'Tắt tự tải hằng ngày';
});

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

Promise.all([
  chrome.storage.local.get('lwsMachineEventDaily'),
  chrome.storage.local.get('lwsMachineEventDailyStatus'),
]).then(([{ lwsMachineEventDaily: daily }, { lwsMachineEventDailyStatus: saved }]) => {
  const dailyStatusEl = document.getElementById('dailyStatus');
  const today = localDateString();
  if (!daily) {
    dailyStatusEl.textContent = 'Lịch tải tự động đang tắt.';
    return;
  }
  if (!saved) {
    dailyStatusEl.textContent = 'Lịch đang bật; chưa ghi nhận lượt tải nào.';
    return;
  }
  const state = saved.status === 'completed'
    ? (saved.skipped ? `hoàn tất, bỏ qua ${saved.skipped} lượt lỗi` : 'đã bấm tải đủ')
    : saved.status === 'running' ? 'đang chạy' : 'bị lỗi';
  const todayNote = saved.runDate === today ? `Hôm nay ${state} log ngày ${saved.dataDate || ''}.` : `Hôm nay chưa chạy; lần gần nhất ${saved.runDate} ${state} log ngày ${saved.dataDate || ''}.`;
  dailyStatusEl.textContent = `${todayNote}${saved.total ? ` Số lượt: ${saved.total}.` : ''}${saved.message && (saved.status !== 'completed' || saved.skipped) ? ` ${saved.message}` : ''}`;
});

chrome.runtime.sendMessage({ action: 'checkCatchup' }).then(({ scheduled }) => {
  if (scheduled) {
    document.getElementById('dailyStatus').textContent = 'Hôm nay chưa hoàn tất; extension đã lên lịch chạy bù trong khoảng một phút.';
  }
}).catch(() => {});
