// index.js
import 'dotenv/config';
import { Telegraf } from 'telegraf';
import axios from 'axios';

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing in .env');

const GRAPHQL_URL = process.env.SMARTSHELL_GRAPHQL_URL;
const BEARER = process.env.SMARTSHELL_BEARER;
const ORIGIN = process.env.SMARTSHELL_ORIGIN || 'https://admin.smartshell.gg';
const REFERER = process.env.SMARTSHELL_REFERER || 'https://admin.smartshell.gg/';

// Админы: через запятую. Пример: ADMIN_IDS=383468470,123456789
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

if (!GRAPHQL_URL) console.warn('⚠️ SMARTSHELL_GRAPHQL_URL is not set');
if (!BEARER) console.warn('⚠️ SMARTSHELL_BEARER is not set');
if (ADMIN_IDS.size === 0) console.warn('⚠️ ADMIN_IDS is empty. No one will have access except /start.');

const bot = new Telegraf(BOT_TOKEN);

// ====== HELPERS ======
function normalizePhone(input) {
  const raw = String(input || '').trim();
  const cleaned = raw.replace(/[^\d+]/g, '');

  let p = cleaned;
  if (/^8\d{10}$/.test(p)) p = '+7' + p.slice(1);
  if (/^7\d{10}$/.test(p)) p = '+' + p;
  if (/^\+7\d{10}$/.test(p)) return p;

  return p;
}

function phoneToSmartshellQuery(normalizedPhone) {
  // SmartShell хранит phone как "79..." без "+"
  return String(normalizedPhone).replace(/[^\d]/g, '');
}

function isPhoneLike(phone) {
  return /^\+?\d{10,15}$/.test(phone);
}

const CLIENTS_QUERY =
  "query clients($input: ClientsInput, $first: Int, $page: Int) {\n" +
  "  clients(input: $input, first: $first, page: $page) {\n" +
  "    total_deposits\n" +
  "    paginatorInfo {\n" +
  "      count\n" +
  "      currentPage\n" +
  "      lastPage\n" +
  "      total\n" +
  "      __typename\n" +
  "    }\n" +
  "    data {\n" +
  "      id\n" +
  "      uuid\n" +
  "      nickname\n" +
  "      phone\n" +
  "      last_client_activity\n" +
  "      user_discount\n" +
  "      discounts {\n" +
  "        type\n" +
  "        value\n" +
  "        __typename\n" +
  "      }\n" +
  "      group {\n" +
  "        uuid\n" +
  "        title\n" +
  "        discount\n" +
  "        __typename\n" +
  "      }\n" +
  "      deposit\n" +
  "      bonus\n" +
  "      banned_at\n" +
  "      created_at\n" +
  "      unverified\n" +
  "      avatar_url\n" +
  "      roles {\n" +
  "        alias\n" +
  "        __typename\n" +
  "      }\n" +
  "      __typename\n" +
  "    }\n" +
  "    __typename\n" +
  "  }\n" +
  "}\n";

async function findUserByPhone(phoneNormalized) {
  if (!GRAPHQL_URL || !BEARER) {
    throw new Error('SmartShell env is not configured (SMARTSHELL_GRAPHQL_URL/SMARTSHELL_BEARER).');
  }

  const q = phoneToSmartshellQuery(phoneNormalized);

  const payload = {
    operationName: 'clients',
    variables: {
      input: {
        q,
        sort: { field: 'last_client_activity', direction: 'DESC' },
      },
      first: 25,
      page: 1,
    },
    query: CLIENTS_QUERY,
  };

  const { data } = await axios.post(GRAPHQL_URL, payload, {
    timeout: 20000,
    headers: {
      Authorization: `Bearer ${BEARER}`,
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Referer: REFERER,
      Accept: '*/*',
    },
  });

  if (data?.errors?.length) {
    const msg = data.errors.map((e) => e.message).join('; ');
    throw new Error(`SmartShell GraphQL error: ${msg}`);
  }

  const list = data?.data?.clients?.data || [];
  if (!Array.isArray(list) || list.length === 0) return null;

  const target = q;
  const exact = list.find((u) => String(u.phone) === target) || null;

  return exact || list[0];
}

function formatUserMessage(user, inputPhoneNormalized) {
  const name = user.nickname || '—';

  const phoneDigits = String(user.phone || phoneToSmartshellQuery(inputPhoneNormalized));
  const phonePretty = phoneDigits.startsWith('7') && phoneDigits.length === 11 ? `+${phoneDigits}` : phoneDigits;

  const id = user.id ?? '—';

  const groupTitle = user.group?.title || '—';
  const groupDiscount = user.group?.discount ?? '—';

  const deposit = user.deposit != null ? Number(user.deposit).toFixed(2) : '—';
  const bonus = user.bonus != null ? Number(user.bonus).toFixed(2) : '—';

  const lastAct = user.last_client_activity || '—';
  const createdAt = user.created_at || '—';
  const banned = user.banned_at ? `да (${user.banned_at})` : 'нет';
  const unverified = user.unverified ? 'да' : 'нет';

  const discounts = Array.isArray(user.discounts) ? user.discounts : [];
  const discountLines =
    discounts.length === 0
      ? 'Скидок нет.'
      : discounts.map((d, i) => `${i + 1}) ${d.type}: ${d.value}%`).join('\n');

  return (
    `👤 Клиент: ${name}\n` +
    `📞 Телефон: ${phonePretty}\n` +
    `🆔 ID: ${id}\n` +
    `👥 Группа: ${groupTitle} (${groupDiscount}%)\n` +
    `💰 Депозит: ${deposit}\n` +
    `⭐️ Бонус: ${bonus}\n` +
    `🕒 Активность: ${lastAct}\n` +
    `🗓️ Создан: ${createdAt}\n` +
    `⛔️ Бан: ${banned}\n` +
    `✅ Невериф.: ${unverified}\n` +
    `\n🎟️ Скидки:\n${discountLines}`
  );
}

async function handlePhoneLookup(ctx, inputPhone) {
  const phoneNorm = normalizePhone(inputPhone);

  if (!isPhoneLike(phoneNorm)) {
    await ctx.reply('Телефон не похож на корректный. Пример: +79990001122');
    return;
  }

  await ctx.reply(`Ищу клиента в SmartShell по номеру ${phoneNorm}…`);

  try {
    const user = await findUserByPhone(phoneNorm);
    if (!user) {
      await ctx.reply('Клиент не найден.');
      return;
    }
    await ctx.reply(formatUserMessage(user, phoneNorm));
  } catch (err) {
    await ctx.reply('Ошибка SmartShell:\n' + String(err?.message || err));
  }
}

// ====== ACCESS CONTROL (ADMINS ONLY) ======
// Разрешаем всем только /start (чтобы в будущем можно было принимать инвайты).
// Всё остальное — только тем, кто в ADMIN_IDS.
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id ? String(ctx.from.id) : null;
  const text = ctx.message?.text || '';

  if (typeof text === 'string' && text.startsWith('/start')) {
    return next();
  }

  if (!uid || !ADMIN_IDS.has(uid)) {
    await ctx.reply('⛔️ Нет доступа. Обратись к администратору.');
    return;
  }

  return next();
});

// ====== COMMANDS ======
bot.start((ctx) => {
  ctx.reply(
    'Бот SmartShell ✅\n\n' +
      'Команды:\n' +
      '/who +79990001122 — найти клиента и показать скидки\n' +
      '/ping — проверка\n'
  );
});

bot.command('ping', (ctx) => ctx.reply('pong 🟢'));

bot.command('who', async (ctx) => {
  const parts = ctx.message.text.split(' ').filter(Boolean);
  const input = parts.slice(1).join(' ');
  if (!input) {
    await ctx.reply('Напиши: /who +79990001122');
    return;
  }
  await handlePhoneLookup(ctx, input);
});

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (text.startsWith('/')) return;
  await handlePhoneLookup(ctx, text);
});

// ====== RUN ======
bot.launch();
console.log('Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
