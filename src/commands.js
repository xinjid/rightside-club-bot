const { normalizePhone, formatPhone } = require("./smartshell");

const ROLE_SCORE = {
  admin: 1,
  moderator: 2,
  owner: 3,
};

function normalizeCommandName(commandName) {
  return String(commandName || "").trim().replace(/^\//, "").toLowerCase();
}

function hasRole(role, minRole) {
  const current = ROLE_SCORE[String(role || "").toLowerCase()] || 0;
  const required = ROLE_SCORE[String(minRole || "").toLowerCase()] || 0;
  return current >= required;
}

function parseDurationToMs(durationRaw) {
  const value = String(durationRaw || "").trim();
  if (!value) {
    throw new Error("Укажи duration, например 30m/2h/1d");
  }

  if (/^\d+$/.test(value)) {
    return Number(value) * 60 * 60 * 1000;
  }

  const match = value.match(/^(\d+)\s*([mhdw])$/i);
  if (!match) {
    throw new Error("Неверный duration. Используй 30m / 2h / 1d или число часов");
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitToMs = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return amount * unitToMs[unit];
}

function formatNumber(value) {
  if (value == null || value === "") {
    return "—";
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return String(value);
  }
  return num.toFixed(2);
}

function formatClientCard(client, fallbackPhone) {
  const discounts = Array.isArray(client?.discounts) && client.discounts.length > 0
    ? client.discounts.map((entry) => `${entry.type}:${entry.value}`).join(", ")
    : "нет";

  return [
    `👤 nickname: ${client?.nickname || "—"}`,
    `📞 phone: ${formatPhone(client?.phone || fallbackPhone)}`,
    `🆔 id: ${client?.id ?? "—"}`,
    `🆔 uuid: ${client?.uuid || "—"}`,
    `👥 group: ${client?.group?.title || "—"}`,
    `💰 deposit: ${formatNumber(client?.deposit)}`,
    `⭐ bonus: ${formatNumber(client?.bonus)}`,
    `🏷 user_discount: ${formatNumber(client?.user_discount)}`,
    `🎟 discounts: ${discounts}`,
  ].join("\n");
}

async function resolveClient(targetRaw, context) {
  const target = String(targetRaw || "").trim();
  if (!target) {
    throw new Error("Не указан клиент (phone|nickname|uuid)");
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target);
  if (isUuid) {
    const byUuid = await context.smartshellClient.findClientByUuid(target);
    if (!byUuid) {
      throw new Error("Клиент по UUID не найден");
    }
    return byUuid;
  }

  const normalizedPhone = normalizePhone(target);
  if (normalizedPhone) {
    const byPhone = await context.smartshellClient.findClientByPhone(normalizedPhone);
    if (!byPhone) {
      throw new Error("Клиент по телефону не найден");
    }
    return byPhone;
  }

  const byQuery = await context.smartshellClient.findClientByQuery(target);
  if (!byQuery) {
    throw new Error("Клиент не найден");
  }
  return byQuery;
}

async function handlePing() {
  return {
    ok: true,
    command: "ping",
    text: "pong 🟢",
  };
}

async function handleWho(args, context) {
  const phoneInput = String(args?.phone || args?.target || "").trim();
  if (!phoneInput) {
    return {
      ok: false,
      command: "who",
      text: "Использование: /who +79991234567",
    };
  }

  try {
    const client = await context.smartshellClient.findClientByPhone(phoneInput);
    if (!client) {
      return { ok: true, command: "who", text: "Клиент не найден" };
    }
    const normalized = normalizePhone(phoneInput);
    return { ok: true, command: "who", text: formatClientCard(client, normalized) };
  } catch (error) {
    const message = error?.message || String(error);
    context.logger.error(`Command who failed: ${message}`);
    return { ok: false, command: "who", text: `Ошибка SmartShell: ${message}` };
  }
}

async function handleDiscountSet(args, context) {
  const phone = String(args?.phone || args?.target || "").trim();
  const valueRaw = String(args?.value ?? args?.valuePercent ?? "").trim();
  const durationRaw = String(args?.duration || "").trim();

  if (!phone || !valueRaw || !durationRaw) {
    return {
      ok: false,
      command: "discount_set",
      text: "Использование: /discount_set <phone> <value> <duration>",
    };
  }

  const value = Number(valueRaw);
  if (Number.isNaN(value)) {
    return {
      ok: false,
      command: "discount_set",
      text: "value должен быть числом, например 15",
    };
  }

  try {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return {
        ok: false,
        command: "discount_set",
        text: "Телефон не распознан. Пример: +79991234567",
      };
    }

    const client = await context.smartshellClient.findClientByPhone(normalizedPhone);
    if (!client) {
      return {
        ok: false,
        command: "discount_set",
        text: "Клиент не найден",
      };
    }

    const previousValue = client.user_discount != null ? Number(client.user_discount) : 0;
    await context.smartshellClient.setUserDiscount(client.uuid, Math.round(value));

    const ms = parseDurationToMs(durationRaw);
    const now = Date.now();
    const endsAt = new Date(now + ms).toISOString();
    const job = context.scheduler.createActiveJob({
      clientUuid: client.uuid,
      clientPhone: client.phone || normalizedPhone,
      clientNickname: client.nickname || "",
      discountValue: Math.round(value),
      previousDiscountValue: previousValue,
      endsAt,
      createdByTelegramUserId: context.user?.id || "local",
    });

    context.logger.info(
      `Discount job created id=${job.id} uuid=${client.uuid} value=${Math.round(value)} ends=${endsAt}`
    );

    if (typeof context.emitToUi === "function") {
      context.emitToUi({
        role: "system",
        channel: "scheduler",
        initiator: context.initiator || "system",
        text: `Discount job created id=${job.id} value=${Math.round(value)}%`,
      });
    }

    return {
      ok: true,
      command: "discount_set",
      text:
        `Скидка назначена.\n` +
        `jobId=${job.id}\n` +
        `client=${client.nickname || "—"} (${formatPhone(client.phone || normalizedPhone)})\n` +
        `value=${Math.round(value)}%\n` +
        `до=${endsAt}`,
    };
  } catch (error) {
    const message = error?.message || String(error);
    context.logger.error(`Command discount_set failed: ${message}`);
    return {
      ok: false,
      command: "discount_set",
      text: `Ошибка discount_set: ${message}`,
    };
  }
}

async function handleDiscountRemove(args, context) {
  const phoneOrUuid = String(args?.phone || args?.target || "").trim();
  if (!phoneOrUuid) {
    return {
      ok: false,
      command: "discount_remove",
      text: "Использование: /discount_remove <phone>",
    };
  }

  try {
    const client = await resolveClient(phoneOrUuid, context);
    await context.smartshellClient.setUserDiscount(client.uuid, 0);
    context.scheduler.markClientJobsFinished(client.uuid, "finished");
    context.logger.info(`Discount removed immediately uuid=${client.uuid}`);

    return {
      ok: true,
      command: "discount_remove",
      text: `Скидка снята для ${client.nickname || "клиента"} (${formatPhone(client.phone)})`,
    };
  } catch (error) {
    const message = error?.message || String(error);
    context.logger.error(`Command discount_remove failed: ${message}`);
    return {
      ok: false,
      command: "discount_remove",
      text: `Ошибка discount_remove: ${message}`,
    };
  }
}

async function handleDiscountList(args, context) {
  const limitRaw = Number(args?.limit || 20);
  const limit = Number.isNaN(limitRaw) ? 20 : Math.max(1, Math.min(50, limitRaw));
  const role = String(context.role || "admin").toLowerCase();
  const createdBy = hasRole(role, "moderator") ? null : String(context.user?.id || "");

  const jobs = context.scheduler.listJobs({
    limit,
    createdByTelegramUserId: createdBy || null,
    statuses: ["active", "scheduled"],
  });

  if (!jobs.length) {
    return {
      ok: true,
      command: "discount_list",
      text: "Активных/запланированных скидок нет",
    };
  }

  const lines = jobs.map((job) => {
    const clientLabel = job.client_nickname || formatPhone(job.client_phone) || job.client_uuid;
    return `#${job.id} | ${job.status} | ${clientLabel} | ${job.discount_value}% | до ${job.ends_at}`;
  });

  return {
    ok: true,
    command: "discount_list",
    text: `Скидки:\n${lines.join("\n")}`,
  };
}

async function handleDiscountCancel(args, context) {
  if (!hasRole(context.role, "moderator")) {
    return {
      ok: false,
      command: "discount_cancel",
      text: "Команда доступна только moderator/owner",
    };
  }

  const jobId = Number(args?.jobId || args?.id);
  if (Number.isNaN(jobId)) {
    return {
      ok: false,
      command: "discount_cancel",
      text: "Использование: /discount_cancel <jobId>",
    };
  }

  try {
    const updated = await context.scheduler.cancelJob(jobId);
    return {
      ok: true,
      command: "discount_cancel",
      text: `Задача отменена: #${updated.id} (${updated.status})`,
    };
  } catch (error) {
    const message = error?.message || String(error);
    context.logger.error(`Command discount_cancel failed: ${message}`);
    return {
      ok: false,
      command: "discount_cancel",
      text: `Ошибка discount_cancel: ${message}`,
    };
  }
}

async function handleCommand(commandName, args = {}, context) {
  const command = normalizeCommandName(commandName);
  switch (command) {
    case "ping":
      return handlePing(args, context);
    case "who":
      return handleWho(args, context);
    case "discount":
    case "discount_set":
      return handleDiscountSet(args, context);
    case "discount_remove":
      return handleDiscountRemove(args, context);
    case "discount_list":
      return handleDiscountList(args, context);
    case "discount_cancel":
      return handleDiscountCancel(args, context);
    default:
      return {
        ok: false,
        command: command || "unknown",
        text: `Неизвестная команда: ${commandName}`,
      };
  }
}

module.exports = {
  handleCommand,
  normalizePhone,
  formatPhone,
  hasRole,
};
