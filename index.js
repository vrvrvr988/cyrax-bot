/**
 * CYRAX CORE BOT — Render (Polling + Dummy HTTP)
 *
 * ENV (Render -> Environment):
 *  - BOT_TOKEN (обязательно)
 *  - ADMIN_ID  (обязательно) например 899914946
 *
 *  - PANEL_GENERATE_URL (полная ссылка генерации)
 *  - PANEL_API_KEY (если нужен)
 *  - PANEL_API_KEY_HEADER (по умолчанию Authorization)
 *  - PANEL_TIMEOUT_MS (по умолчанию 15000)
 *  - COOLDOWN_SECONDS (по умолчанию 15)
 *  - CHAT_ID (для постинга в чат, например -1003552668286)
 *  - BOT_BRAND (по умолчанию CYRAX CORE)
 */

const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// ---------- Render wants a port: dummy HTTP ----------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("CYRAX bot is running\n");
  })
  .listen(PORT, () => console.log(`🌐 HTTP alive on ${PORT}`));

// ---------- ENV ----------
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

// ---------- State (in-memory) ----------
const processedActionKeys = new Map(); // anti-duplicate for callbacks/messages
const userCooldown = new Map(); // userId -> lastTs
const keyHistory = [];
const HISTORY_LIMIT = 50;

let genInProgress = false;

// ---------- Helpers ----------
const now = () => Date.now();
const isAdmin = (id) => String(id) === ADMIN_ID;

function cleanupMaps() {
  const t = now();
  const TTL = 10 * 60 * 1000;
  for (const [k, v] of processedActionKeys) if (t - v > TTL) processedActionKeys.delete(k);

  const CDTTL = 60 * 60 * 1000;
  for (const [k, v] of userCooldown) if (t - v > CDTTL) userCooldown.delete(k);
}

function cooldownLeft(userId) {
  const last = userCooldown.get(String(userId)) || 0;
  const diff = Math.floor((now() - last) / 1000);
  const left = COOLDOWN_SECONDS - diff;
  return left > 0 ? left : 0;
}

function setCooldown(userId) {
  userCooldown.set(String(userId), now());
}

function pushHistory(item) {
  keyHistory.unshift(item);
  if (keyHistory.length > HISTORY_LIMIT) keyHistory.length = HISTORY_LIMIT;
}

function prettyTime(ts) {
  return new Date(ts).toLocaleString("ru-RU");
}

function looksLikeKey(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length < 6 || t.length > 200) return false;
  return /^[A-Za-z0-9\-_:.=+/]+$/.test(t);
}

function findKeyInObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  const direct = [
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

  for (const c of direct) {
    if (typeof c === "string" && looksLikeKey(c)) return c.trim();
  }

  if (Array.isArray(obj)) {
    for (const it of obj) {
      const f = findKeyInObject(it);
      if (f) return f;
    }
  }

  for (const v of Object.values(obj)) {
    if (typeof v === "string" && looksLikeKey(v)) return v.trim();
    if (typeof v === "object" && v) {
      const f = findKeyInObject(v);
      if (f) return f;
    }
  }

  return null;
}

async function callPanelGenerateKey() {
  if (!PANEL_GENERATE_URL) {
    return { ok: false, error: "PANEL_GENERATE_URL не задан (Render → Environment)." };
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
        ? res.data.slice(0, 250)
        : JSON.stringify(res.data).slice(0, 250);
    return { ok: false, error: `Панель вернула HTTP ${res.status}: ${body}` };
  }

  if (typeof res.data === "object" && res.data) {
    const key = findKeyInObject(res.data);
    if (key) return { ok: true, key };
    return { ok: false, error: "Панель вернула JSON, но ключ не найден.", raw: JSON.stringify(res.data).slice(0, 400) };
  }

  const text = String(res.data || "").trim();
  if (looksLikeKey(text)) return { ok: true, key: text };

  const match = text.match(/[A-Za-z0-9\-_:.=+/]{8,200}/);
  if (match && looksLikeKey(match[0])) return { ok: true, key: match[0] };

  return { ok: false, error: "Не распознал ключ в ответе панели.", raw: text.slice(0, 400) };
}

function menuKeyboard(admin) {
  const rows = [];
  if (admin) {
    rows.push([{ text: "⚡ Генерировать ключ", callback_data: "gen" }]);
    rows.push([{ text: "📜 История", callback_data: "history" }, { text: "🧹 Очистить", callback_data: "clear" }]);
    rows.push([{ text: "📣 Постинг", callback_data: "post" }, { text: "🧪 SELF TEST", callback_data: "selftest" }]);
  } else {
    rows.push([{ text: "ℹ️ Инфо", callback_data: "info" }]);
  }
  rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);

  return { reply_markup: { inline_keyboard: rows } };
}

function mainText(admin) {
  return (
    `🕶 <b>${BOT_BRAND}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    (admin ? `Роль: <b>ADMIN</b>\n` : `Доступ: <b>ограничен</b>\n`) +
    `Команды:\n` +
    `/start\n/ping\n/whoami\n` +
    (admin ? `/gen  (админ)\n/history (админ)\n/clear (админ)\n/post (админ)\n` : ``) +
    `━━━━━━━━━━━━━━\n` +
    `Жми кнопки ниже 👇`
  );
}

// ---------- BOT START (Polling) ----------
// ВАЖНО: если Telegram выдаёт 409 — это означает второй polling где-то ещё.
// Мы не "лечим" 409 кодом, но мы делаем поведение мягким: не спамим панель, не падаем навсегда.
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    params: { timeout: 30 },
  },
});

bot.on("polling_error", (err) => {
  // Чтобы не падал сервис, логируем и живём
  const msg = String(err?.message || err);
  console.error("polling_error:", msg);

  // Частая: 409 conflict
  // НЕ делаем тут restart бесконечно: Telegram всё равно не даст, пока второй экземпляр жив.
});

// ---------- Commands ----------
bot.onText(/\/start/, async (msg) => {
  cleanupMaps();
  const admin = isAdmin(msg.from?.id);
  await bot.sendMessage(msg.chat.id, mainText(admin), { parse_mode: "HTML", ...menuKeyboard(admin) });
});

bot.onText(/\/ping/, async (msg) => {
  cleanupMaps();
  await bot.sendMessage(msg.chat.id, "🏓 pong");
});

bot.onText(/\/whoami/, async (msg) => {
  cleanupMaps();
  await bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}\nadmin: ${isAdmin(msg.from?.id)}`);
});

bot.onText(/\/history/, async (msg) => {
  cleanupMaps();
  if (!isAdmin(msg.from?.id)) return bot.sendMessage(msg.chat.id, "⛔ Доступ ограничен. Напиши админу.");
  if (keyHistory.length === 0) return bot.sendMessage(msg.chat.id, "📜 История пуста.");

  const lines = keyHistory
    .slice(0, 15)
    .map((h, i) => `${i + 1}) <code>${h.key}</code>\n   🕒 ${prettyTime(h.ts)}`)
    .join("\n\n");

  await bot.sendMessage(msg.chat.id, `📜 <b>История</b>\n\n${lines}`, { parse_mode: "HTML", ...menuKeyboard(true) });
});

bot.onText(/\/clear/, async (msg) => {
  cleanupMaps();
  if (!isAdmin(msg.from?.id)) return bot.sendMessage(msg.chat.id, "⛔ Доступ ограничен.");
  keyHistory.length = 0;
  await bot.sendMessage(msg.chat.id, "🧹 История очищена.");
});

bot.onText(/\/post/, async (msg) => {
  cleanupMaps();
  if (!isAdmin(msg.from?.id)) return bot.sendMessage(msg.chat.id, "⛔ Доступ ограничен.");
  if (!CHAT_ID) return bot.sendMessage(msg.chat.id, "⚠️ CHAT_ID не задан в Render → Environment.");
  processedActionKeys.set(`await_post:${ADMIN_ID}`, now());
  await bot.sendMessage(msg.chat.id, "📣 Отправь следующее сообщение — я запощу его в чат (1 сообщение).");
});

async function doGenerate(chatId, userId, dedupeKey) {
  // антидубль по ключу действия
  if (processedActionKeys.has(dedupeKey)) {
    return bot.sendMessage(chatId, "🛡 Уже обработано (защита от дубля).");
  }
  processedActionKeys.set(dedupeKey, now());

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
      return bot.sendMessage(chatId, `❌ <b>Ошибка панели</b>\n${r.error}${extra}`, {
        parse_mode: "HTML",
        ...menuKeyboard(true),
      });
    }

    const key = String(r.key || "").trim();
    pushHistory({ key, ts: now() });

    return bot.sendMessage(
      chatId,
      `✅ <b>Ключ:</b>\n<code>${key}</code>\n\n🛡 1 нажатие = 1 ключ`,
      { parse_mode: "HTML", ...menuKeyboard(true) }
    );
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❗ Ошибка. Проверь логи Render.");
  } finally {
    genInProgress = false;
  }
}

bot.onText(/\/gen/, async (msg) => {
  cleanupMaps();
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  if (!isAdmin(userId)) return bot.sendMessage(chatId, "⛔ Доступ ограничен. Напиши админу.");

  // дедуп по message_id
  const key = `gen:msg:${chatId}:${msg.message_id}`;
  await doGenerate(chatId, userId, key);
});

// ---------- Buttons ----------
bot.on("callback_query", async (q) => {
  cleanupMaps();
  try { await bot.answerCallbackQuery(q.id); } catch {}

  const data = q.data || "";
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  if (!chatId) return;

  // дедуп по callback id
  const cbKey = `cb:${q.id}`;
  if (processedActionKeys.has(cbKey)) return;
  processedActionKeys.set(cbKey, now());

  const admin = isAdmin(userId);

  if (data === "menu") {
    return bot.sendMessage(chatId, mainText(admin), { parse_mode: "HTML", ...menuKeyboard(admin) });
  }

  if (data === "info") {
    return bot.sendMessage(chatId, `ℹ️ <b>${BOT_BRAND}</b>\nДоступ ограничен.\nНапиши админу.`, {
      parse_mode: "HTML",
      ...menuKeyboard(false),
    });
  }

  if (!admin) return bot.sendMessage(chatId, "⛔ Доступ ограничен. Напиши админу.");

  if (data === "history") {
    if (keyHistory.length === 0) return bot.sendMessage(chatId, "📜 История пуста.");
    const lines = keyHistory
      .slice(0, 15)
      .map((h, i) => `${i + 1}) <code>${h.key}</code>\n   🕒 ${prettyTime(h.ts)}`)
      .join("\n\n");
    return bot.sendMessage(chatId, `📜 <b>История</b>\n\n${lines}`, { parse_mode: "HTML", ...menuKeyboard(true) });
  }

  if (data === "clear") {
    keyHistory.length = 0;
    return bot.sendMessage(chatId, "🧹 История очищена.");
  }

  if (data === "selftest") {
    return bot.sendMessage(
      chatId,
      `🧪 <b>SELF TEST</b>\nBOT_TOKEN: ✅\nADMIN_ID: ✅\nPANEL_GENERATE_URL: ${PANEL_GENERATE_URL ? "✅" : "❌"}\nCHAT_ID: ${
        CHAT_ID ? "✅" : "❌"
      }\nCOOLDOWN_SECONDS: <b>${COOLDOWN_SECONDS}</b>`,
      { parse_mode: "HTML", ...menuKeyboard(true) }
    );
  }

  if (data === "post") {
    if (!CHAT_ID) return bot.sendMessage(chatId, "⚠️ CHAT_ID не задан в Render → Environment.");
    processedActionKeys.set(`await_post:${ADMIN_ID}`, now());
    return bot.sendMessage(chatId, "📣 Отправь следующее сообщение — я запощу его в чат (1 сообщение).");
  }

  if (data === "gen") {
    // дедуп по callback + message_id (двойной тап)
    const dedupe = `gen:cb:${chatId}:${q.message?.message_id || "m"}:${q.id}`;
    return doGenerate(chatId, userId, dedupe);
  }
});

// ---------- Await post handler ----------
bot.on("message", async (msg) => {
  cleanupMaps();
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();
  if (!text) return;
  if (text.startsWith("/")) return;

  const awaitKey = `await_post:${ADMIN_ID}`;
  if (isAdmin(userId) && processedActionKeys.has(awaitKey)) {
    processedActionKeys.delete(awaitKey);
    if (!CHAT_ID) return bot.sendMessage(msg.chat.id, "⚠️ CHAT_ID не задан.");

    try {
      await bot.sendMessage(CHAT_ID, `📣 <b>${BOT_BRAND}</b>\n\n${text}`, { parse_mode: "HTML" });
      await bot.sendMessage(msg.chat.id, "✅ Запостил в чат.");
    } catch (e) {
      console.error(e);
      await bot.sendMessage(msg.chat.id, "❌ Не смог запостить. Проверь, что бот добавлен в чат и может писать.");
    }
  }
});

console.log("✅ CYRAX bot started (polling)...");
