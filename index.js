/**
 * CYRAX CORE BOT — Render Polling + Generate-to-Chat
 * Минималистичная версия с editMessageText + чистым чатом
 * Обновлено: февраль 2026
 */
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Dummy server для Render
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
  for (const v of candidates) if (typeof v === "string" && looksLikeKey(v)) return v.trim();

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
    const res = await axios.get(url, { timeout: PANEL_TIMEOUT_MS, headers, validateStatus: () => true });
    console.log(`[PANEL] Ответ: ${res.status} | ${String(res.data).slice(0, 180)}...`);
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}: ${String(res.data).slice(0, 120)}` };
    }
    let key = null;
    if (typeof res.data === "object") key = findKeyInResponse(res.data);
    else {
      const text = String(res.data).trim();
      key = looksLikeKey(text) ? text : text.match(/[A-Za-z0-9\-_:.=+/]{8,200}/)?.[0];
    }
    if (key) return { ok: true, key };
    return { ok: false, error: "Ключ не найден" };
  } catch (err) {
    console.error("[PANEL ERROR]", err.message, err.code);
    return { ok: false, error: err.message || "Ошибка панели" };
  }
}

// State
const processed = new Map();
const actionLocks = new Map();
let genInProgress = false;
const pending = new Map(); // chatId → {stage, username, messageId, createdAt}
const mainMenus = new Map(); // chatId → messageId главного меню

function cleanup() {
  const t = now();
  for (const [k, v] of processed)    if (t - v > 15*60*1000) processed.delete(k);
  for (const [k, v] of actionLocks)  if (t > v) actionLocks.delete(k);
  for (const [k, v] of pending)      if (t - v.createdAt > 10*60*1000) pending.delete(k);
  for (const [k, v] of mainMenus)    if (t - v.timestamp > 30*60*1000) mainMenus.delete(k);
}

function isLocked(userId, action = "gen") {
  return actionLocks.has(`lock:${userId}:${action}`);
}

function lock(userId, action = "gen", seconds = 4) {
  actionLocks.set(`lock:${userId}:${action}`, now() + seconds * 1000);
}

// UI — минималистичные клавиатуры
function mainKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚡ Генерировать", callback_data: "gen" },
          { text: "🧪 Тест", callback_data: "selftest" }
        ],
        [
          { text: "📣 Пост", callback_data: "post" },
          { text: "♻ Обновить", callback_data: "refresh" }
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

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

function mainText(chatId) {
  return `🕶 <b>${BOT_BRAND}</b>\n` +
         `━━━━━━━━━━━━━━\n` +
         `Роль: <b>ADMIN</b>\n` +
         `chat_id: <code>${chatId}</code>\n` +
         `━━━━━━━━━━━━━━\n` +
         `Выбери действие:`;
}

// Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: { timeout: 30 } });

bot.on("polling_error", err => console.error("Polling error:", err));

// Вспомогательная функция — отправить или обновить главное меню
async function showMainMenu(cid, uid, editIfPossible = true) {
  const text = mainText(cid);
  const keyboard = mainKeyboard();

  const existing = mainMenus.get(cid);
  if (editIfPossible && existing) {
    try {
      await bot.editMessageText(text, {
        chat_id: cid,
        message_id: existing.messageId,
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup
      });
      return existing.messageId;
    } catch (e) {
      // если не удалось отредактировать (например, сообщение старое) — шлём новое
    }
  }

  const sent = await bot.sendMessage(cid, text, { parse_mode: "HTML", ...keyboard });
  mainMenus.set(cid, { messageId: sent.message_id, timestamp: now() });
  return sent.message_id;
}

// Генерация
async function doGenerate(cid, uid, username, duration) {
  const dedupe = `gen:${uid}:${username}:${duration}:${Math.floor(now()/10000)}`;
  if (processed.has(dedupe)) return;
  processed.set(dedupe, now());
  lock(uid, "gen_full", 10);

  if (genInProgress) return bot.sendMessage(cid, "⏳ Уже генерируется...");
  genInProgress = true;

  let tempMsg;
  try {
    tempMsg = await bot.sendMessage(cid, `Генерирую для ${escapeHtml(username)} (${duration})...`, { parse_mode: "HTML" });

    let url = duration === "1d" ? PANEL_GENERATE_URL_1D :
              duration === "3d" ? PANEL_GENERATE_URL_3D :
              duration === "7d" ? PANEL_GENERATE_URL_7D : null;
    if (!url) throw new Error("Неверная длительность");

    const result = await generateKeyFromPanel(url);
    if (!result.ok) {
      await bot.editMessageText(`❌ Ошибка: ${escapeHtml(result.error)}`, {
        chat_id: cid, message_id: tempMsg.message_id, parse_mode: "HTML"
      });
      return;
    }

    const key = result.key;

    await bot.sendMessage(CHAT_ID,
      `🔑 <b>Ключ для ${escapeHtml(username)}</b>\n<code>${escapeHtml(key)}</code>\n━━━━━━━━━━━━━━\nАдмин: ${uid}`,
      { parse_mode: "HTML" }
    );

    await bot.editMessageText(`✅ Ключ для ${escapeHtml(username)} отправлен в чат`, {
      chat_id: cid, message_id: tempMsg.message_id, parse_mode: "HTML", reply_markup: mainKeyboard().reply_markup
    });

  } catch (err) {
    console.error("Generate fail:", err);
    if (tempMsg) {
      await bot.editMessageText("❗ Ошибка генерации", { chat_id: cid, message_id: tempMsg.message_id });
    } else {
      bot.sendMessage(cid, "❗ Ошибка. Проверь логи.");
    }
  } finally {
    genInProgress = false;
  }
}

// Команды
bot.onText(/\/start|\/menu/, async msg => {
  cleanup();
  const cid = msg.chat.id;
  const uid = msg.from.id;
  if (!isAdmin(uid)) return bot.sendMessage(cid, "⛔ Только админ");
  await showMainMenu(cid, uid, false);
});

bot.onText(/\/ping/, msg => bot.sendMessage(msg.chat.id, "🏓 pong"));

bot.onText(/\/whoami/, msg => {
  bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}\nadmin: ${isAdmin(msg.from.id)}`);
});

// Callback
bot.on("callback_query", async q => {
  cleanup();
  await bot.answerCallbackQuery(q.id).catch(() => {});
  const cid = q.message?.chat?.id;
  const uid = q.from?.id;
  if (!cid || !uid || !isAdmin(uid)) return;

  const dedupeKey = `cbq:${uid}:${q.data}:${q.message?.message_id || 0}`;
  if (processed.has(dedupeKey)) return;
  processed.set(dedupeKey, now());

  if (isLocked(uid)) return;

  if (["menu", "refresh"].includes(q.data)) {
    await showMainMenu(cid, uid);
    return;
  }

  if (q.data === "selftest") {
    await bot.sendMessage(cid, `SELF TEST\nAdmin: да\ngenInProgress: ${genInProgress}\nCooldown: ${COOLDOWN_SECONDS}s`, { parse_mode: "HTML" });
    return;
  }

  if (q.data === "post") {
    pending.delete(cid);
    processed.set(`post_mode:${cid}`, now() + 5*60*1000);
    await bot.sendMessage(cid, "📣 Отправь одно сообщение — запощу в чат", removeKeyboard());
    return;
  }

  if (q.data === "gen") {
    lock(uid, "gen");
    pending.set(cid, { stage: "wait_username", createdAt: now() });
    await bot.sendMessage(cid, "👤 Введи @username:", removeKeyboard());
    return;
  }

  if (q.data === "cancel") {
    pending.delete(cid);
    await bot.sendMessage(cid, "❌ Отменено", mainKeyboard());
    return;
  }

  if (q.data.startsWith("dur:")) {
    const duration = q.data.slice(4);
    const state = pending.get(cid);
    if (!state || state.stage !== "wait_duration") return;
    pending.delete(cid);
    await doGenerate(cid, uid, state.username, duration);
  }
});

// Сообщения
bot.on("message", async msg => {
  cleanup();
  if (!msg.text?.trim() || msg.text.startsWith("/")) return;

  const cid = msg.chat.id;
  const uid = msg.from.id;
  const text = msg.text.trim();

  if (!isAdmin(uid)) return;

  // Постинг
  if (processed.has(`post_mode:${cid}`) && now() < processed.get(`post_mode:${cid}`)) {
    processed.delete(`post_mode:${cid}`);
    try {
      await bot.sendMessage(CHAT_ID, `📣 <b>${BOT_BRAND}</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
      await bot.sendMessage(cid, "✅ Запостил", mainKeyboard());
    } catch (e) {
      await bot.sendMessage(cid, "❌ Ошибка постинга", mainKeyboard());
    }
    return;
  }

  // Генерация
  const state = pending.get(cid);
  if (!state) return;

  if (state.stage === "wait_username") {
    if (!isValidUsername(text)) {
      return bot.sendMessage(cid, "❌ Некорректный @username. Попробуй ещё.");
    }
    const username = normalizeUsername(text);
    pending.set(cid, { stage: "wait_duration", username, createdAt: now() });
    await bot.sendMessage(cid, `Срок для ${escapeHtml(username)}:`, durationKeyboard());
  }
});

console.log("CYRAX BOT запущен");
