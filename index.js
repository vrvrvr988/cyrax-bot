/**
 * CYRAX CORE BOT — Render (Polling) + Generate-to-Chat flow
 *
 * Flow:
 *  Admin clicks "⚡ Генерировать" -> bot asks @username -> generates exactly 1 key -> posts to CHAT_ID:
 *    "🔑 Ключ для @durov: KEY"
 *  Admin receives confirmation in DM, key is NOT shown in DM (only in chat).
 *
 * ENV (Render -> Environment):
 *  - BOT_TOKEN (required)
 *  - ADMIN_ID  (required) e.g. 899914946
 *  - PANEL_GENERATE_URL_1D (required) for 1-day key generation
 *  - PANEL_GENERATE_URL_3D (required) for 3-day key generation
 *  - PANEL_GENERATE_URL_7D (required) for 7-day key generation
 *  - CHAT_ID (required) e.g. -1003552668286
 *
 * Optional:
 *  - PANEL_API_KEY
 *  - PANEL_API_KEY_HEADER (default Authorization)
 *  - PANEL_TIMEOUT_MS (default 15000)
 *  - COOLDOWN_SECONDS (default 15)
 *  - BOT_BRAND (default CYRAX CORE)
 */

const http = require("http");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Dummy HTTP server for Render
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("CYRAX bot is running\n");
  })
  .listen(PORT, () => console.log(`🌐 HTTP alive on ${PORT}`));

// ENV (environment variables)
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const PANEL_GENERATE_URL_1D = process.env.PANEL_GENERATE_URL_1D || "https://panel.cyrax.info/generateKey/1d";
const PANEL_GENERATE_URL_3D = process.env.PANEL_GENERATE_URL_3D || "https://panel.cyrax.info/generateKey/3d";
const PANEL_GENERATE_URL_7D = process.env.PANEL_GENERATE_URL_7D || "https://panel.cyrax.info/generateKey/7d";
const CHAT_ID = process.env.CHAT_ID ? String(process.env.CHAT_ID) : "";

const PANEL_API_KEY = process.env.PANEL_API_KEY || "";
const PANEL_API_KEY_HEADER = process.env.PANEL_API_KEY_HEADER || "Authorization";
const PANEL_TIMEOUT_MS = Number(process.env.PANEL_TIMEOUT_MS || "15000");
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "15");
const BOT_BRAND = process.env.BOT_BRAND || "CYRAX CORE";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");
if (!ADMIN_ID) throw new Error("ADMIN_ID not set");
if (!PANEL_GENERATE_URL_1D) throw new Error("PANEL_GENERATE_URL_1D not set");
if (!PANEL_GENERATE_URL_3D) throw new Error("PANEL_GENERATE_URL_3D not set");
if (!PANEL_GENERATE_URL_7D) throw new Error("PANEL_GENERATE_URL_7D not set");
if (!CHAT_ID) throw new Error("CHAT_ID not set");

// Helpers
const now = () => Date.now();
const isAdmin = (id) => String(id) === ADMIN_ID;

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isValidUsernameInput(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  const clean = t.startsWith("@") ? t.slice(1) : t;
  if (clean.length < 3 || clean.length > 32) return false;
  return /^[A-Za-z0-9_]+$/.test(clean);
}

function normalizeUsername(s) {
  const t = String(s || "").trim();
  const clean = t.startsWith("@") ? t.slice(1) : t;
  return "@" + clean;
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

async function callPanelGenerateKey(url) {
  const headers = {};
  if (PANEL_API_KEY) headers[PANEL_API_KEY_HEADER] = PANEL_API_KEY;

  const res = await axios.get(url, {
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
    return { ok: false, error: "Панель вернула JSON, но ключ не найден." };
  }

  const text = String(res.data || "").trim();
  if (looksLikeKey(text)) return { ok: true, key: text };

  const match = text.match(/[A-Za-z0-9\-_:.=+/]{8,200}/);
  if (match && looksLikeKey(match[0])) return { ok: true, key: match[0] };

  return { ok: false, error: "Не распознал ключ в ответе панели." };
}

// Anti-duplication / state management
const processed = new Map();
const userCooldown = new Map();
let genInProgress = false;
const pendingUsername = new Map();

function cleanup() {
  const t = now();
  const TTL = 10 * 60 * 1000;

  for (const [k, v] of processed) if (t - v > TTL) processed.delete(k);

  const CDTTL = 60 * 60 * 1000;
  for (const [k, v] of userCooldown) if (t - v > CDTTL) userCooldown.delete(k);

  for (const [k, v] of pendingUsername) {
    if (t - v.createdAt > 5 * 60 * 1000) pendingUsername.delete(k);
  }
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

// UI Keyboard
function menuKeyboard(admin) {
  const rows = [];
  if (admin) {
    rows.push([{ text: "⚡ Генерировать", callback_data: "gen" }, { text: "🧪 SELF TEST", callback_data: "selftest" }]);
    rows.push([{ text: "📣 Постинг", callback_data: "post" }, { text: "🏠 Меню", callback_data: "menu" }]);
  } else {
    rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function mainText(admin, chatId) {
  return (
    `🕶 <b>${BOT_BRAND}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    (admin ? `Роль: <b>ADMIN</b>\n` : `Доступ: <b>ограничен</b>\n`) +
    `Ваш chat_id: <code>${chatId}</code>\n` +
    `Команды: /start /ping /whoami` +
    (admin ? ` /gen` : "") +
    `\n━━━━━━━━━━━━━━\n` +
    `Жми кнопки ниже 👇`
  );
}

// Bot Setup
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { autoStart: true, params: { timeout: 30 } },
});

bot.on("polling_error", (err) => {
  console.error("polling_error:", String(err?.message || err));
});

// Actions
async function generateForUsername(adminChatId, adminUserId, username, dedupeKey, duration) {
  if (processed.has(dedupeKey)) {
    return bot.sendMessage(adminChatId, "🛡 Уже обработано (защита от дубля).");
  }
  processed.set(dedupeKey, now());

  const left = cooldownLeft(adminUserId);
  if (left > 0) return bot.sendMessage(adminChatId, `⏳ Подожди ${left} сек.`);

  if (genInProgress) return bot.sendMessage(adminChatId, "⏳ Генерация уже идёт. Подожди пару секунд.");

  genInProgress = true;
  setCooldown(adminUserId);

  try {
    await bot.sendMessage(adminChatId, `⚡ Генерирую ключ для <b>${escapeHtml(username)}</b>...`, { parse_mode: "HTML" });

    let generateUrl;
    if (duration === "1d") {
      generateUrl = PANEL_GENERATE_URL_1D;
    } else if (duration === "3d") {
      generateUrl = PANEL_GENERATE_URL_3D;
    } else if (duration === "7d") {
      generateUrl = PANEL_GENERATE_URL_7D;
    }

    const r = await callPanelGenerateKey(generateUrl);
    if (!r.ok) {
      return bot.sendMessage(adminChatId, `❌ <b>Ошибка панели</b>\n${escapeHtml(r.error)}`, {
        parse_mode: "HTML",
        ...menuKeyboard(true),
      });
    }

    const key = String(r.key || "").trim();

    // Send to the chat (money protection)
    const chatMsg =
      `🔑 <b>Ключ для ${escapeHtml(username)}</b>\n` +
      `<code>${escapeHtml(key)}</code>\n` +
      `━━━━━━━━━━━━━━\n` +
      `Админ: <code>@${escapeHtml(adminUserId)}</code>`;

    await bot.sendMessage(CHAT_ID, chatMsg, { parse_mode: "HTML" });

    // Confirm to admin
    return bot.sendMessage(adminChatId, "✅ Готово. Отправил ключ в чат.", { ...menuKeyboard(true) });
  } catch (e) {
    console.error("generate error:", e?.message || e);
    return bot.sendMessage(adminChatId, "❗ Ошибка. Проверь логи Render.", { ...menuKeyboard(true) });
  } finally {
    genInProgress = false;
  }
}

// Commands Handling
bot.onText(/\/start/, async (msg) => {
  cleanup();
  const admin = isAdmin(msg.from?.id);
  await bot.sendMessage(msg.chat.id, mainText(admin, msg.chat.id), { parse_mode: "HTML", ...menuKeyboard(admin) });
});

bot.onText(/\/ping/, async (msg) => {
  cleanup();
  await bot.sendMessage(msg.chat.id, "🏓 pong");
});

bot.onText(/\/whoami/, async (msg) => {
  cleanup();
  await bot.sendMessage(msg.chat.id, `chat_id: ${msg.chat.id}\nadmin: ${isAdmin(msg.from?.id)}`);
});

// /gen -> Asks username and duration
bot.onText(/\/gen/, async (msg) => {
  cleanup();
  if (!isAdmin(msg.from?.id)) return bot.sendMessage(msg.chat.id, "⛔ Доступ ограничен. Напиши админу.");

  const reqId = `req:${msg.chat.id}:${msg.message_id}:${now()}`;
  pendingUsername.set(String(msg.chat.id), { reqId, createdAt: now() });

  await bot.sendMessage(
    msg.chat.id,
    "👤 Для кого ключ?\nНапиши юзернейм одним сообщением:\n<code>@durov</code>",
    { parse_mode: "HTML", ...menuKeyboard(true) }
  );
});

bot.on("callback_query", async (q) => {
  cleanup();
  try { await bot.answerCallbackQuery(q.id); } catch {}

  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  if (!chatId) return;

  const admin = isAdmin(userId);

  // dedupe callback itself
  const cbKey = `cb:${q.id}`;
  if (processed.has(cbKey)) return;
  processed.set(cbKey, now());

  if (q.data === "menu") {
    return bot.sendMessage(chatId, mainText(admin, chatId), { parse_mode: "HTML", ...menuKeyboard(admin) });
  }

  if (!admin) return bot.sendMessage(chatId, "⛔ Доступ ограничен. Напиши админу.");

  if (q.data === "selftest") {
    return bot.sendMessage(
      chatId,
      `🧪 <b>SELF TEST</b>\n` +
        `BOT_TOKEN: ✅\n` +
        `ADMIN_ID: ✅\n` +
        `PANEL_GENERATE_URL_1D: ${PANEL_GENERATE_URL_1D ? "✅" : "❌"}\n` +
        `PANEL_GENERATE_URL_3D: ${PANEL_GENERATE_URL_3D ? "✅" : "❌"}\n` +
        `PANEL_GENERATE_URL_7D: ${PANEL_GENERATE_URL_7D ? "✅" : "❌"}\n` +
        `CHAT_ID: ${CHAT_ID ? "✅" : "❌"}\n` +
        `COOLDOWN_SECONDS: <b>${COOLDOWN_SECONDS}</b>\n` +
        `genInProgress: <b>${genInProgress ? "YES" : "NO"}</b>`,
      { parse_mode: "HTML", ...menuKeyboard(true) }
    );
  }

  if (q.data === "post") {
    // simple post flow: next message will be posted to CHAT_ID
    pendingUsername.delete(String(chatId));
    processed.set(`await_post:${chatId}`, now());
    processed.set(`await_post_ttl:${chatId}`, now() + 5 * 60 * 1000);
    return bot.sendMessage(chatId, "📣 Отправь следующее сообщение — я запощу его в чат (1 сообщение).", { ...menuKeyboard(true) });
  }

  if (q.data === "gen") {
    const reqId = `req:${chatId}:${q.message?.message_id || "m"}:${q.id}:${now()}`;
    pendingUsername.set(String(chatId), { reqId, createdAt: now() });
    return bot.sendMessage(
      chatId,
      "👤 Для кого ключ?\nНапиши юзернейм одним сообщением:\n<code>@durov</code>",
      { parse_mode: "HTML", ...menuKeyboard(true) }
    );
  }
});

bot.on("message", async (msg) => {
  cleanup();

  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();
  if (!chatId || !userId || !text) return;

  // ignore commands
  if (text.startsWith("/")) return;

  // POST flow TTL
  const ttl = processed.get(`await_post_ttl:${chatId}`) || 0;
  if (processed.has(`await_post:${chatId}`)) {
    if (ttl && now() > ttl) {
      processed.delete(`await_post:${chatId}`);
      processed.delete(`await_post_ttl:${chatId}`);
      return bot.sendMessage(chatId, "⏳ Режим постинга истёк. Нажми 📣 Постинг ещё раз.", { ...menuKeyboard(isAdmin(userId)) });
    }

    if (!isAdmin(userId)) return; // only admin can use it
    processed.delete(`await_post:${chatId}`);
    processed.delete(`await_post_ttl:${chatId}`);

    try {
      await bot.sendMessage(CHAT_ID, `📣 <b>${BOT_BRAND}</b>\n\n${escapeHtml(text)}`, { parse_mode: "HTML" });
      return bot.sendMessage(chatId, "✅ Запостил в чат.", { ...menuKeyboard(true) });
    } catch (e) {
      console.error("post error:", e?.message || e);
      return bot.sendMessage(chatId, "❌ Не смог запостить. Проверь, что бот добавлен в чат и может писать.", { ...menuKeyboard(true) });
    }
  }

  // GENERATE username flow
  if (isAdmin(userId) && pendingUsername.has(String(chatId))) {
    const pending = pendingUsername.get(String(chatId));

    // clear pending BEFORE calling panel (so repeated telegram retries won't cause regen)
    pendingUsername.delete(String(chatId));

    if (!isValidUsernameInput(text)) {
      const reqId = `req:${chatId}:${msg.message_id}:${now()}`;
      pendingUsername.set(String(chatId), { reqId
