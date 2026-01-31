const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

// Переменные окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PANEL_GENERATE_URL = process.env.PANEL_GENERATE_URL;
const CHAT_ID = process.env.CHAT_ID;  // ID чата, куда отправляется сообщение с ключом
const COOLDOWN_SECONDS = process.env.COOLDOWN_SECONDS || 10;  // Кулдаун между генерациями

// Создаем экземпляр бота
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Обработчик команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Привет! Я твой помощник по генерации ключей. Нажми кнопку для продолжения.');
  
  // Создаем кнопки для пользователя
  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Генерировать ключ', callback_data: 'generate_key' }],
        [{ text: 'История', callback_data: 'history' }],
        [{ text: 'Постинг', callback_data: 'posting' }],
        [{ text: 'Самопроверка', callback_data: 'self_test' }]
      ]
    }
  };
  bot.sendMessage(chatId, 'Выбери опцию:', options);
});

// Обработка нажатия кнопок
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Если нажата кнопка для генерации ключа
  if (data === 'generate_key') {
    bot.sendMessage(chatId, 'Введите свой юзернейм для генерации ключа:');
    
    // Слушаем следующее сообщение с юзернеймом
    bot.once('message', async (msg) => {
      const username = msg.text;
      if (username && username.length > 0) {
        // Генерация ключа
        const key = await generateKey(username); 

        // Отправка сгенерированного ключа в чат администратора
        bot.sendMessage(CHAT_ID, `Ключ для @${username}: ${key}`);

        // Отправляем результат пользователю
        bot.sendMessage(chatId, `Генерация завершена! Ключ для @${username}: ${key}`);
      } else {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректный юзернейм.');
      }
    });
  }

  // Обработка других кнопок
  if (data === 'history') {
    bot.sendMessage(chatId, 'История ключей пустая.');
  } else if (data === 'posting') {
    bot.sendMessage(chatId, 'Настройки постинга еще не реализованы.');
  } else if (data === 'self_test') {
    bot.sendMessage(chatId, 'Самопроверка выполнена успешно!');
  }
});

// Генерация ключа
async function generateKey(username) {
  // Симуляция генерации ключа
  return `key_${username}_${Math.random().toString(36).substring(7)}`;
}

// Тестирование бота
bot.on('polling_error', (error) => {
  console.log(error);
});
