const CONSOLE_MAX_MESSAGES = 500;

const el = {
  connStatusWrap: document.getElementById("connStatusWrap"),
  connDot: document.getElementById("connDot"),
  openSettingsBtn: document.getElementById("openSettingsBtn"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  settingsModal: document.getElementById("settingsModal"),
  telegramTokenInput: document.getElementById("telegramTokenInput"),
  smartshellLoginInput: document.getElementById("smartshellLoginInput"),
  smartshellPasswordInput: document.getElementById("smartshellPasswordInput"),
  authModeSelect: document.getElementById("authModeSelect"),
  bearerTokenInput: document.getElementById("bearerTokenInput"),
  logsCollapsedCheckbox: document.getElementById("logsCollapsedCheckbox"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  testSmartShellBtn: document.getElementById("testSmartShellBtn"),
  testBotBtn: document.getElementById("testBotBtn"),
  settingsResult: document.getElementById("settingsResult"),
  startBotBtn: document.getElementById("startBotBtn"),
  stopBotBtn: document.getElementById("stopBotBtn"),
  inviteBtn: document.getElementById("inviteBtn"),
  botStatus: document.getElementById("botStatus"),
  cmdSelect: document.getElementById("cmdSelect"),
  cmdTarget: document.getElementById("cmdTarget"),
  cmdValue: document.getElementById("cmdValue"),
  cmdDuration: document.getElementById("cmdDuration"),
  runCommandBtn: document.getElementById("runCommandBtn"),
  toggleConsoleBtn: document.getElementById("toggleConsoleBtn"),
  clearConsoleBtn: document.getElementById("clearConsoleBtn"),
  copyConsoleBtn: document.getElementById("copyConsoleBtn"),
  consoleCollapsedLine: document.getElementById("consoleCollapsedLine"),
  consoleFeed: document.getElementById("consoleFeed"),
  refreshDiscountJobsBtn: document.getElementById("refreshDiscountJobsBtn"),
  discountJobsEmpty: document.getElementById("discountJobsEmpty"),
  discountJobsList: document.getElementById("discountJobsList"),
  discountJobsMeta: document.getElementById("discountJobsMeta"),
  toggleLogsBtn: document.getElementById("toggleLogsBtn"),
  clearLogsBtn: document.getElementById("clearLogsBtn"),
  copyLogsBtn: document.getElementById("copyLogsBtn"),
  logsCollapsedLine: document.getElementById("logsCollapsedLine"),
  logsArea: document.getElementById("logsArea"),
  logsMeta: document.getElementById("logsMeta"),
  inviteModal: document.getElementById("inviteModal"),
  closeInviteBtn: document.getElementById("closeInviteBtn"),
  inviteRoleSelect: document.getElementById("inviteRoleSelect"),
  createInviteBtn: document.getElementById("createInviteBtn"),
  copyInviteBtn: document.getElementById("copyInviteBtn"),
  inviteLinkArea: document.getElementById("inviteLinkArea"),
  inviteResult: document.getElementById("inviteResult"),
};

let logPathText = "";
let botConsoleMessages = [];
let botConsoleExpanded = false;
let appLogsExpanded = false;
let smartShellConnected = false;
let unsubscribeBotConsole = null;

function setStatus(element, ok, text) {
  element.classList.remove("muted", "ok", "error");
  element.classList.add(ok ? "ok" : "error");
  element.textContent = text;
}

function setMuted(element, text) {
  element.classList.remove("ok", "error");
  element.classList.add("muted");
  element.textContent = text;
}

function refreshAuthModeUi() {
  const isBearer = el.authModeSelect.value === "bearer";
  el.bearerTokenInput.disabled = !isBearer;
}

function formatTime(ts) {
  if (!ts) {
    return "";
  }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return String(ts);
  }
  return date.toLocaleTimeString();
}

function getSettingsPayloadFromForm() {
  return {
    telegram: {
      botToken: el.telegramTokenInput.value,
    },
    smartshell: {
      login: el.smartshellLoginInput.value,
      password: el.smartshellPasswordInput.value,
      authMode: el.authModeSelect.value,
      bearerToken: el.bearerTokenInput.value,
    },
    ui: {
      logsCollapsed: Boolean(el.logsCollapsedCheckbox.checked),
    },
  };
}

function applySettingsToForm(settings) {
  const telegram = settings?.telegram || {};
  const smartshell = settings?.smartshell || {};
  const ui = settings?.ui || {};

  el.telegramTokenInput.value = telegram.botToken || "";
  el.smartshellLoginInput.value = smartshell.login || "";
  el.smartshellPasswordInput.value = smartshell.password || "";
  el.authModeSelect.value = smartshell.authMode || "credentials";
  el.bearerTokenInput.value = smartshell.bearerToken || "";
  el.logsCollapsedCheckbox.checked = ui.logsCollapsed !== false;
  refreshAuthModeUi();
}

function updateConsoleToggle() {
  el.toggleConsoleBtn.textContent = botConsoleExpanded ? "Скрыть логи" : "Показать логи";
  el.consoleFeed.classList.toggle("hidden", !botConsoleExpanded);
  el.consoleCollapsedLine.classList.toggle("hidden", botConsoleExpanded);
}

function renderConsole() {
  const shouldStickBottom =
    el.consoleFeed.scrollHeight - el.consoleFeed.scrollTop - el.consoleFeed.clientHeight < 14;

  el.consoleFeed.textContent = "";
  for (const message of botConsoleMessages) {
    const item = document.createElement("div");
    item.className = `console-item ${message.role || "system"}`;

    const meta = document.createElement("div");
    meta.className = "console-meta";
    meta.textContent = `[${formatTime(message.ts)}] ${(message.channel || "ui").toUpperCase()} ${(message.role || "system").toUpperCase()}`;

    const body = document.createElement("div");
    body.textContent = message.text || "";
    item.appendChild(meta);
    item.appendChild(body);
    el.consoleFeed.appendChild(item);
  }

  const last = botConsoleMessages[botConsoleMessages.length - 1];
  el.consoleCollapsedLine.textContent = last
    ? `[${formatTime(last.ts)}] ${String(last.text || "")}`
    : "Логи скрыты";

  if (shouldStickBottom) {
    el.consoleFeed.scrollTop = el.consoleFeed.scrollHeight;
  }
}

function pushConsoleMessage(message) {
  botConsoleMessages.push(message);
  if (botConsoleMessages.length > CONSOLE_MAX_MESSAGES) {
    botConsoleMessages = botConsoleMessages.slice(-CONSOLE_MAX_MESSAGES);
  }
  renderConsole();
}

function updateLogsToggle() {
  el.toggleLogsBtn.textContent = appLogsExpanded ? "Скрыть логи" : "Показать логи";
  el.logsArea.classList.toggle("hidden", !appLogsExpanded);
  el.logsCollapsedLine.classList.toggle("hidden", appLogsExpanded);
}

function updateConnectionIndicator(status) {
  const ok = Boolean(status?.ok);
  smartShellConnected = ok;
  el.connDot.classList.toggle("ok", ok);
  el.connStatusWrap.title = ok
    ? `SmartShell OK (${status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleTimeString() : "now"})`
    : `SmartShell error: ${status?.lastError || "нет подключения"}`;
}

function renderDiscountJobs(jobs = []) {
  if (!smartShellConnected) {
    el.discountJobsList.classList.add("hidden");
    el.discountJobsEmpty.classList.remove("hidden");
    el.discountJobsEmpty.textContent = "Подключите SmartShell для отображения";
    return;
  }

  if (!jobs.length) {
    el.discountJobsList.classList.add("hidden");
    el.discountJobsEmpty.classList.remove("hidden");
    el.discountJobsEmpty.textContent = "Активных/запланированных скидок нет";
    return;
  }

  el.discountJobsEmpty.classList.add("hidden");
  el.discountJobsList.classList.remove("hidden");
  el.discountJobsList.textContent = "";

  for (const job of jobs.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = "discount-item";

    const title = document.createElement("div");
    const clientLabel = job.client_nickname || (job.client_phone ? `+${job.client_phone}` : job.client_uuid);
    title.textContent = `${clientLabel} • ${job.discount_value}%`;

    const meta = document.createElement("div");
    meta.className = "discount-meta";
    meta.textContent = `${job.status} • до ${job.ends_at}`;

    const actions = document.createElement("div");
    actions.className = "discount-actions";
    const idText = document.createElement("span");
    idText.className = "discount-meta";
    idText.textContent = `job #${job.id}`;

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "ghost";
    cancelBtn.textContent = "Отменить";
    cancelBtn.addEventListener("click", async () => {
      await cancelDiscountJob(job.id);
    });

    actions.appendChild(idText);
    actions.appendChild(cancelBtn);
    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(actions);
    el.discountJobsList.appendChild(row);
  }
}

async function refreshDiscountJobs() {
  if (!smartShellConnected) {
    renderDiscountJobs([]);
    return;
  }

  const result = await window.api.discountJobsList({
    role: "owner",
    userId: "local-ui",
    limit: 20,
  });
  if (!result?.ok) {
    setStatus(el.discountJobsMeta, false, result?.message || "Ошибка загрузки скидок");
    return;
  }
  setMuted(el.discountJobsMeta, `Обновлено: ${new Date().toLocaleTimeString()}`);
  renderDiscountJobs(result.jobs || []);
}

async function cancelDiscountJob(id) {
  const confirmed = window.confirm(`Отменить задачу скидки #${id}?`);
  if (!confirmed) {
    return;
  }

  const result = await window.api.discountJobsCancel({ id });
  if (!result?.ok) {
    setStatus(el.discountJobsMeta, false, result?.message || "Ошибка отмены");
    return;
  }
  setStatus(el.discountJobsMeta, true, `Задача #${id} отменена`);
  await refreshDiscountJobs();
}

async function loadSettings() {
  const data = await window.api.getSettings();
  applySettingsToForm(data.settings);
  logPathText = data.logPath;
  const collapsed = data.settings?.ui?.logsCollapsed !== false;
  appLogsExpanded = !collapsed;
  updateLogsToggle();
  setMuted(el.logsMeta, `Логи: ${data.logPath} | DB: ${data.dbPath}`);
}

async function saveSettings() {
  const result = await window.api.saveSettings(getSettingsPayloadFromForm());
  if (!result?.ok) {
    setStatus(el.settingsResult, false, result?.message || "Ошибка сохранения");
    return false;
  }
  applySettingsToForm(result.settings);
  appLogsExpanded = !(result.settings?.ui?.logsCollapsed !== false);
  updateLogsToggle();
  setStatus(el.settingsResult, true, "Сохранено ✅");
  return true;
}

async function testSmartShell() {
  setMuted(el.settingsResult, "Проверка SmartShell...");
  const result = await window.api.testSmartShell(getSettingsPayloadFromForm());
  setStatus(el.settingsResult, Boolean(result?.ok), result?.message || "Нет ответа");
  await refreshConnectionStatus();
  await refreshDiscountJobs();
}

async function testBot() {
  setMuted(el.settingsResult, "Проверка Telegram Bot...");
  const result = await window.api.testBot(getSettingsPayloadFromForm());
  setStatus(el.settingsResult, Boolean(result?.ok), result?.message || "Нет ответа");
}

async function startBot() {
  await saveSettings();
  const result = await window.api.botStart(getSettingsPayloadFromForm());
  if (!result?.ok) {
    setStatus(el.botStatus, false, `Status: ERROR (${result?.message || "start failed"})`);
    return;
  }
  await refreshBotStatus();
}

async function stopBot() {
  await window.api.botStop();
  await refreshBotStatus();
}

async function refreshBotStatus() {
  const state = await window.api.getBotStatus();
  const status = state?.status || "STOPPED";
  const line = `Status: ${status}${state?.username ? ` (@${state.username})` : ""}${state?.error ? ` (${state.error})` : ""}`;
  if (status === "RUNNING") {
    setStatus(el.botStatus, true, line);
    return;
  }
  if (status === "ERROR") {
    setStatus(el.botStatus, false, line);
    return;
  }
  setMuted(el.botStatus, line);
}

function buildCommandPayload() {
  const command = String(el.cmdSelect.value || "").trim();

  if (command === "ping" || command === "discount_list") {
    return { command, args: {} };
  }

  if (command === "who") {
    return {
      command,
      args: {
        phone: String(el.cmdTarget.value || "").trim(),
      },
    };
  }

  if (command === "discount_set") {
    return {
      command,
      args: {
        phone: String(el.cmdTarget.value || "").trim(),
        value: String(el.cmdValue.value || "").trim(),
        duration: String(el.cmdDuration.value || "").trim(),
      },
    };
  }

  if (command === "discount_remove") {
    return {
      command,
      args: {
        phone: String(el.cmdTarget.value || "").trim(),
      },
    };
  }

  if (command === "discount_cancel") {
    return {
      command,
      args: {
        jobId: String(el.cmdTarget.value || "").trim(),
      },
    };
  }

  return { command, args: {} };
}

function refreshCommandInputs() {
  const command = el.cmdSelect.value;
  const needsTarget =
    command === "who" ||
    command === "discount_set" ||
    command === "discount_remove" ||
    command === "discount_cancel";
  const needsValue = command === "discount_set";
  const needsDuration = command === "discount_set";

  el.cmdTarget.disabled = !needsTarget;
  el.cmdValue.disabled = !needsValue;
  el.cmdDuration.disabled = !needsDuration;

  if (command === "who") {
    el.cmdTarget.placeholder = "phone: +7999...";
  } else if (command === "discount_set") {
    el.cmdTarget.placeholder = "phone";
  } else if (command === "discount_remove") {
    el.cmdTarget.placeholder = "phone";
  } else if (command === "discount_cancel") {
    el.cmdTarget.placeholder = "job id";
  } else {
    el.cmdTarget.placeholder = "не требуется";
  }
}

async function runBotCommand() {
  const result = await window.api.botConsoleRunCommand(buildCommandPayload());
  if (!result?.ok) {
    setStatus(el.botStatus, false, `Command error: ${result?.text || "unknown"}`);
  }
  await refreshDiscountJobs();
}

async function loadBotConsole() {
  const result = await window.api.botConsoleGetMessages();
  botConsoleMessages = Array.isArray(result?.messages) ? result.messages : [];
  renderConsole();
  updateConsoleToggle();
}

async function clearBotConsole() {
  await window.api.botConsoleClear();
  botConsoleMessages = [];
  renderConsole();
}

async function copyBotConsole() {
  const text = botConsoleMessages
    .map((item) => `[${formatTime(item.ts)}] [${item.channel}] ${item.text}`)
    .join("\n");
  await window.api.copyToClipboard(text);
}

async function refreshLogs() {
  const result = await window.api.getLogs();
  const text = result?.text || "";
  const lines = text.split("\n").filter(Boolean);
  el.logsArea.value = text;
  el.logsCollapsedLine.textContent = lines.length ? lines[lines.length - 1] : "Логи скрыты";
}

async function clearLogs() {
  await window.api.clearLogs();
  await refreshLogs();
}

async function copyLogs() {
  await window.api.copyToClipboard(el.logsArea.value || "");
  setMuted(el.logsMeta, `Логи скопированы | ${logPathText}`);
}

async function refreshConnectionStatus() {
  const status = await window.api.getSmartShellStatus();
  updateConnectionIndicator(status);
}

function openSettingsModal() {
  el.settingsModal.classList.remove("hidden");
}

function closeSettingsModal() {
  el.settingsModal.classList.add("hidden");
}

function openInviteModal() {
  el.inviteModal.classList.remove("hidden");
}

function closeInviteModal() {
  el.inviteModal.classList.add("hidden");
}

async function createInvite() {
  const role = String(el.inviteRoleSelect.value || "moderator");
  const result = await window.api.createInvite({ role });
  if (!result?.ok) {
    setStatus(el.inviteResult, false, result?.message || "Ошибка invite");
    return;
  }
  el.inviteLinkArea.value = result.invite.link || "";
  setStatus(el.inviteResult, true, `Готово. Истекает: ${result.invite.expiresAt}`);
}

async function copyInvite() {
  await window.api.copyToClipboard(el.inviteLinkArea.value || "");
  setMuted(el.inviteResult, "Ссылка скопирована");
}

function bindEvents() {
  el.openSettingsBtn.addEventListener("click", openSettingsModal);
  el.closeSettingsBtn.addEventListener("click", closeSettingsModal);
  el.settingsModal.addEventListener("click", (event) => {
    if (event.target === el.settingsModal) {
      closeSettingsModal();
    }
  });

  el.saveSettingsBtn.addEventListener("click", saveSettings);
  el.testSmartShellBtn.addEventListener("click", testSmartShell);
  el.testBotBtn.addEventListener("click", testBot);
  el.authModeSelect.addEventListener("change", refreshAuthModeUi);

  el.startBotBtn.addEventListener("click", startBot);
  el.stopBotBtn.addEventListener("click", stopBot);

  el.cmdSelect.addEventListener("change", refreshCommandInputs);
  el.runCommandBtn.addEventListener("click", runBotCommand);

  el.toggleConsoleBtn.addEventListener("click", () => {
    botConsoleExpanded = !botConsoleExpanded;
    updateConsoleToggle();
  });
  el.clearConsoleBtn.addEventListener("click", clearBotConsole);
  el.copyConsoleBtn.addEventListener("click", copyBotConsole);

  el.refreshDiscountJobsBtn.addEventListener("click", refreshDiscountJobs);

  el.toggleLogsBtn.addEventListener("click", async () => {
    appLogsExpanded = !appLogsExpanded;
    updateLogsToggle();
    await window.api.saveSettings({
      ui: {
        logsCollapsed: !appLogsExpanded,
      },
    });
  });
  el.clearLogsBtn.addEventListener("click", clearLogs);
  el.copyLogsBtn.addEventListener("click", copyLogs);

  el.inviteBtn.addEventListener("click", openInviteModal);
  el.closeInviteBtn.addEventListener("click", closeInviteModal);
  el.inviteModal.addEventListener("click", (event) => {
    if (event.target === el.inviteModal) {
      closeInviteModal();
    }
  });
  el.createInviteBtn.addEventListener("click", createInvite);
  el.copyInviteBtn.addEventListener("click", copyInvite);
}

async function bootstrap() {
  bindEvents();
  refreshCommandInputs();
  await loadSettings();
  await refreshBotStatus();
  await loadBotConsole();
  await refreshLogs();
  await refreshConnectionStatus();
  await refreshDiscountJobs();

  unsubscribeBotConsole = window.api.onBotConsoleMessage((message) => {
    pushConsoleMessage(message);
    if (message.channel === "scheduler") {
      refreshDiscountJobs().catch(() => {});
    }
  });

  window.addEventListener("beforeunload", () => {
    if (typeof unsubscribeBotConsole === "function") {
      unsubscribeBotConsole();
    }
  });

  setInterval(() => {
    refreshBotStatus().catch(() => {});
    refreshLogs().catch(() => {});
    refreshConnectionStatus().catch(() => {});
  }, 3000);

  setInterval(() => {
    refreshDiscountJobs().catch(() => {});
  }, 30000);
}

bootstrap().catch((error) => {
  setStatus(el.settingsResult, false, `Ошибка инициализации: ${error.message || error}`);
});
