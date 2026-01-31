const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const express = require('express');

// Загрузка переменных среды
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const ADMIN_ID = process.env.ADMIN_ID;
const COOLDOWN_SECONDS = process.env.COOLDOWN_SECONDS || 10;
const PANEL_GENERATE_URL = process.env.PANEL_GENERATE_URL;

// Создаем объект бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Вспомогательные переменные для отслеживания времени генерации ключа
let lastGenerated = 0;

// Основные команды
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Привет! Напиши /gen для генерации ключа.');
});

bot.onText(/\/ping/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Pong!');
});

// Генерация ключа
bot.onText(/\/gen/, (msg) => {
  const now = Date.now();
  if (now - lastGenerated < COOLDOWN_SECONDS * 1000) {
    bot.sendMessage(msg.chat.id, 'Подождите немного, попробуйте снова!');
    return;
  }

  lastGenerated = now;

  // Запросить у пользователя юзернейм бота
  bot.sendMessage(msg.chat.id, 'Введите имя бота (например, @durov):').then(() => {
    bot.on('message', (msg) => {
      if (msg.chat.id === CHAT_ID && msg.text) {
        const userName = msg.text;

        // Генерация ключа
        const key = generateKey();

        // Проверяем, был ли уже сгенерирован ключ для этого пользователя
        if (checkIfKeyGenerated(userName)) {
          bot.sendMessage(msg.chat.id, 'Ключ уже был сгенерирован для этого пользователя.');
          return;
        }

        // Отправляем ключ в чат
        const keyMessage = `Ключ для ${userName}: ${key}`;
        bot.sendMessage(CHAT_ID, keyMessage);

        // Запись сгенерированного ключа
        logGeneratedKey(userName, key);

        bot.sendMessage(msg.chat.id, `Ключ для ${userName} успешно сгенерирован.`);
      }
    });
  });
});

function generateKey() {
  // Генерация случайного ключа
  return 'key_' + Math.random().toString(36).substring(2, 15);
}

function checkIfKeyGenerated(userName) {
  // Проверка, был ли уже сгенерирован ключ для этого пользователя
  // Реализуй хранилище данных для этого (например, файл, БД и т.д.)
  // Для демонстрации возвращаем false (не было генерации)
  return false;
}

function logGeneratedKey(userName, key) {
  // Логирование сгенерированного ключа
  // Реализуй хранилище данных для этого (например, файл, БД и т.д.)
  console.log(`Сгенерирован ключ для пользователя ${userName}: ${key}`);
}

bot.onText(/\/whoami/, (msg) => {
  if (msg.chat.id === ADMIN_ID) {
    bot.sendMessage(msg.chat.id, `Ваш ID: ${msg.chat.id}`);
  } else {
    bot.sendMessage(msg.chat.id, 'Вы не администратор!');
  }
});

// API для получения сгенерированных ключей (если нужно)
const app = express();

app.get('/keys', (req, res) => {
  // Выводим ключи в формате JSON (реализовать с хранилищем)
  res.json({ message: 'keys will be shown here' });
});

app.listen(3000, () => {
  console.log('API сервер запущен на порту 3000');
});
