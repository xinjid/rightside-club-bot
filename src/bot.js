const { Telegraf } = require("telegraf");
const { handleCommand, hasRole } = require("./commands");
const { maskSecret, maskSensitiveText } = require("./logger");

function shortText(text, max = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}...`;
}

class BotManager {
  constructor({ logger, getSettings, smartshellClient, emitToUi, db, scheduler }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.smartshellClient = smartshellClient;
    this.emitToUi = emitToUi;
    this.db = db;
    this.scheduler = scheduler;
    this.bot = null;
    this.status = "STOPPED";
    this.lastError = "";
    this.cachedUsername = "";
  }

  getStatus() {
    return {
      status: this.status,
      error: this.lastError || null,
      username: this.cachedUsername || null,
    };
  }

  async testToken(token) {
    const normalized = String(token || "").trim();
    if (!normalized) {
      throw new Error("Telegram Bot Token пустой");
    }

    const tempBot = new Telegraf(normalized);
    const me = await tempBot.telegram.getMe();
    this.cachedUsername = me.username || this.cachedUsername;
    this.logger.info(
      `Telegram bot test ok token=${maskSecret(normalized)} username=@${me.username || "unknown"}`
    );
    return {
      ok: true,
      message: `Бот доступен: @${me.username || me.id}`,
      username: me.username || null,
    };
  }

  async getBotUsername(overrides = {}) {
    if (this.cachedUsername) {
      return this.cachedUsername;
    }

    const settings = {
      ...this.getSettings(),
      ...overrides,
    };
    const token = String(settings?.telegram?.botToken || settings?.telegramToken || "").trim();
    if (!token) {
      throw new Error("Telegram Bot Token не заполнен");
    }

    const result = await this.testToken(token);
    if (!result.username) {
      throw new Error("Не удалось определить username бота");
    }
    return result.username;
  }

  async createInviteLink(role, createdByUserId = "local") {
    const normalizedRole = String(role || "").trim().toLowerCase();
    if (normalizedRole !== "admin" && normalizedRole !== "moderator") {
      throw new Error("Role должен быть admin или moderator");
    }

    const username = await this.getBotUsername();
    const invite = this.db.createInvite(normalizedRole);
    const link = `https://t.me/${username}?start=invite_${invite.token}`;
    this.logger.info(`Invite created role=${normalizedRole} token=${maskSecret(invite.token)}`);
    this.#emitConsoleMessage({
      role: "system",
      channel: "invite",
      initiator: "system",
      text: `Invite created role=${normalizedRole} by=${createdByUserId}`,
    });

    return {
      role: normalizedRole,
      token: invite.token,
      expiresAt: invite.expires_at,
      link,
    };
  }

  async start(overrides = {}) {
    if (this.bot) {
      return this.getStatus();
    }

    const settings = {
      ...this.getSettings(),
      ...overrides,
    };
    const token = String(settings?.telegram?.botToken || settings.telegramToken || "").trim();
    if (!token) {
      throw new Error("Telegram Bot Token пустой");
    }

    const tokenCheck = await this.testToken(token);
    if (tokenCheck.username) {
      this.cachedUsername = tokenCheck.username;
    }

    const bot = new Telegraf(token);
    this.#wireHandlers(bot);

    bot.catch(async (error, ctx) => {
      const message = error?.message || String(error);
      this.lastError = message;
      this.status = "ERROR";
      this.logger.error(`Bot runtime error: ${message}`);
      try {
        await this.#sendReply({
          ctx,
          text: `Ошибка бота: ${message}`,
          initiator: "telegram",
          userMeta: this.#extractUserMeta(ctx),
        });
      } catch {
        // ignore
      }
    });

    await bot.launch();
    this.bot = bot;
    this.status = "RUNNING";
    this.lastError = "";
    this.logger.info(`Bot started token=${maskSecret(token)}`);
    this.#emitConsoleMessage({
      role: "system",
      channel: "telegram",
      initiator: "system",
      text: "Telegram bot started",
    });
    return this.getStatus();
  }

  async stop(reason = "MANUAL") {
    if (this.bot) {
      this.bot.stop(reason);
      this.bot = null;
    }
    this.status = "STOPPED";
    this.lastError = "";
    this.logger.info(`Bot stopped reason=${reason}`);
    this.#emitConsoleMessage({
      role: "system",
      channel: "telegram",
      initiator: "system",
      text: `Telegram bot stopped (${reason})`,
    });
    return this.getStatus();
  }

  #wireHandlers(bot) {
    bot.start(async (ctx) => {
      const userMeta = this.#extractUserMeta(ctx);
      this.#emitIncomingTelegram(ctx, userMeta);

      const payload = this.#parseStartPayload(ctx);
      if (payload?.startsWith("invite_")) {
        await this.#handleInviteStart(ctx, payload.slice("invite_".length));
        return;
      }

      const user = this.db.getUserByTelegramId(userMeta.id);
      if (!user) {
        await this.#sendReply({
          ctx,
          initiator: "telegram",
          userMeta,
          text: "Доступ запрещён. Попросите приглашение у администратора.",
        });
        return;
      }

      await this.#sendReply({
        ctx,
        initiator: "telegram",
        userMeta,
        text:
          "RightSide Admin Bot ✅\n\n" +
          "Команды:\n" +
          "/ping\n" +
          "/who <phone>\n" +
          "/discount_set <phone> <value> <duration>\n" +
          "/discount_remove <phone>\n" +
          "/discount_list\n" +
          "/discount_cancel <jobId>\n",
      });
    });

    bot.use(async (ctx, next) => {
      const text = String(ctx?.message?.text || "");
      if (text.startsWith("/start")) {
        return next();
      }

      const userMeta = this.#extractUserMeta(ctx);
      this.#emitIncomingTelegram(ctx, userMeta);
      const user = this.db.getUserByTelegramId(userMeta.id);
      ctx.state.appUser = user || null;

      if (!user) {
        await this.#sendReply({
          ctx,
          initiator: "telegram",
          userMeta,
          text: "Доступ запрещён. Попросите приглашение у администратора.",
        });
        return;
      }

      return next();
    });

    bot.command("ping", async (ctx) => {
      await this.#executeCommand(ctx, "ping", {});
    });

    bot.command("who", async (ctx) => {
      const target = this.#tailArgs(ctx.message?.text || "");
      await this.#executeCommand(ctx, "who", { phone: target });
    });

    bot.command("discount_set", async (ctx) => {
      const [target, value, duration] = this.#splitArgs(ctx.message?.text || "");
      await this.#executeCommand(ctx, "discount_set", { phone: target, value, duration });
    });

    bot.command("discount_remove", async (ctx) => {
      const [phone] = this.#splitArgs(ctx.message?.text || "");
      await this.#executeCommand(ctx, "discount_remove", { phone });
    });

    bot.command("discount", async (ctx) => {
      const [target, value, duration] = this.#splitArgs(ctx.message?.text || "");
      await this.#executeCommand(ctx, "discount_set", { phone: target, value, duration });
    });

    bot.command("discount_list", async (ctx) => {
      await this.#executeCommand(ctx, "discount_list", {});
    });

    bot.command("discount_cancel", async (ctx) => {
      const [jobId] = this.#splitArgs(ctx.message?.text || "");
      await this.#executeCommand(ctx, "discount_cancel", { jobId });
    });

    bot.command("invite", async (ctx) => {
      const role = String(this.#splitArgs(ctx.message?.text || "")[0] || "").trim().toLowerCase();
      const userMeta = this.#extractUserMeta(ctx);
      const appUser = ctx.state.appUser || this.db.getUserByTelegramId(userMeta.id);
      if (!hasRole(appUser?.role, "moderator")) {
        await this.#sendReply({
          ctx,
          text: "Команда доступна только moderator/owner",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      try {
        const invite = await this.createInviteLink(role, appUser.telegram_user_id);
        await this.#sendReply({
          ctx,
          text: `Invite (${invite.role})\n${invite.link}\nДействует до ${invite.expiresAt}`,
          initiator: "telegram",
          userMeta,
        });
      } catch (error) {
        await this.#sendReply({
          ctx,
          text: `Ошибка invite: ${error.message || error}`,
          initiator: "telegram",
          userMeta,
        });
      }
    });

    bot.command("setrole", async (ctx) => {
      const [targetId, role] = this.#splitArgs(ctx.message?.text || "");
      const actor = ctx.state.appUser;
      const userMeta = this.#extractUserMeta(ctx);

      if (!hasRole(actor?.role, "moderator")) {
        await this.#sendReply({
          ctx,
          text: "Команда доступна только moderator/owner",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      const normalizedRole = String(role || "").trim().toLowerCase();
      if (!targetId || !["admin", "moderator"].includes(normalizedRole)) {
        await this.#sendReply({
          ctx,
          text: "Использование: /setrole <telegram_user_id> <admin|moderator>",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      if (normalizedRole === "moderator" && actor.role !== "owner") {
        await this.#sendReply({
          ctx,
          text: "Только owner может назначать moderator",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      const target = this.db.upsertUser({
        telegramUserId: targetId,
        username: "",
        role: normalizedRole,
      });
      await this.#sendReply({
        ctx,
        text: `Пользователь ${target.telegram_user_id} -> ${target.role}`,
        initiator: "telegram",
        userMeta,
      });
    });

    bot.command("remove_user", async (ctx) => {
      const [targetId] = this.#splitArgs(ctx.message?.text || "");
      const actor = ctx.state.appUser;
      const userMeta = this.#extractUserMeta(ctx);

      if (!hasRole(actor?.role, "moderator")) {
        await this.#sendReply({
          ctx,
          text: "Команда доступна только moderator/owner",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      if (!targetId) {
        await this.#sendReply({
          ctx,
          text: "Использование: /remove_user <telegram_user_id>",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      const target = this.db.getUserByTelegramId(targetId);
      if (!target) {
        await this.#sendReply({
          ctx,
          text: "Пользователь не найден",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      if (actor.role !== "owner" && target.role !== "admin") {
        await this.#sendReply({
          ctx,
          text: "Moderator может удалять только admin",
          initiator: "telegram",
          userMeta,
        });
        return;
      }

      this.db.removeUser(targetId);
      await this.#sendReply({
        ctx,
        text: `Пользователь ${targetId} удален`,
        initiator: "telegram",
        userMeta,
      });
    });

    bot.on("text", async (ctx) => {
      const text = String(ctx.message?.text || "").trim();
      if (!text || text.startsWith("/")) {
        return;
      }
      await this.#executeCommand(ctx, "who", { phone: text });
    });
  }

  async #handleInviteStart(ctx, inviteToken) {
    const userMeta = this.#extractUserMeta(ctx);
    const invite = this.db.getInviteByToken(inviteToken);
    const now = Date.now();

    if (
      !invite ||
      invite.used_at ||
      !invite.expires_at ||
      Number.isNaN(new Date(invite.expires_at).getTime()) ||
      new Date(invite.expires_at).getTime() < now
    ) {
      await this.#sendReply({
        ctx,
        initiator: "telegram",
        userMeta,
        text: "Ссылка приглашения недействительна или истекла. Обратитесь к администратору.",
      });
      return;
    }

    this.db.upsertUser({
      telegramUserId: userMeta.id,
      username: userMeta.username || "",
      role: invite.role,
    });
    this.db.markInviteUsed({
      token: invite.token,
      telegramUserId: userMeta.id,
    });

    this.logger.info(`Invite used role=${invite.role} by=${userMeta.id}`);
    this.#emitConsoleMessage({
      role: "system",
      channel: "invite",
      initiator: "telegram",
      text: `Invite used role=${invite.role} by=${userMeta.id}`,
    });

    await this.#sendReply({
      ctx,
      initiator: "telegram",
      userMeta,
      text: `Вы добавлены как ${invite.role}`,
    });
  }

  async #executeCommand(ctx, command, args) {
    const userMeta = this.#extractUserMeta(ctx);
    const appUser = ctx.state.appUser || this.db.getUserByTelegramId(userMeta.id);

    const result = await handleCommand(command, args, {
      smartshellClient: this.smartshellClient,
      scheduler: this.scheduler,
      db: this.db,
      logger: this.logger,
      emitToUi: this.emitToUi,
      getSettings: this.getSettings,
      initiator: "telegram",
      user: userMeta,
      role: appUser?.role || null,
      telegramReply: async (text) => {
        await this.#sendReply({
          ctx,
          text,
          initiator: "telegram",
          userMeta,
        });
      },
    });

    await this.#sendReply({
      ctx,
      text: result.text,
      initiator: "telegram",
      userMeta,
    });
  }

  #parseStartPayload(ctx) {
    const text = String(ctx?.message?.text || "").trim();
    const parts = text.split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }

  #splitArgs(text) {
    const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      return [];
    }
    return parts.slice(1);
  }

  #tailArgs(text) {
    const parts = this.#splitArgs(text);
    return parts.join(" ");
  }

  #extractUserMeta(ctx) {
    const id = ctx?.from?.id != null ? String(ctx.from.id) : "";
    const username = ctx?.from?.username ? String(ctx.from.username) : "";
    const firstName = ctx?.from?.first_name ? String(ctx.from.first_name) : "";
    return { id, username, firstName };
  }

  #emitIncomingTelegram(ctx, userMeta) {
    const text = String(ctx?.message?.text || "").trim();
    if (!text) {
      return;
    }
    const userLabel = this.#renderUserLabel(userMeta);
    const message = `TG ${userLabel}: ${shortText(text)}`;
    this.#emitConsoleMessage({
      role: "user",
      channel: "telegram",
      initiator: "telegram",
      user: userMeta,
      text: message,
    });
  }

  async #sendReply({ ctx, text, userMeta, initiator }) {
    const normalized = maskSensitiveText(String(text || ""));
    if (ctx) {
      await ctx.reply(normalized);
    }

    const userLabel = this.#renderUserLabel(userMeta);
    this.#emitConsoleMessage({
      role: "bot",
      channel: "telegram",
      initiator,
      user: userMeta,
      text: `TG -> ${userLabel}: ${shortText(normalized)}`,
    });
  }

  #renderUserLabel(userMeta = {}) {
    if (userMeta.username) {
      return `@${userMeta.username}`;
    }
    if (userMeta.id) {
      return `id:${userMeta.id}`;
    }
    if (userMeta.firstName) {
      return userMeta.firstName;
    }
    return "unknown";
  }

  #emitConsoleMessage(message) {
    if (typeof this.emitToUi !== "function") {
      return;
    }
    this.emitToUi({
      ...message,
      text: maskSensitiveText(message.text),
    });
  }
}

module.exports = {
  BotManager,
};
