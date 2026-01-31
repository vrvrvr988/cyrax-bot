/**
 * CYRAX CORE BOT — Render Polling + Generate-to-Chat
 * Версия с усиленной защитой от дублей сообщений
 * Последнее обновление: февраль 2026
 */

const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Dummy server для Render (keep-alive)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("CYRAX bot alive\n");
}).listen(PORT, () => console.log(`HTTP server on ${PORT}`));

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const PANEL_GENERATE_URL_1D = process.env.PANEL_GENERATE_URL_1D;
const PANEL_GENERATE_URL_3D = process.env.PANEL_GENERATE_URL_3D;
const PANEL_GENERATE_URL_7D = process.env.PANEL_GENERATE_URL_7D;
const CHAT_ID = process.env.CHAT_ID ? String(process.env.CHAT_ID) : "";
const PANEL_API_KEY = process.env.PANEL_API_KEY || "";
const PANEL_API_KEY_HEADER = process.env.PANEL_API_KEY_HEADER || "Authorization";
const PANEL_TIMEOUT_MS = Number(process.env.PANEL_TIMEOUT_MS || 15000);
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || 15);
const BOT_BRAND = process.env.BOT_BRAND || "CYRAX CORE";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN не задан");
if (!ADMIN_ID) throw new Error("ADMIN_ID не задан");
if (!PANEL_GENERATE_URL_1D || !PANEL_GENERATE_URL_3D || !PANEL_GENERATE_URL_7D) {
  throw new Error("Не заданы URL генерации ключей");
}
if (!CHAT_ID) throw new Error("CHAT_ID не задан");

// Helpers
const now = () => Date.now();
const isAdmin = (id) => String(id) === ADMIN_ID;

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isValidUsername(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  const clean = t.startsWith("@") ? t.slice(1) : t;
  return clean.length >= 3 && clean.length <= 32 && /^[A-Za-z0-9_]+$/.test(clean);
}

function normalizeUsername(s) {
  const clean = String(s || "").trim().replace(/^@/, "");
  return "@" + clean;
}

function looksLikeKey(s) {
  const t = String(s || "").trim();
  return t.length >= 6 && t.length <= 200 && /^[A-Za-z0-9\-_:.=+/]+$/.test(t);
}

function findKeyInResponse(data) {
  if (!data || typeof data !== "object") return null;

  const candidates = [
    data.key, data.license, data.token, data.code,
    data.data?.key, data.data?.license, data.data?.token,
    data.result?.key, data.result?.license, data.result?.token
  ];

  for (const v of candidates) {
    if (typeof v === "string" && looksLikeKey(v)) return v.trim();
  }

  // глубокий поиск
  for (const v of Object.values(data)) {
    if (typeof v === "string" && looksLikeKey(v)) return v.trim();
    if (v && typeof v === "object") {
      const found = findKeyInResponse(v);
      if (found) return found;
    }
  }
  return null;
}

async function generateKeyFromPanel(url) {
  console.log(`[PANEL] Запрос → ${url}`);
  const headers = PANEL_API_KEY ? { [PANEL_API_KEY_HEADER]: PANEL_API_KEY } : {};

  try {
    const res = await axios.get(url, {
      timeout: PANEL_TIMEOUT_MS,
      headers,
      validateStatus: () => true
    });

    console.log(`[PANEL] Ответ: ${res.status} | ${String(res.data).slice(0, 180)}...`);

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}: ${String(res.data).slice(0, 120)}` };
    }

    let key = null;
    if (typeof res.data === "object") {
      key = findKeyInResponse(res.data);
    } else {
      const text = String(res.data).trim();
      key = looksLikeKey(text) ? text : text.match(/[A-Za-z0-9\-_:.=+/]{8,200}/)?.[0];
    }

    if (key) return { ok: true, key };
    return { ok: false, error: "Ключ не найден в ответе" };
  } catch (err) {
    console.error("[PANEL ERROR]", err.message, err.code);
    return { ok: false, error: err.message || "Ошибка соединения с панелью" };
  }
}

// State & protection
const processed = new Map();          // dedupe
const actionLocks = new Map();        // анти-флуд на 3–5 сек
let genInProgress = false;
const pending = new Map();            // {stage: 'wait_username'|'wait_duration', username?, createdAt}

function cleanup() {
  const t = now();
  for (const [k, v] of processed)    if (t - v > 15*60*1000) processed.delete(k);
  for (const [k, v] of actionLocks)  if (t > v) actionLocks.delete(k);
  for (const [k, v] of pending)      if (t - v.createdAt > 10*60*1000) pending.delete(k);
}

function isLocked(userId, action = "gen") {
  const key = `lock:${userId}:${action}`;
  return actionLocks.has(key);
}

function lock(userId, action = "gen", seconds = 4) {
  const key = `lock:${userId}:${action}`;
  actionLocks.set(key, now() + seconds * 1000);
}

// UI
function mainKeyboard(isAdmin) {
  if (!isAdmin) return { reply_markup: { inline_keyboard: [[{ text: "🏠 Меню", callback_data: "menu" }]] } };

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚡ Генерировать", callback_data: "gen" },
          { text: "🧪 SELF TEST", callback_data: "selftest" }
        ],
        [
          { text: "📣 Постинг", callback_data: "post" },
          { text: "🏠 Меню", callback_data: "menu" }
        ]
      ]
    }
  };
}

function durationKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "1 день", callback_data: "dur:1d" },
          { text: "3 дня", callback_data: "dur:3d" },
          { text: "7 дней", callback_data: "dur:7d" }
        ],
        [{ text: "Отмена", callback_data: "cancel" }]
      ]
    }
  };
}

function mainMessageText(chatId, isAdmin) {
  return `🕶 <b>${BOT_BRAND}</b>\n━━━━━━━━━━━━━━\n` +
    (isAdmin ? `Роль: <b>ADMIN</b>\n` : `Доступ: <b>ограничен</b>\n`) +
    `chat_id: <code>${chatId}</code>\n` +
    `Команды: /start /ping /whoami` + (isAdmin ? ` /gen` : "") +
    `\n━━━━━━━━━━━━━━\nЖми кнопки ниже 👇`;
}

// Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: { timeout: 30 } });

bot.on("polling_error", err => console.error("Polling error:", err.message || err));

// Генерация ключа
async function doGenerate(chatId, userId, username, duration) {
  const dedupe = `gen:${userId}:${username}:${duration}:${Math.floor(now()/10000)}`;
  if (processed.has(dedupe)) return bot.sendMessage(chatId, "🛡 Уже обработано");

  processed.set(dedupe, now());
  lock(userId, "gen_full", 10);

  if (genInProgress) return bot.sendMessage(chatId, "⏳ Генерация уже идёт...");
  genInProgress = true;

  try {
    await bot.sendMessage(chatId, `Генерирую ключ для ${escapeHtml(username)} (${duration})...`, { parse_mode: "HTML" });

    let url;
    if (duration === "1d") url = PANEL_GENERATE_URL_1D;
    else if (duration === "3d") url = PANEL_GENERATE_URL_3D;
    else if (duration === "7d") url = PANEL_GENERATE_URL_7D;
    else throw new Error("Неверная длительность");

    const result = await generateKeyFromPanel(url);
    if (!result.ok) {
      return bot.sendMessage(chatId, `❌ Ошибка панели:\n${escapeHtml(result.error)}`, {
        parse_mode: "HTML", ...mainKeyboard(true)
      });
    }

    const key = result.key;

    // В чат (главный канал)
    await bot.sendMessage(CHAT_ID, 
      `🔑 <b>Ключ для ${escapeHtml(username)}</b>\n` +
      `<code>${escapeHtml(key)}</code>\n` +
      `━━━━━━━━━━━━━━\nАдмин: ${userId}`,
      { parse_mode: "HTML" }
    );

    await bot.sendMessage(chatId, "✅ Ключ отправлен в чат.", { ...mainKeyboard(true) });
  } catch (err) {
    console.error("Generate fail:", err);
    await bot.sendMessage(chatId, "❗ Ошибка генерации. Проверь логи.", { ...mainKeyboard(true) });
  } finally {
    genInProgress = false;
  }
}

// Команды
bot.onText(/\/start/, async msg => {
  cleanup();
  const cid = msg.chat.id;
  const uid = msg.from.id;
  const admin = isAdmin(uid);
  await bot.sendMessage(cid, mainMessageText(cid, admin), { parse_mode: "HTML", ...mainKeyboard(admin) });
});

bot.onText(/\/ping/, msg => bot.sendMessage(msg.chat.id, "🏓 pong"));

bot.onText(/\/whoami/, msg => {
  bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}\nadmin: ${isAdmin(msg.from.id)}`);
});

bot.onText(/\/gen/, async msg => {
  cleanup();
  if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ Только админ");
  if (isLocked(msg.from.id)) return;
  lock(msg.from.id);

  pending.set(msg.chat.id, { stage: "wait_username", createdAt: now() });
  await bot.sendMessage(msg.chat.id, 
    "👤 Для кого ключ?\nНапиши @username одним сообщением",
    { parse_mode: "HTML", ...mainKeyboard(true) }
  );
});

// Callback
bot.on("callback_query", async q => {
  cleanup();
  await bot.answerCallbackQuery(q.id).catch(() => {});

  const cid = q.message?.chat?.id;
  const uid = q.from?.id;
  if (!cid || !uid) return;

  const admin = isAdmin(uid);
  if (!admin) return bot.sendMessage(cid, "⛔ Только админ");

  // Жёсткий dedupe + lock
  const dedupeKey = `cbq:${uid}:${q.data}:${q.message?.message_id || 0}`;
  if (processed.has(dedupeKey)) {
    console.log(`Повторный callback проигнорирован: ${dedupeKey}`);
    return;
  }
  processed.set(dedupeKey, now());

  if (isLocked(uid)) {
    console.log(`Операция заблокирована (анти-флуд): ${uid}`);
    return;
  }

  if (q.data === "menu") {
    return bot.sendMessage(cid, mainMessageText(cid, admin), { parse_mode: "HTML", ...mainKeyboard(admin) });
  }

  if (q.data === "selftest") {
    return bot.sendMessage(cid, 
      `SELF TEST\n` +
      `Admin: ${admin}\n` +
      `genInProgress: ${genInProgress}\n` +
      `Cooldown: ${COOLDOWN_SECONDS}s\n` +
      `Pending states: ${pending.size}`,
      { parse_mode: "HTML", ...mainKeyboard(true) }
    );
  }

  if (q.data === "post") {
    pending.delete(cid);
    processed.set(`post_mode:${cid}`, now() + 5*60*1000);
    return bot.sendMessage(cid, "📣 Отправь сообщение — запощу его в чат (одно)", { ...mainKeyboard(true) });
  }

  if (q.data === "gen") {
    if (isLocked(uid, "gen")) return;
    lock(uid, "gen");

    pending.set(cid, { stage: "wait_username", createdAt: now() });
    await bot.sendMessage(cid, 
      "👤 Для кого ключ?\nНапиши @username одним сообщением",
      { parse_mode: "HTML", ...mainKeyboard(true) }
    );
    return;
  }

  if (q.data === "cancel") {
    pending.delete(cid);
    return bot.sendMessage(cid, "❌ Отменено", { ...mainKeyboard(true) });
  }

  if (q.data.startsWith("dur:")) {
    const duration = q.data.slice(4);
    const state = pending.get(cid);
    if (!state || state.stage !== "wait_duration") {
      return bot.sendMessage(cid, "Сессия истекла. Начни заново.", { ...mainKeyboard(true) });
    }

    pending.delete(cid);
    await doGenerate(cid, uid, state.username, duration);
  }
});

// Обычные сообщения
bot.on("message", async msg => {
  cleanup();
  if (!msg.text?.trim() || msg.text.startsWith("/")) return;

  const cid = msg.chat.id;
  const uid = msg.from.id;
  const text = msg.text.trim();

  // Режим постинга
  const postTTL = processed.get(`post_mode:${cid}`);
  if (postTTL && now() < postTTL) {
    if (!isAdmin(uid)) return;
    processed.delete(`post_mode:${cid}`);

    try {
      await bot.sendMessage(CHAT_ID, `📣 <b>${BOT_BRAND}</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
      await bot.sendMessage(cid, "✅ Запостил", { ...mainKeyboard(true) });
    } catch (e) {
      console.error("Постинг ошибка:", e.message);
      await bot.sendMessage(cid, "❌ Не удалось запостить", { ...mainKeyboard(true) });
    }
    return;
  }

  // Генерация — ждём юзернейм
  const state = pending.get(cid);
  if (!state || !isAdmin(uid)) return;

  if (state.stage === "wait_username") {
    if (!isValidUsername(text)) {
      return bot.sendMessage(cid, "❌ Некорректный @username. Попробуй ещё раз.");
    }

    const username = normalizeUsername(text);
    pending.set(cid, { stage: "wait_duration", username, createdAt: now() });

    await bot.sendMessage(cid, `Выбери срок для ${escapeHtml(username)}:`, durationKeyboard());
  }
});

console.log("CYRAX BOT запущен");
