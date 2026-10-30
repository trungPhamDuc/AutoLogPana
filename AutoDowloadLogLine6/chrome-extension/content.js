(() => {
  if (window.__lwsMachineEventExtensionLoaded) return;
  window.__lwsMachineEventExtensionLoaded = true;
  const STORAGE_KEY = 'lwsMachineEventJob';
  const DAY_MS = 86400000;
  const LOGIN_USERNAME = 'pfsc';
  const LOGIN_PASSWORD = '1qaz2wsx';

  function parseDate(text) {
    const raw = String(text || '').trim();
    let match = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return null;
  }

  function identify() {
    const selects = [...document.querySelectorAll('select')].map((element) => ({
      element,
      options: [...element.options].map((option) => ({
        value: option.value,
        label: (option.textContent || '').trim(),
        date: parseDate(option.textContent) || parseDate(option.value),
      })),
    }));
    const dateSelect = selects.find((item) => item.options.filter((option) => option.date).length >= 2);
    const machineSelect = selects.find((item) => item !== dateSelect && item.options.some((option) =>
      /NPM\s*[-_]?[\w]+|machine\s*\d+/i.test(option.label)));
    const candidates = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="image"], a')];
    const exportButton = candidates.find((element) => {
      const label = [element.innerText, element.value, element.title, element.getAttribute('aria-label')].filter(Boolean).join(' ');
      return /output\s+event/i.test(label) && /csv/i.test(label);
    });
    return { dateSelect, machineSelect, exportButton };
  }

  function isSpd2(option) {
    return /(^|[^A-Z0-9])SPD0?2([^A-Z0-9]|$)/i.test(`${option.label} ${option.value}`);
  }

  function selectValue(element, value) {
    if (!element || ![...element.options].some((option) => option.value === value)) return false;
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function getJob() {
    return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || null;
  }

  async function putJob(job) {
    await chrome.storage.local.set({ [STORAGE_KEY]: job });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message.action === 'downloadTask') {
        const task = message.task;
        const pageText = (document.body?.innerText || '').slice(0, 300);
        if (/session has ended|not logged in|session time out/i.test(pageText)) {
          return { ok: false, fatal: true, message: 'Phiên đăng nhập đã hết hạn trước khi chọn machine.', url: location.href, pageText };
        }
        let controls = identify();
        if (!controls.dateSelect || !controls.machineSelect || !controls.exportButton) {
          return { ok: false, fatal: true, message: 'Trang không còn các điều khiển Machine Event cần thiết.', url: location.href,
            selectors: { selectCount: document.querySelectorAll('select').length, date: !!controls.dateSelect, machine: !!controls.machineSelect, export: !!controls.exportButton }, pageText };
        }
        let machineOption = controls.machineSelect.options.find((option) => option.value === task.machineValue);
        if (!machineOption) {
          return { ok: false, fatal: true, message: `Không còn option máy ${task.machineLabel} (${task.machineValue}).`, url: location.href,
            availableMachines: controls.machineSelect.options.map((option) => ({ value: option.value, label: option.label })) };
        }
        if (!selectValue(controls.machineSelect.element, task.machineValue)) {
          return { ok: false, fatal: true, message: `Không chọn được option máy ${task.machineLabel}.`, url: location.href };
        }

        // Changing a machine can refresh/rebuild the date selector on this page.
        await new Promise((resolve) => setTimeout(resolve, 600));
        controls = identify();
        if (!controls.dateSelect || !controls.machineSelect || !controls.exportButton) {
          return { ok: false, fatal: true, message: 'Trang đã thay đổi sau khi chọn máy; không tìm lại được các điều khiển.', url: location.href,
            selectors: { selectCount: document.querySelectorAll('select').length, date: !!controls.dateSelect, machine: !!controls.machineSelect, export: !!controls.exportButton } };
        }
        machineOption = controls.machineSelect.options.find((option) => option.value === task.machineValue);
        if (!machineOption) {
          return { ok: false, fatal: true, message: `Option máy ${task.machineLabel} biến mất sau khi chọn.`, url: location.href,
            availableMachines: controls.machineSelect.options.map((option) => ({ value: option.value, label: option.label })) };
        }
        if (controls.machineSelect.element.value !== task.machineValue && !selectValue(controls.machineSelect.element, task.machineValue)) {
          return { ok: false, fatal: true, message: `Không giữ được lựa chọn máy ${task.machineLabel}.`, url: location.href };
        }
        const dateOption = controls.dateSelect.options.find((option) => option.date === task.date);
        if (!dateOption) {
          return { ok: false, fatal: true, message: `Dropdown ngày không có ${task.date} sau khi chọn máy ${task.machineLabel}.`, url: location.href,
            availableDates: controls.dateSelect.options.map((option) => ({ value: option.value, label: option.label, date: option.date })) };
        }
        if (!selectValue(controls.dateSelect.element, dateOption.value)) {
          return { ok: false, fatal: true, message: `Không chọn được ngày ${task.date}.`, url: location.href };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        controls = identify();
        if (!controls.exportButton) return { ok: false, fatal: true, message: 'Không tìm thấy nút xuất CSV sau khi chọn máy/ngày.', url: location.href };
        controls.exportButton.click();
        return { ok: true, url: location.href, machine: task.machineLabel, date: task.date };
      }
      if (message.action === 'dailyStart') {
        const controls = identify();
        if (!controls.dateSelect || !controls.machineSelect || !controls.exportButton) {
          const passwordInput = [...document.querySelectorAll('input[type="password"]')]
            .find((input) => !input.disabled && input.getClientRects().length);
          if (passwordInput) {
            const form = passwordInput.form;
            const usernameInput = [...(form || document).querySelectorAll('input:not([type]), input[type="text"], input[type="email"]')]
              .find((input) => !input.disabled && input.getClientRects().length);
            if (!usernameInput || !form) return { state: 'login-unavailable', message: 'Không nhận diện được form đăng nhập.' };
            if (!message.canSubmitLogin) return { state: 'login-failed', message: 'Đăng nhập chưa thành công; kiểm tra tài khoản, mật khẩu hoặc yêu cầu xác minh.' };
            const setInput = (input, value) => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
              setter.call(input, value);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setInput(usernameInput, LOGIN_USERNAME);
            setInput(passwordInput, LOGIN_PASSWORD);
            const submit = [...form.querySelectorAll('button, input[type="submit"], input[type="button"]')]
              .find((element) => /log\s*in|login|đăng nhập/i.test([element.innerText, element.value].filter(Boolean).join(' ')));
            if (submit) submit.click();
            else if (form.requestSubmit) form.requestSubmit();
            else form.submit();
            return { state: 'submitted', message: 'Đã gửi thông tin đăng nhập.' };
          }

          const pageText = document.body?.innerText || '';
          const loginLink = [...document.querySelectorAll('a')]
            .find((link) => /log\s*in|login|đăng nhập/i.test(link.innerText || link.textContent || ''));
          if (/session has ended|not logged in|session time out/i.test(pageText) && loginLink) {
            loginLink.click();
            return { state: 'navigating', message: 'Đang mở trang đăng nhập.' };
          }
          const machineEventLink = [...document.querySelectorAll('a')]
            .find((link) => /machine\s*event/i.test((link.innerText || link.textContent || '').trim()));
          if (machineEventLink) {
            const href = machineEventLink.href;
            if (href && !href.startsWith('javascript:') && new URL(href).origin === location.origin && !/\/Login\.do$/i.test(new URL(href).pathname)) {
              return { state: 'navigate-event-url', message: 'Đang mở mục Machine Event.', url: href };
            }
            machineEventLink.click();
            return { state: 'navigating-event', message: 'Đang mở mục Machine Event sau khi đăng nhập.' };
          }
          return { state: 'unknown-page', message: 'Không nhận diện được trang Machine Event hoặc form đăng nhập.' };
        }
        await chrome.runtime.sendMessage({ action: 'updateDailyPage', url: location.href });
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const date = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        const machines = controls.machineSelect.options.filter((option) => option.value && option.label && !isSpd2(option));
        if (!controls.dateSelect.options.some((option) => option.date === date)) {
          return { state: 'no-date', message: `Dropdown chưa có dữ liệu ngày ${date}.` };
        }
        const tasks = machines.map((machine) => ({ date, machineValue: machine.value, machineLabel: machine.label }));
        if (!tasks.length) return { state: 'no-date', message: 'Không nhận diện được machine number để tải.' };
        const now = new Date();
        const runDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const result = await chrome.runtime.sendMessage({ action: 'beginJob', tasks, source: 'daily', runDate, dataDate: date });
        if (!result?.message?.startsWith('Bắt đầu')) return { state: 'no-date', message: result?.message || 'Không tạo được lượt tải.' };
        return { state: 'started', message: result.message };
      }
      if (message.action === 'stop') {
        return chrome.runtime.sendMessage({ action: 'stopJob' });
      }
      if (message.action === 'reset') {
        return chrome.runtime.sendMessage({ action: 'resetJob' });
      }
      if (message.action === 'enableDaily') {
        const controls = identify();
        if (!controls.dateSelect || !controls.machineSelect || !controls.exportButton) {
          return { message: 'Hãy mở đúng trang Machine Event rồi bật lịch; không bật lịch ở trang Login hoặc menu chính.' };
        }
        return chrome.runtime.sendMessage({ action: 'enableDaily' });
      }
      if (message.action === 'disableDaily') {
        return chrome.runtime.sendMessage({ action: message.action });
      }
      if (message.action === 'start') {
        const oldJob = await getJob();
        if (oldJob?.position < oldJob?.total) {
          return chrome.runtime.sendMessage({ action: 'resumeJob' });
        }
        const controls = identify();
        if (!controls.dateSelect || !controls.machineSelect || !controls.exportButton) {
          return { message: 'Không nhận diện được trang Machine Event. Kiểm tra URL và tải lại trang.' };
        }
        const machines = controls.machineSelect.options.filter((option) => option.value && option.label && !isSpd2(option));
        const availableDates = new Set(controls.dateSelect.options.map((option) => option.date).filter(Boolean));
        const tasks = [];
        const [year, month, day] = message.from.split('-').map(Number);
        const [endYear, endMonth, endDay] = message.to.split('-').map(Number);
        for (let value = Date.UTC(year, month - 1, day), end = Date.UTC(endYear, endMonth - 1, endDay); value <= end; value += DAY_MS) {
          const date = new Date(value).toISOString().slice(0, 10);
          if (availableDates.has(date)) {
            for (const machine of machines) tasks.push({ date, machineValue: machine.value, machineLabel: machine.label });
          }
        }
        if (!tasks.length) return { message: 'Không có ngày phù hợp trong dropdown hoặc không nhận diện được machine number.' };
        return chrome.runtime.sendMessage({ action: 'beginJob', tasks });
      }
      return { message: 'Lệnh không được hỗ trợ.' };
    })().then(sendResponse).catch((error) => sendResponse({ message: error.message || 'Có lỗi khi thao tác.' }));
    return true;
  });
})();
