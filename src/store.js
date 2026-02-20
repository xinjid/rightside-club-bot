const fs = require("fs");
const path = require("path");

const DEFAULT_SETTINGS = {
  telegram: {
    botToken: "",
    botUsername: "",
  },
  smartshell: {
    login: "",
    password: "",
    authMode: "credentials",
    bearerToken: "",
  },
  ui: {
    logsCollapsed: true,
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRawSettings(input = {}) {
  const raw = deepClone(input || {});

  if (!raw.telegram || typeof raw.telegram !== "object") {
    raw.telegram = {};
  }
  if (!raw.smartshell || typeof raw.smartshell !== "object") {
    raw.smartshell = {};
  }
  if (!raw.ui || typeof raw.ui !== "object") {
    raw.ui = {};
  }

  if (!raw.telegram.botToken) {
    raw.telegram.botToken = raw.telegramToken || raw.telegramBotToken || "";
  }
  if (!raw.smartshell.login) {
    raw.smartshell.login = raw.smartshellLogin || "";
  }
  if (!raw.smartshell.password) {
    raw.smartshell.password = raw.smartshellPassword || "";
  }
  if (!raw.smartshell.authMode) {
    raw.smartshell.authMode = raw.smartshellAuthMode || raw.authMode || "credentials";
  }
  if (!raw.smartshell.bearerToken) {
    raw.smartshell.bearerToken = raw.smartshellBearerToken || "";
  }
  if (raw.ui.logsCollapsed == null && raw.logsCollapsed != null) {
    raw.ui.logsCollapsed = Boolean(raw.logsCollapsed);
  }

  return raw;
}

function mergeSettings(base, patch) {
  return {
    telegram: {
      ...base.telegram,
      ...(patch.telegram || {}),
    },
    smartshell: {
      ...base.smartshell,
      ...(patch.smartshell || {}),
    },
    ui: {
      ...base.ui,
      ...(patch.ui || {}),
    },
  };
}

function normalizeFinalSettings(input = {}) {
  const normalizedRaw = normalizeRawSettings(input);
  const merged = mergeSettings(DEFAULT_SETTINGS, normalizedRaw);

  merged.telegram.botToken = String(merged.telegram.botToken || "").trim();
  merged.telegram.botUsername = String(merged.telegram.botUsername || "").trim();
  merged.smartshell.login = String(merged.smartshell.login || "").trim();
  merged.smartshell.password = String(merged.smartshell.password || "");
  merged.smartshell.authMode = String(merged.smartshell.authMode || "credentials").trim();
  merged.smartshell.bearerToken = String(merged.smartshell.bearerToken || "").trim();
  merged.ui.logsCollapsed = merged.ui.logsCollapsed !== false;

  if (merged.smartshell.authMode !== "credentials" && merged.smartshell.authMode !== "bearer") {
    merged.smartshell.authMode = "credentials";
  }

  return merged;
}

class SettingsStore {
  constructor({ userDataPath, logger }) {
    this.logger = logger;
    this.filePath = path.join(userDataPath, "settings.json");
    this.#ensureStore();
  }

  getSettings() {
    this.#ensureStore();
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw || "{}");
      return normalizeFinalSettings(parsed);
    } catch (error) {
      this.logger.error(`Failed to read settings: ${error.message}`);
      return deepClone(DEFAULT_SETTINGS);
    }
  }

  saveSettings(nextSettings) {
    const current = this.getSettings();
    const merged = normalizeFinalSettings(mergeSettings(current, normalizeRawSettings(nextSettings)));
    fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  }

  #ensureStore() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
    }
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_SETTINGS,
  normalizeFinalSettings,
};
