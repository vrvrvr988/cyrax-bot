/**
 * CYRAX CORE BOT — Render (Polling, без webhook)
 *
 * Render -> Environment Variables (обязательные):
 *  - BOT_TOKEN
 *  - ADMIN_ID               (твой Telegram user id, например 899914946)
 *
 * Опциональные:
 *  - PANEL_GENERATE_URL      (полная ссылка на генерацию ключа)
 *  - PANEL_API_KEY           (если панель требует ключ — НЕ обязательно)
 *  - PANEL_API_KEY_HEADER    (по умолчанию: Authorization)
 *  - PANEL_TIMEOUT_MS        (по умолчанию 15000)
 *  - COOLDOWN_SECONDS        (по умолчанию 15)
 *  - CHAT_ID                 (куда постить, например -1003552668286)
 *  - BOT_BRAND               (по умолчанию "CYRAX CORE")
 */

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const PANEL_GENERATE_URL = process.env.PANEL_GENERATE_URL || "";
const PANEL_API_KEY = process.env.PANEL_API_KEY || "";
const PANEL_API_KEY_HEADER = process.env.PANEL_API_KEY_HEADER || "Authorization";
const PANEL_TIMEOUT_MS = Number(process.env.PANEL_TIMEOUT_MS || "15000");
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "15");
const CHAT_ID = process.env.CHAT_ID ? String(process.env.CHAT_ID) : "";
const BOT_BRAND = process.env.BOT_BRAND || "CYRAX CORE";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");
if (!ADMIN_ID) throw new Error("ADMIN_ID not set");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// -------------------------
// State (в памяти; на free-хосте после рестарта сбросится)
// -------------------------
const processedUpdateIds = new Map(); // updateId -> timestamp
const processedActionKeys = new Map(); // actionKey -> timestamp
const userCooldown = new Map(); // userId -> lastTs
const keyHistory = []; // последние ключи (в памяти)
const HISTORY_LIMIT = 50;

// глобальная защита от параллельной генерации
let genInProgress = false;

// -------------------------
// Helpers
// -------------------------
function now() {
  return Date.now();
}

function isAdminId(chatIdOrUserId) {
  return String(chatIdOrUserId) === ADMIN_ID;
}

function cleanupMaps() {
  // чистим каждые вызовы понемногу
  const t = now();
  const TTL = 10 * 60 * 1000; // 10 минут
  for (const [k, v] of processedUpdateIds) if (t - v > TTL) processedUpdateIds.delete(k);
  for (const [k, v] of processedActionKeys) if (t - v > TTL) processedActionKeys.delete(k);

  const CDTTL = 60 * 60 * 1000; // 1 час
  for (const [k, v] of userCooldown) if (t - v > CDTTL) userCooldown.delete(k);
}

function setCooldown(userId) {
  userCooldown.set(String(userId), now());
}

function cooldownLeft(userId) {
  const last = userCooldown.get(String(userId)) || 0;
  const diff = Math.floor((now() - last) / 1000);
  const left = COOLDOWN_SECONDS - diff;
  return left > 0 ? left : 0;
}

function pushHistory(item) {
  keyHistory.unshift(item);
  if (keyHistory.length > HISTORY_LIMIT) keyHistory.length = HISTORY_LIMIT;
}

function prettyTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString("ru-RU");
}

function sanitizeKey(str) {
  return String(str || "").trim();
}

function looksLikeKey(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length < 6 || t.length > 200) return false;
  // допускаем ключи вида ABC-123, token_123, и т.п.
  return /^[A-Za-z0-9\-_:.=+/]+$/.test(t);
}

function findKeyInObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  // самые частые варианты
  const directCandidates = [
    obj.key,
    obj.license,
    obj.token,
    obj.code,
    obj.data && obj.data.key,
    obj.data && obj.data.license,
    obj.result && obj.result.key,
    obj.result && obj.result.license,
    obj.result && obj.result.token,
  ];

  for (const c of directCandidates) {
    if (typeof c === "string" && looksLikeKey(c)) return c.trim();
  }

  // если это массив
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findKeyInObject(item);
      if (found) return found;
    }
  }

  // общий поиск по всем строкам объекта (на всякий случай)
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && looksLikeKey(v)) return v.trim();
    if (typeof v === "object" && v) {
      const found = findKeyInObject(v);
      if (found) return found;
    }
  }

  return null;
}

async function callPanelGenerateKey() {
  if (!PANEL_GENERATE_URL) {
    return { ok: false, error: "PANEL_GENERATE_URL не задан (Render → Environment Variables)." };
  }

  const headers = {};
  if (PANEL_API_KEY) headers[PANEL_API_KEY_HEADER] = PANEL_API_KEY;

  const res = await axios.get(PANEL_GENERATE_URL, {
    timeout: PANEL_TIMEOUT_MS,
    maxRedirects: 5,
    headers,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    const body =
      typeof res.data === "string"
        ? res.data.slice(0, 300)
        : JSON.stringify(res.data).slice(0, 300);
    return { ok: false, error: `Панель вернула HTTP ${res.status}: ${body}` };
  }

  // JSON
  if (typeof res.data === "object" && res.data) {
    const key = findKeyInObject(res.data);
    if (key) return { ok: true, key };
    return {
      ok: false,
      error:
        "Панель вернула JSON, но ключ не найден. (Нужно поле типа key/license/token).",
      raw: JSON.stringify(res.data).slice(0, 400),
    };
  }

  // Text / HTML
  const text = String(res.data || "").trim();
  if (looksLikeKey(text)) return { ok: true, key: text };

  // попробуем вытащить первую похожую “строку-ключ” из текста
  const match = text.match(/[A-Za-z0-9\-_:.=+/]{8,200}/);
  if (match && looksLikeKey(match[0])) return { ok: true, key: match[0] };

  return {
    ok: false,
    error: "Не распознал ключ в ответе панели (похоже на HTML/текст без ключа).",
    raw: text.slice(0, 400),
  };
}

function menuKeyboard(isAdmin) {
  // компактно, под телефон
  const rows = [];

  if (isAdmin) {
    rows.push([{ text: "⚡ Генерировать ключ", callback_data: "gen" }]);
    rows.push(
      [
        { text: "📜 История", callback_data: "history" },
        { text: "🧹 Очистить", callback_data: "clear" },
      ]
    );
    rows.push(
      [
        { text: "📣 Постинг", callback_data: "post" },
        { text: "🧪 SELF TEST", callback_data: "selftest" },
      ]
    );
  } else {
    rows.push([{ text: "ℹ️ Инфо", callback_data: "info" }]);
  }

  rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function mainText(isAdmin) {
  return (
    `🕶 <b>${BOT_BRAND}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    (isAdmin
      ? `Роль: <b>ADMIN</b>\n`
      : `Доступ: <b>ограничен</b>\n`) +
    `Команды:\n` +
    `/start\n` +
    `/ping\n` +
    `/whoami\n` +
    (isAdmin ? `/gen  (админ)\n/history (админ)\n/clear (админ)\n/post (админ)\n` : ``) +
    `━━━━━━━━━━━━━━\n` +
    `Жми кнопки ниже 👇`
  );
}

async function safeSend(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { parse_mode: "HTML", ...extra });
}

// -------------------------
// Commands
// -------------------------
bot.onText(/\/start/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  const isAdmin = isAdminId(msg.from?.id);

  await safeSend(chatId, mainText(isAdmin), menuKeyboard(isAdmin));
});

bot.onText(/\/menu/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  const isAdmin = isAdminId(msg.from?.id);
  await safeSend(chatId, mainText(isAdmin), menuKeyboard(isAdmin));
});

bot.onText(/\/ping/, async (msg) => {
  cleanupMaps();
  await bot.sendMessage(msg.chat.id, "🏓 pong");
});

bot.onText(/\/whoami/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  const uId = msg.from?.id;
  await bot.sendMessage(chatId, `chat_id: ${chatId}\nadmin: ${isAdminId(uId)}`);
});

bot.onText(/\/history/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  if (!isAdminId(msg.from?.id)) return bot.sendMessage(chatId, "⛔ Доступ ограничен. Напиши админу.");

  if (keyHistory.length === 0) {
    return bot.sendMessage(chatId, "📜 История пуста.");
  }

  const lines = keyHistory
    .slice(0, 15)
    .map((h, i) => `${i + 1}) <code>${h.key}</code>\n   🕒 ${prettyTime(h.ts)}`)
    .join("\n\n");

  await safeSend(chatId, `📜 <b>История (последние)</b>\n\n${lines}`, menuKeyboard(true));
});

bot.onText(/\/clear/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  if (!isAdminId(msg.from?.id)) return bot.sendMessage(chatId, "⛔ Доступ ограничен.");

  keyHistory.length = 0;
  await bot.sendMessage(chatId, "🧹 История очищена.");
});

bot.onText(/\/post/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  if (!isAdminId(msg.from?.id)) return bot.sendMessage(chatId, "⛔ Доступ ограничен.");

  if (!CHAT_ID) {
    return bot.sendMessage(chatId, "⚠️ CHAT_ID не задан. Добавь переменную CHAT_ID в Render (например -1003552668286).");
  }

  await bot.sendMessage(chatId, "📣 Отправь следующее сообщение — я запощу его в чат. (1 сообщение = 1 пост)");
  // включаем “режим ожидания поста” через флаг в памяти
  processedActionKeys.set(`await_post:${ADMIN_ID}`, now());
});

bot.onText(/\/gen/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isAdminId(userId)) {
    return bot.sendMessage(chatId, "⛔ Доступ ограничен. Напиши админу.");
  }

  // идемпотентность по сообщению
  const actionKey = `gen:msg:${chatId}:${msg.message_id}`;
  if (processedActionKeys.has(actionKey)) {
    return bot.sendMessage(chatId, "🛡 Уже обработано. (защита от дубля)");
  }
  processedActionKeys.set(actionKey, now());

  const left = cooldownLeft(userId);
  if (left > 0) return bot.sendMessage(chatId, `⏳ Подожди ${left} сек.`);

  if (genInProgress) return bot.sendMessage(chatId, "⏳ Генерация уже идёт. Подожди пару секунд.");

  genInProgress = true;
  setCooldown(userId);

  try {
    await bot.sendMessage(chatId, "⚡ Генерирую ключ…");

    const r = await callPanelGenerateKey();
    if (!r.ok) {
      const extra = r.raw ? `\n\n<pre>${String(r.raw).replace(/</g, "&lt;")}</pre>` : "";
      await safeSend(chatId, `❌ <b>Ошибка панели</b>\n${r.error}${extra}`, menuKeyboard(true));
      return;
    }

    const key = sanitizeKey(r.key);
    pushHistory({ key, ts: now() });

    await safeSend(
      chatId,
      `✅ <b>Ключ:</b>\n<code>${key}</code>\n\n🛡 1 нажатие = 1 ключ`,
      menuKeyboard(true)
    );
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "❗ Ошибка. Проверь логи Render.");
  } finally {
    genInProgress = false;
  }
});

// -------------------------
// Callback buttons (inline menu)
// -------------------------
bot.on("callback_query", async (q) => {
  cleanupMaps();

  const data = q.data || "";
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;

  // отвечаем на callback, чтобы Telegram не крутил “часики”
  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (!chatId) return;

  // идемпотентность по callback id
  const actionKey = `cb:${q.id}`;
  if (processedActionKeys.has(actionKey)) return;
  processedActionKeys.set(actionKey, now());

  const isAdmin = isAdminId(userId);

  if (data === "menu") {
    return safeSend(chatId, mainText(isAdmin), menuKeyboard(isAdmin));
  }

  if (data === "info") {
    return safeSend(
      chatId,
      `ℹ️ <b>${BOT_BRAND}</b>\nДоступ ограничен.\nНапиши админу для получения прав.`,
      menuKeyboard(false)
    );
  }

  // дальше — только админ
  if (!isAdmin) {
    return bot.sendMessage(chatId, "⛔ Доступ ограничен. Напиши админу.");
  }

  if (data === "history") {
    if (keyHistory.length === 0) return bot.sendMessage(chatId, "📜 История пуста.");
    const lines = keyHistory
      .slice(0, 15)
      .map((h, i) => `${i + 1}) <code>${h.key}</code>\n   🕒 ${prettyTime(h.ts)}`)
      .join("\n\n");
    return safeSend(chatId, `📜 <b>История (последние)</b>\n\n${lines}`, menuKeyboard(true));
  }

  if (data === "clear") {
    keyHistory.length = 0;
    return bot.sendMessage(chatId, "🧹 История очищена.");
  }

  if (data === "selftest") {
    const panelSet = !!PANEL_GENERATE_URL;
    const chatSet = !!CHAT_ID;
    return safeSend(
      chatId,
      `🧪 <b>SELF TEST</b>\n` +
        `BOT_TOKEN: ✅\n` +
        `ADMIN_ID: ✅\n` +
        `PANEL_GENERATE_URL: ${panelSet ? "✅" : "❌"}\n` +
        `CHAT_ID: ${chatSet ? "✅" : "❌"}\n` +
        `COOLDOWN_SECONDS: <b>${COOLDOWN_SECONDS}</b>\n`,
      menuKeyboard(true)
    );
  }

  if (data === "post") {
    if (!CHAT_ID) return bot.sendMessage(chatId, "⚠️ CHAT_ID не задан. Добавь CHAT_ID в Render.");
    processedActionKeys.set(`await_post:${ADMIN_ID}`, now());
    return bot.sendMessage(chatId, "📣 Отправь следующее сообщение — я запощу его в чат (1 сообщение).");
  }

  if (data === "gen") {
    // ген по кнопке = ещё более строгая защита
    const left = cooldownLeft(userId);
    if (left > 0) return bot.sendMessage(chatId, `⏳ Подожди ${left} сек.`);

    if (genInProgress) return bot.sendMessage(chatId, "⏳ Генерация уже идёт.");

    genInProgress = true;
    setCooldown(userId);

    try {
      await bot.sendMessage(chatId, "⚡ Генерирую ключ…");

      const r = await callPanelGenerateKey();
      if (!r.ok) {
        const extra = r.raw ? `\n\n<pre>${String(r.raw).replace(/</g, "&lt;")}</pre>` : "";
        await safeSend(chatId, `❌ <b>Ошибка панели</b>\n${r.error}${extra}`, menuKeyboard(true));
        return;
      }

      const key = sanitizeKey(r.key);
      pushHistory({ key, ts: now() });

      await safeSend(
        chatId,
        `✅ <b>Ключ:</b>\n<code>${key}</code>\n\n🛡 1 нажатие = 1 ключ`,
        menuKeyboard(true)
      );
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "❗ Ошибка. Проверь логи Render.");
    } finally {
      genInProgress = false;
    }
    return;
  }
});

// -------------------------
// “await post” handler (админ отправляет следующее сообщение — бот постит в чат)
// -------------------------
bot.on("message", async (msg) => {
  cleanupMaps();

  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();
  if (!text) return;

  // пропускаем команды и служебные
  if (text.startsWith("/")) return;

  // режим ожидания поста
  const awaitKey = `await_post:${ADMIN_ID}`;
  if (isAdminId(userId) && processedActionKeys.has(awaitKey)) {
    processedActionKeys.delete(awaitKey);

    if (!CHAT_ID) return bot.sendMessage(chatId, "⚠️ CHAT_ID не задан.");
    try {
      await bot.sendMessage(CHAT_ID, `📣 <b>${BOT_BRAND}</b>\n\n${text}`, { parse_mode: "HTML" });
      await bot.sendMessage(chatId, "✅ Запостил в чат.");
    } catch (e) {
      console.error(e);
      await bot.sendMessage(chatId, "❌ Не смог запостить. Проверь, что бот добавлен в чат и у него есть право писать.");
    }
  }
});

console.log("✅ CYRAX bot started (polling)...");
