const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
const path = require("path");
const { EventEmitter } = require("events");
const { SettingsStore } = require("./src/store");
const { Logger, maskSecret, maskSensitiveText } = require("./src/logger");
const {
  SmartShellClient,
  BILLING_GRAPHQL_URL,
  SMARTSHELL_COMPANY_ID,
} = require("./src/smartshell");
const { BotManager } = require("./src/bot");
const { handleCommand } = require("./src/commands");
const { AppDatabase } = require("./src/database");
const { DiscountScheduler } = require("./src/discount-scheduler");

const BOT_CONSOLE_MAX_MESSAGES = 500;
const SMARTSHELL_WATCHDOG_MS = 60 * 1000;

let win;
let logger;
let store;
let db;
let smartshellClient;
let botManager;
let scheduler;
let smartShellWatchdogId = null;
let botConsoleSeq = 0;
const botConsoleMessages = [];
const botConsoleBus = new EventEmitter();

function normalizeIncomingSettings(input = {}) {
  const payload = { ...input };
  const normalized = {
    telegram: {},
    smartshell: {},
    ui: {},
  };

  const telegram = payload.telegram || {};
  if (telegram.botToken != null) {
    normalized.telegram.botToken = String(telegram.botToken || "");
  } else if (payload.telegramToken != null || payload.telegramBotToken != null) {
    normalized.telegram.botToken = String(payload.telegramToken || payload.telegramBotToken || "");
  }

  if (telegram.botUsername != null) {
    normalized.telegram.botUsername = String(telegram.botUsername || "");
  }

  const smartshell = payload.smartshell || {};
  if (smartshell.login != null || payload.smartshellLogin != null) {
    normalized.smartshell.login = String(smartshell.login || payload.smartshellLogin || "");
  }
  if (smartshell.password != null || payload.smartshellPassword != null) {
    normalized.smartshell.password = String(smartshell.password || payload.smartshellPassword || "");
  }
  if (smartshell.authMode != null || payload.smartshellAuthMode != null || payload.authMode != null) {
    normalized.smartshell.authMode = String(
      smartshell.authMode || payload.smartshellAuthMode || payload.authMode || "credentials"
    );
  }
  if (smartshell.bearerToken != null || payload.smartshellBearerToken != null) {
    normalized.smartshell.bearerToken = String(
      smartshell.bearerToken || payload.smartshellBearerToken || ""
    );
  }

  const ui = payload.ui || {};
  if (ui.logsCollapsed != null || payload.logsCollapsed != null || payload.uiLogsCollapsed != null) {
    normalized.ui.logsCollapsed =
      ui.logsCollapsed != null
        ? Boolean(ui.logsCollapsed)
        : payload.uiLogsCollapsed != null
          ? Boolean(payload.uiLogsCollapsed)
          : Boolean(payload.logsCollapsed);
  }

  return normalized;
}

function mergeSettings(base, patch) {
  return {
    telegram: {
      ...(base.telegram || {}),
      ...(patch.telegram || {}),
    },
    smartshell: {
      ...(base.smartshell || {}),
      ...(patch.smartshell || {}),
    },
    ui: {
      ...(base.ui || {}),
      ...(patch.ui || {}),
    },
  };
}

function pushBotConsoleMessage(message) {
  const item = {
    id: ++botConsoleSeq,
    ts: new Date().toISOString(),
    role: message.role || "system",
    channel: message.channel || "ui",
    initiator: message.initiator || "system",
    command: message.command || "",
    user: message.user || null,
    text: maskSensitiveText(String(message.text || "")),
  };

  botConsoleMessages.push(item);
  if (botConsoleMessages.length > BOT_CONSOLE_MAX_MESSAGES) {
    botConsoleMessages.splice(0, botConsoleMessages.length - BOT_CONSOLE_MAX_MESSAGES);
  }

  botConsoleBus.emit("message", item);
  return item;
}

function formatUiCommandInput(command, args = {}) {
  const normalized = String(command || "").trim().replace(/^\//, "");
  if (!normalized) {
    return "";
  }
  if (normalized === "who") {
    return `/${normalized} ${String(args.phone || "").trim()}`.trim();
  }
  if (normalized === "discount_set" || normalized === "discount") {
    return `/discount_set ${String(args.phone || args.target || "").trim()} ${String(args.value || args.valuePercent || "").trim()} ${String(
      args.duration || ""
    ).trim()}`.trim();
  }
  if (normalized === "discount_remove") {
    return `/${normalized} ${String(args.phone || args.target || "").trim()}`.trim();
  }
  if (normalized === "discount_cancel") {
    return `/${normalized} ${String(args.jobId || "").trim()}`.trim();
  }
  return `/${normalized}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1150,
    height: 820,
    title: "RightSide Admin Bot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
}

function registerIpcHandlers() {
  ipcMain.handle("getSettings", async () => {
    return {
      settings: store.getSettings(),
      storagePath: store.filePath,
      logPath: logger.logFilePath,
      dbPath: db.dbPath,
      constants: {
        BILLING_GRAPHQL_URL,
        SMARTSHELL_COMPANY_ID,
      },
    };
  });

  ipcMain.handle("saveSettings", async (_event, payload) => {
    const patch = normalizeIncomingSettings(payload || {});
    const saved = store.saveSettings(patch);
    logger.info(
      `Settings saved botToken=${maskSecret(saved.telegram.botToken)} authMode=${saved.smartshell.authMode}`
    );
    return { ok: true, settings: saved };
  });

  ipcMain.handle("testSmartShell", async (_event, payload) => {
    try {
      const merged = mergeSettings(store.getSettings(), normalizeIncomingSettings(payload || {}));
      const result = await smartshellClient.testConnection(merged);
      logger.info("SmartShell test successful");
      return { ok: true, message: result.message };
    } catch (error) {
      const message = error?.message || String(error);
      logger.error(`SmartShell test failed: ${message}`);
      return { ok: false, message };
    }
  });

  ipcMain.handle("getSmartShellStatus", async () => {
    return smartshellClient.getConnectionStatus();
  });

  ipcMain.handle("testBot", async (_event, payload) => {
    try {
      const merged = mergeSettings(store.getSettings(), normalizeIncomingSettings(payload || {}));
      const token = String(merged.telegram.botToken || "").trim();
      const result = await botManager.testToken(token);
      if (result.username) {
        store.saveSettings({
          telegram: {
            botUsername: result.username,
          },
        });
      }
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      logger.error(`Bot test failed: ${message}`);
      return { ok: false, message };
    }
  });

  ipcMain.handle("botStart", async (_event, payload) => {
    try {
      if (payload && typeof payload === "object") {
        store.saveSettings(normalizeIncomingSettings(payload));
      }
      const result = await botManager.start();
      return { ok: true, status: result };
    } catch (error) {
      const message = error?.message || String(error);
      logger.error(`Bot start failed: ${message}`);
      return { ok: false, message, status: botManager.getStatus() };
    }
  });

  ipcMain.handle("botStop", async () => {
    const result = await botManager.stop("MANUAL");
    return { ok: true, status: result };
  });

  ipcMain.handle("getBotStatus", async () => botManager.getStatus());

  ipcMain.handle("invite:create", async (_event, payload) => {
    try {
      const role = String(payload?.role || "").trim().toLowerCase();
      const invite = await botManager.createInviteLink(role, "local-ui");
      pushBotConsoleMessage({
        role: "system",
        channel: "invite",
        initiator: "ui",
        text: `Invite created (${invite.role}) expires=${invite.expiresAt}`,
      });
      return { ok: true, invite };
    } catch (error) {
      const message = error?.message || String(error);
      logger.error(`Invite create failed: ${message}`);
      return { ok: false, message };
    }
  });

  ipcMain.handle("getLogs", async () => {
    const lines = logger.getLogs();
    return {
      lines,
      text: lines.join("\n"),
    };
  });

  ipcMain.handle("clearLogs", async () => {
    logger.clear();
    return { ok: true };
  });

  ipcMain.handle("copyToClipboard", async (_event, text) => {
    clipboard.writeText(String(text || ""));
    return { ok: true };
  });

  ipcMain.handle("botConsole:getMessages", async () => {
    return { messages: [...botConsoleMessages] };
  });

  ipcMain.handle("botConsole:clear", async () => {
    botConsoleMessages.length = 0;
    return { ok: true };
  });

  ipcMain.handle("botConsole:runCommand", async (_event, payload) => {
    const command = String(payload?.command || "").trim();
    const args = payload?.args && typeof payload.args === "object" ? payload.args : {};

    const commandText = formatUiCommandInput(command, args);
    pushBotConsoleMessage({
      role: "user",
      channel: "ui",
      initiator: "ui",
      command,
      user: { id: "local-ui", username: "local-ui" },
      text: commandText ? `UI -> Bot: ${commandText}` : "UI -> Bot: (empty command)",
    });

    try {
      const result = await handleCommand(command, args, {
        smartshellClient,
        scheduler,
        db,
        logger,
        emitToUi: pushBotConsoleMessage,
        getSettings: () => store.getSettings(),
        initiator: "ui",
        role: "owner",
        user: { id: "local-ui", username: "local-ui" },
      });

      pushBotConsoleMessage({
        role: "bot",
        channel: "ui",
        initiator: "ui",
        command: result.command,
        text: `Bot -> UI: ${result.text}`,
      });

      return {
        ok: result.ok,
        command: result.command,
        text: result.text,
      };
    } catch (error) {
      const message = error?.message || String(error);
      logger.error(`Bot console command failed: ${message}`);
      pushBotConsoleMessage({
        role: "bot",
        channel: "ui",
        initiator: "ui",
        command,
        text: `Bot -> UI: Ошибка выполнения команды: ${message}`,
      });
      return { ok: false, command, text: message };
    }
  });

  ipcMain.handle("discountJobs:list", async (_event, payload) => {
    const role = String(payload?.role || "owner").toLowerCase();
    const userId = String(payload?.userId || "local-ui");
    const limitRaw = Number(payload?.limit || 20);
    const limit = Number.isNaN(limitRaw) ? 20 : Math.max(1, Math.min(50, limitRaw));
    const createdBy = role === "admin" ? userId : null;

    const jobs = scheduler.listJobs({
      limit,
      createdByTelegramUserId: createdBy,
      statuses: ["active", "scheduled"],
    });

    return {
      ok: true,
      jobs,
    };
  });

  ipcMain.handle("discountJobs:cancel", async (_event, payload) => {
    const id = Number(payload?.id);
    if (Number.isNaN(id)) {
      return { ok: false, message: "Некорректный job id" };
    }

    try {
      const result = await scheduler.cancelJob(id);
      pushBotConsoleMessage({
        role: "system",
        channel: "scheduler",
        initiator: "ui",
        text: `Discount job canceled id=${result.id} status=${result.status}`,
      });
      return { ok: true, job: result };
    } catch (error) {
      const message = error?.message || String(error);
      logger.error(`discountJobs:cancel failed: ${message}`);
      return { ok: false, message };
    }
  });
}

async function startSmartShellWatchdog() {
  const tick = async () => {
    const settings = store.getSettings();
    const authMode = settings?.smartshell?.authMode || "credentials";
    const hasCredentials = settings?.smartshell?.login && settings?.smartshell?.password;
    const hasBearer = settings?.smartshell?.bearerToken;
    if ((authMode === "credentials" && !hasCredentials) || (authMode === "bearer" && !hasBearer)) {
      return;
    }
    try {
      await smartshellClient.testConnection(settings);
    } catch (error) {
      const message = error?.message || String(error);
      logger.warn(`SmartShell watchdog failed: ${message}`);
    }
  };

  await tick();
  smartShellWatchdogId = setInterval(() => {
    tick().catch((error) => {
      logger.warn(`SmartShell watchdog tick error: ${error.message || error}`);
    });
  }, SMARTSHELL_WATCHDOG_MS);
}

app.whenReady().then(async () => {
  const userDataPath = app.getPath("userData");
  logger = new Logger({
    logFilePath: path.join(userDataPath, "logs", "app.log"),
    maxLines: 1200,
  });

  store = new SettingsStore({
    userDataPath,
    logger,
  });

  db = new AppDatabase({
    userDataPath,
    logger,
  });
  await db.init();

  smartshellClient = new SmartShellClient({
    logger,
    getSettings: () => store.getSettings(),
  });

  scheduler = new DiscountScheduler({
    db,
    smartshellClient,
    logger,
    emitToUi: pushBotConsoleMessage,
  });
  scheduler.start();

  botManager = new BotManager({
    logger,
    getSettings: () => store.getSettings(),
    smartshellClient,
    emitToUi: pushBotConsoleMessage,
    db,
    scheduler,
  });

  botConsoleBus.on("message", (message) => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      browserWindow.webContents.send("botConsole:message", message);
    }
  });

  registerIpcHandlers();
  createWindow();
  await startSmartShellWatchdog();
  logger.info(`App started settingsPath=${store.filePath} dbPath=${db.dbPath}`);

  pushBotConsoleMessage({
    role: "system",
    channel: "ui",
    initiator: "system",
    text: "App started",
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (smartShellWatchdogId) {
    clearInterval(smartShellWatchdogId);
    smartShellWatchdogId = null;
  }
  if (scheduler) {
    scheduler.stop();
  }
  if (botManager) {
    await botManager.stop("APP_QUIT");
  }
  if (db) {
    db.close();
  }
});
