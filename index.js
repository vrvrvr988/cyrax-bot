/**
 * CYRAX Telegram Bot
 * Railway + polling (без webhook)
 *
 * ENV (Railway → Variables):
 * BOT_TOKEN
 * ADMIN_ID
 * PANEL_GENERATE_URL (можно добавить позже)
 */

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const PANEL_GENERATE_URL = process.env.PANEL_GENERATE_URL || "";
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS || "12");

if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");
if (!ADMIN_ID) throw new Error("ADMIN_ID not set");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let inProgress = false;
let lastGenAt = 0;

function isAdmin(chatId) {
  return String(chatId) === ADMIN_ID;
}

function cooldownLeft() {
  const diff = Math.floor((Date.now() - lastGenAt) / 1000);
  const left = COOLDOWN_SECONDS - diff;
  return left > 0 ? left : 0;
}

async function generateKey() {
  if (!PANEL_GENERATE_URL) {
    return { ok: false, error: "PANEL_GENERATE_URL не задан" };
  }

  const res = await axios.get(PANEL_GENERATE_URL, {
    timeout: 15000,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `HTTP ${res.status}` };
  }

  if (typeof res.data === "object" && res.data) {
    const k = res.data.key || res.data.license || res.data.token;
    if (k) return { ok: true, key: String(k) };
  }

  const text = String(res.data || "").trim();
  if (text.length > 3) return { ok: true, key: text };

  return { ok: false, error: "Не удалось распознать ключ" };
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  try {
    if (text === "/start") {
      bot.sendMessage(
        chatId,
        "🎮 CYRAX BOT\n\nКоманды:\n/start\n/ping\n/whoami\n/gen (админ)"
      );
      return;
    }

    if (text === "/ping") {
      bot.sendMessage(chatId, "🏓 pong");
      return;
    }

    if (text === "/whoami") {
      bot.sendMessage(
        chatId,
        `chat_id: ${chatId}\nadmin: ${isAdmin(chatId)}`
      );
      return;
    }

    if (text === "/gen") {
      if (!isAdmin(chatId)) {
        bot.sendMessage(chatId, "⛔ Доступ только админу");
        return;
      }

      const left = cooldownLeft();
      if (left > 0) {
        bot.sendMessage(chatId, `⏳ Подожди ${left} сек`);
        return;
      }

      if (inProgress) {
        bot.sendMessage(chatId, "⏳ Генерация уже идёт");
        return;
      }

      inProgress = true;
      lastGenAt = Date.now();

      try {
        const r = await generateKey();
        if (!r.ok) {
          bot.sendMessage(chatId, `❌ Ошибка: ${r.error}`);
          return;
        }
        bot.sendMessage(chatId, `✅ Ключ:\n\n🔑 ${r.key}`);
      } finally {
        inProgress = false;
      }
      return;
    }

    bot.sendMessage(chatId, "Напиши /start");
  } catch (e) {
    console.error(e);
  }
});

console.log("CYRAX bot started");
