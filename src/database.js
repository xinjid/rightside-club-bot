const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const initSqlJs = require("sql.js");

class AppDatabase {
  constructor({ userDataPath, logger }) {
    this.logger = logger;
    this.dbPath = path.join(userDataPath, "rightside.db");
    this.SQL = null;
    this.db = null;
  }

  async init() {
    if (this.db) {
      return;
    }

    this.SQL = await initSqlJs({});
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(fileBuffer);
    } else {
      this.db = new this.SQL.Database();
    }

    this.#migrate();
    this.#persist();
  }

  close() {
    if (!this.db) {
      return;
    }
    this.#persist();
    this.db.close();
    this.db = null;
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id TEXT UNIQUE,
        username TEXT,
        role TEXT CHECK(role IN ('owner', 'moderator', 'admin')),
        created_at DATETIME
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        role TEXT CHECK(role IN ('moderator', 'admin')),
        expires_at DATETIME,
        used_at DATETIME NULL,
        used_by_telegram_user_id TEXT NULL,
        created_at DATETIME
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discount_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_uuid TEXT,
        client_phone TEXT NULL,
        client_nickname TEXT NULL,
        discount_value INTEGER,
        previous_discount_value INTEGER NULL,
        starts_at DATETIME,
        ends_at DATETIME,
        status TEXT CHECK(status IN ('scheduled', 'active', 'finished', 'failed', 'canceled')) DEFAULT 'scheduled',
        created_by_telegram_user_id TEXT,
        created_at DATETIME,
        updated_at DATETIME,
        last_error TEXT NULL
      );
    `);
  }

  #persist() {
    const binary = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(binary));
  }

  #run(sql, params = [], persist = false) {
    this.db.run(sql, params);
    if (persist) {
      this.#persist();
    }
  }

  #get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row;
  }

  #all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  getUserByTelegramId(telegramUserId) {
    return this.#get(
      "SELECT * FROM users WHERE telegram_user_id = ? LIMIT 1",
      [String(telegramUserId)]
    );
  }

  listUsers() {
    return this.#all("SELECT * FROM users ORDER BY created_at ASC");
  }

  upsertUser({ telegramUserId, username, role }) {
    const now = new Date().toISOString();
    const existing = this.getUserByTelegramId(telegramUserId);
    if (existing) {
      this.#run(
        `
        UPDATE users
        SET username = ?, role = ?, created_at = COALESCE(created_at, ?)
        WHERE telegram_user_id = ?
        `,
        [username || existing.username || "", role || existing.role || "admin", now, String(telegramUserId)],
        true
      );
    } else {
      this.#run(
        `
        INSERT INTO users (telegram_user_id, username, role, created_at)
        VALUES (?, ?, ?, ?)
        `,
        [String(telegramUserId), username || "", role || "admin", now],
        true
      );
    }
    return this.getUserByTelegramId(telegramUserId);
  }

  removeUser(telegramUserId) {
    this.#run(
      "DELETE FROM users WHERE telegram_user_id = ?",
      [String(telegramUserId)],
      true
    );
  }

  createInvite(role) {
    const token = crypto.randomBytes(20).toString("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const createdAt = now.toISOString();

    this.#run(
      `
      INSERT INTO invites (token, role, expires_at, used_at, used_by_telegram_user_id, created_at)
      VALUES (?, ?, ?, NULL, NULL, ?)
      `,
      [token, role, expiresAt, createdAt],
      true
    );

    return this.getInviteByToken(token);
  }

  getInviteByToken(token) {
    return this.#get(
      "SELECT * FROM invites WHERE token = ? LIMIT 1",
      [String(token)]
    );
  }

  markInviteUsed({ token, telegramUserId }) {
    const now = new Date().toISOString();
    this.#run(
      `
      UPDATE invites
      SET used_at = ?, used_by_telegram_user_id = ?
      WHERE token = ?
      `,
      [now, String(telegramUserId), String(token)],
      true
    );
    return this.getInviteByToken(token);
  }

  createDiscountJob(input) {
    const now = new Date().toISOString();
    this.#run(
      `
      INSERT INTO discount_jobs (
        client_uuid,
        client_phone,
        client_nickname,
        discount_value,
        previous_discount_value,
        starts_at,
        ends_at,
        status,
        created_by_telegram_user_id,
        created_at,
        updated_at,
        last_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.clientUuid,
        input.clientPhone || null,
        input.clientNickname || null,
        Number(input.discountValue),
        input.previousDiscountValue != null ? Number(input.previousDiscountValue) : null,
        input.startsAt,
        input.endsAt,
        input.status || "scheduled",
        input.createdByTelegramUserId || "local",
        now,
        now,
        null,
      ],
      true
    );

    return this.#get("SELECT * FROM discount_jobs ORDER BY id DESC LIMIT 1");
  }

  getDiscountJobById(id) {
    return this.#get("SELECT * FROM discount_jobs WHERE id = ? LIMIT 1", [Number(id)]);
  }

  listDiscountJobs(limit = 20) {
    return this.#all(
      `
      SELECT * FROM discount_jobs
      ORDER BY datetime(created_at) DESC
      LIMIT ?
      `,
      [Number(limit)]
    );
  }

  getDueScheduledJobs(nowIso) {
    return this.#all(
      `
      SELECT * FROM discount_jobs
      WHERE status = 'scheduled' AND datetime(starts_at) <= datetime(?)
      ORDER BY datetime(starts_at) ASC
      `,
      [nowIso]
    );
  }

  getDueActiveJobs(nowIso) {
    return this.#all(
      `
      SELECT * FROM discount_jobs
      WHERE status = 'active' AND datetime(ends_at) <= datetime(?)
      ORDER BY datetime(ends_at) ASC
      `,
      [nowIso]
    );
  }

  updateDiscountJob(id, patch = {}) {
    const existing = this.getDiscountJobById(id);
    if (!existing) {
      return null;
    }

    const next = {
      status: patch.status || existing.status,
      previous_discount_value:
        patch.previousDiscountValue !== undefined
          ? patch.previousDiscountValue
          : existing.previous_discount_value,
      last_error:
        patch.lastError !== undefined
          ? patch.lastError
          : existing.last_error,
      updated_at: new Date().toISOString(),
    };

    this.#run(
      `
      UPDATE discount_jobs
      SET
        status = ?,
        previous_discount_value = ?,
        last_error = ?,
        updated_at = ?
      WHERE id = ?
      `,
      [
        next.status,
        next.previous_discount_value != null ? Number(next.previous_discount_value) : null,
        next.last_error || null,
        next.updated_at,
        Number(id),
      ],
      true
    );

    return this.getDiscountJobById(id);
  }
}

module.exports = {
  AppDatabase,
};
