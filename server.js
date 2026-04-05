const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Хранилище данных
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadData(filename) {
    const filepath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath));
    return {};
}

function saveData(filename, data) {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

let botAccounts = loadData('accounts.json');
let botCommands = loadData('commands.json');
let botProfiles = loadData('profiles.json');
let botStats = loadData('stats.json');

function saveAll() {
    saveData('accounts.json', botAccounts);
    saveData('commands.json', botCommands);
    saveData('profiles.json', botProfiles);
    saveData('stats.json', botStats);
}

// Регистрация webhook
async function registerWebhook(botToken, botId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://${process.env.RENDER_SERVICE_NAME || 'localhost'}.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId}: ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// Обработка сообщений от Telegram
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    const accountEntry = Object.entries(botAccounts).find(([_, a]) => a.token === token);
    
    if (!accountEntry) return res.sendStatus(404);
    
    const [accountId, account] = accountEntry;
    const update = req.body;
    res.sendStatus(200);
    
    try {
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text) text = "📎 Медиа";
            
            // Сохраняем статистику
            const chatKey = `${accountId}_${chatId}`;
            if (!botStats[chatKey]) {
                botStats[chatKey] = { chatId, userName, messages: [], lastTime: new Date().toISOString() };
            }
            botStats[chatKey].messages.push({ text, type: 'incoming', time: new Date().toISOString() });
            botStats[chatKey].lastTime = new Date().toISOString();
            saveAll();
            
            // Обработка команд
            if (text && text.startsWith('/')) {
                const commands = botCommands[accountId] || [];
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { 
                        user: userName, 
                        user_id: userId, 
                        date: new Date().toLocaleDateString(),
                        time: new Date().toLocaleTimeString()
                    };
                    for (let [k, v] of Object.entries(vars)) {
                        response = response.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
                    }
                    
                    let replyMarkup = null;
                    if (command.buttons && command.buttons.length) {
                        const inlineKeyboard = command.buttons.map(btn => [{
                            text: btn.text,
                            [btn.type === 'url' ? 'url' : 'callback_data']: btn.data
                        }]);
                        replyMarkup = { inline_keyboard: inlineKeyboard };
                    }
                    
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: response,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                    
                    botStats[chatKey].messages.push({ text: response, type: 'outgoing', time: new Date().toISOString() });
                    saveAll();
                } else if (text === '/start' && botProfiles[accountId]?.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: botProfiles[accountId].greeting
                    });
                }
            }
        }
        
        if (update.callback_query) {
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                callback_query_id: update.callback_query.id,
                text: "✅ Готово!"
            });
        }
    } catch (e) {
        console.error('Handler error:', e.message);
    }
});

// ============= API для веб-интерфейса =============
app.get('/api/accounts', (req, res) => res.json(botAccounts));
app.get('/api/commands/:accountId', (req, res) => res.json(botCommands[req.params.accountId] || []));
app.get('/api/profile/:accountId', (req, res) => res.json(botProfiles[req.params.accountId] || {}));
app.get('/api/chats/:accountId', (req, res) => {
    const chats = Object.entries(botStats)
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/accounts', (req, res) => {
    const { id, token, name } = req.body;
    botAccounts[id] = { id, token, name };
    saveAll();
    if (token) registerWebhook(token, id);
    res.json({ success: true });
});

app.delete('/api/accounts/:id', (req, res) => {
    delete botAccounts[req.params.id];
    saveAll();
    res.json({ success: true });
});

app.post('/api/commands/:accountId', (req, res) => {
    botCommands[req.params.accountId] = req.body;
    saveAll();
    res.json({ success: true });
});

app.post('/api/profile/:accountId', (req, res) => {
    botProfiles[req.params.accountId] = req.body;
    saveAll();
    res.json({ success: true });
});

app.delete('/api/chat/:chatKey', (req, res) => {
    delete botStats[req.params.chatKey];
    saveAll();
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    setTimeout(() => {
        Object.values(botAccounts).forEach(acc => {
            if (acc.token) registerWebhook(acc.token, acc.id);
        });
    }, 2000);
});
