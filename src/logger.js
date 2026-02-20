const fs = require("fs");
const path = require("path");

function maskSecret(value) {
  if (value == null) {
    return "";
  }
  const str = String(value).trim();
  if (!str) {
    return "";
  }
  return `${str.slice(0, 4)}***`;
}

function maskSensitiveText(input) {
  let text = String(input == null ? "" : input);

  text = text.replace(
    /(\b\d{5,}:[A-Za-z0-9_-]{20,}\b)/g,
    (match) => maskSecret(match)
  );

  text = text.replace(
    /(\b(?:access_?token|refresh_?token|token|password)\b["'\s:=]+)([^\s"',}]+)/gi,
    (_full, prefix, secret) => `${prefix}${maskSecret(secret)}`
  );

  text = text.replace(
    /(Bearer\s+)([A-Za-z0-9\-._~+/]+=*)/gi,
    (_full, prefix, secret) => `${prefix}${maskSecret(secret)}`
  );

  return text;
}

class Logger {
  constructor({ logFilePath, maxLines = 800 }) {
    this.logFilePath = logFilePath;
    this.maxLines = maxLines;
    this.lines = [];

    const dir = path.dirname(this.logFilePath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.logFilePath)) {
      fs.writeFileSync(this.logFilePath, "", "utf8");
    }

    const existing = fs.readFileSync(this.logFilePath, "utf8");
    if (existing) {
      this.lines = existing.split(/\r?\n/).filter(Boolean).slice(-this.maxLines);
    }
  }

  info(message) {
    this.#append("INFO", message);
  }

  warn(message) {
    this.#append("WARN", message);
  }

  error(message) {
    this.#append("ERROR", message);
  }

  getLogs() {
    return [...this.lines];
  }

  clear() {
    this.lines = [];
    fs.writeFileSync(this.logFilePath, "", "utf8");
  }

  #append(level, message) {
    const raw = typeof message === "string" ? message : JSON.stringify(message);
    const normalized = maskSensitiveText(raw);
    const line = `[${new Date().toISOString()}] [${level}] ${normalized}`;
    this.lines.push(line);

    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }

    fs.appendFileSync(this.logFilePath, `${line}\n`, "utf8");
  }
}

module.exports = {
  Logger,
  maskSecret,
  maskSensitiveText,
};
