const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ============= ОСНОВНЫЕ ФУНКЦИИ =============
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE));
    return {};
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function loadUserData(userId) {
    const filepath = path.join(DATA_DIR, `user_${userId}.json`);
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath));
    return { accounts: {}, commands: {}, profiles: {}, stats: {} };
}

function saveUserData(userId, data) {
    fs.writeFileSync(path.join(DATA_DIR, `user_${userId}.json`), JSON.stringify(data, null, 2));
}

// ============= API АВТОРИЗАЦИИ =============
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    
    res.json({ success: true, message: 'Регистрация успешна' });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    const user = users[login];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });
});

app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============= MIDDLEWARE =============
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

// ============= WEBHOOK РЕГИСТРАЦИЯ =============
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// ============= ОБРАБОТКА СООБЩЕНИЙ TELEGRAM =============
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(filePath));
                    const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                    if (entry) {
                        foundUserId = userId;
                        foundAccountId = entry[0];
                        break;
                    }
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            }
        }
    }
    
    if (!foundUserId) return res.sendStatus(404);
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { chatId, userName, messages: [], lastTime: new Date().toISOString() };
            }
            userData.stats[chatKey].messages.push({ text, type: 'incoming', time: new Date().toISOString() });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { user: userName, user_id: userId, date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString() };
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
                    
                    userData.stats[chatKey].messages.push({ text: response, type: 'outgoing', time: new Date().toISOString() });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting
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

// ============= ДОПОЛНИТЕЛЬНЫЕ API =============
app.get('/api/user/stats', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const stats = {
        totalChats: Object.keys(userData.stats || {}).length,
        totalMessages: Object.values(userData.stats || {}).reduce((sum, chat) => sum + chat.messages.length, 0),
        accounts: Object.keys(userData.accounts || {}).length,
        commands: Object.values(userData.commands || {}).reduce((sum, cmds) => sum + cmds.length, 0)
    };
    res.json(stats);
});

app.get('/api/user/export', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData);
});

app.delete('/api/user/data', authMiddleware, (req, res) => {
    saveUserData(req.userId, { accounts: {}, commands: {}, profiles: {}, stats: {} });
    res.json({ success: true, message: 'Все данные очищены' });
});

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Директория данных: ${DATA_DIR}`);
    
    setTimeout(() => {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
            files.forEach(file => {
                const userId = file.replace('user_', '').replace('.json', '');
                try {
                    const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
                    Object.entries(userData.accounts || {}).forEach(([id, account]) => {
                        if (account.token) {
                            registerWebhook(account.token, id, userId);
                        }
                    });
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            });
        }
    }, 2000);
});}

function saveUserData(userId, data) {
    fs.writeFileSync(path.join(DATA_DIR, `user_${userId}.json`), JSON.stringify(data, null, 2));
}

// ============= API АВТОРИЗАЦИИ =============
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    
    res.json({ success: true, message: 'Регистрация успешна' });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    const user = users[login];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });
});

app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============= MIDDLEWARE =============
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    if (!userData.commands[req.params.accountId]) userData.commands[req.params.accountId] = [];
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.get('/api/user/stats', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const stats = {
        totalChats: Object.keys(userData.stats || {}).length,
        totalMessages: Object.values(userData.stats || {}).reduce((sum, chat) => sum + chat.messages.length, 0),
        accounts: Object.keys(userData.accounts || {}).length,
        commands: Object.values(userData.commands || {}).reduce((sum, cmds) => sum + cmds.length, 0)
    };
    res.json(stats);
});

app.get('/api/user/export', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData);
});

app.delete('/api/user/data', authMiddleware, (req, res) => {
    saveUserData(req.userId, { accounts: {}, commands: {}, profiles: {}, stats: {} });
    res.json({ success: true, message: 'Все данные очищены' });
});

// ============= WEBHOOK РЕГИСТРАЦИЯ =============
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// ============= ОБРАБОТКА СООБЩЕНИЙ TELEGRAM =============
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(filePath));
                    const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                    if (entry) {
                        foundUserId = userId;
                        foundAccountId = entry[0];
                        break;
                    }
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            }
        }
    }
    
    if (!foundUserId) {
        console.log(`❌ Бот с токеном ${token} не найден`);
        return res.sendStatus(404);
    }
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text && msg.video) text = "🎥 Видео";
            else if (!text && msg.audio) text = "🎵 Аудио";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { 
                    chatId, 
                    userName, 
                    messages: [], 
                    lastTime: new Date().toISOString(),
                    firstSeen: new Date().toISOString()
                };
            }
            
            userData.stats[chatKey].messages.push({ 
                text, 
                type: 'incoming', 
                time: new Date().toISOString(),
                userId: userId
            });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { 
                        user: userName, 
                        user_id: userId, 
                        date: new Date().toLocaleDateString(), 
                        time: new Date().toLocaleTimeString(),
                        chat_id: chatId
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
                    
                    userData.stats[chatKey].messages.push({ 
                        text: response, 
                        type: 'outgoing', 
                        time: new Date().toISOString() 
                    });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting,
                        parse_mode: 'HTML'
                    });
                } else if (text === '/help' && profile.helpText) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.helpText,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;
            
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: "✅ Готово!"
            });
            
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: `🔘 Вы нажали кнопку: ${data}`,
                parse_mode: 'HTML'
            });
        }
        
        if (update.my_chat_member) {
            const status = update.my_chat_member.new_chat_member.status;
            const chat = update.my_chat_member.chat;
            if (status === 'member' || status === 'administrator') {
                console.log(`✅ Бот добавлен в чат: ${chat.title || chat.id}`);
                if (profile.welcomeMessage) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chat.id,
                        text: profile.welcomeMessage,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
    } catch (e) {
        console.error('Handler error:', e.message);
        if (e.response) {
            console.error('Telegram API error:', e.response.data);
        }
    }
});

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Директория данных: ${DATA_DIR}`);
    console.log(`🔗 Внешний URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
    
    setTimeout(() => {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
            files.forEach(file => {
                const userId = file.replace('user_', '').replace('.json', '');
                try {
                    const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
                    Object.entries(userData.accounts || {}).forEach(([id, account]) => {
                        if (account.token) {
                            registerWebhook(account.token, id, userId);
                        }
                    });
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            });
        }
    }, 2000);
});}

function saveUserData(userId, data) {
    fs.writeFileSync(path.join(DATA_DIR, `user_${userId}.json`), JSON.stringify(data, null, 2));
}

// ============= API АВТОРИЗАЦИИ =============
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    
    res.json({ success: true, message: 'Регистрация успешна' });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    const user = users[login];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });
});

app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============= MIDDLEWARE =============
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

// ============= WEBHOOK РЕГИСТРАЦИЯ =============
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// ============= ОБРАБОТКА СООБЩЕНИЙ TELEGRAM =============
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(filePath));
                    const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                    if (entry) {
                        foundUserId = userId;
                        foundAccountId = entry[0];
                        break;
                    }
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            }
        }
    }
    
    if (!foundUserId) return res.sendStatus(404);
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { chatId, userName, messages: [], lastTime: new Date().toISOString() };
            }
            userData.stats[chatKey].messages.push({ text, type: 'incoming', time: new Date().toISOString() });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { user: userName, user_id: userId, date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString() };
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
                    
                    userData.stats[chatKey].messages.push({ text: response, type: 'outgoing', time: new Date().toISOString() });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting
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

// ============= ДОПОЛНИТЕЛЬНЫЕ API =============
app.get('/api/user/stats', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const stats = {
        totalChats: Object.keys(userData.stats || {}).length,
        totalMessages: Object.values(userData.stats || {}).reduce((sum, chat) => sum + chat.messages.length, 0),
        accounts: Object.keys(userData.accounts || {}).length,
        commands: Object.values(userData.commands || {}).reduce((sum, cmds) => sum + cmds.length, 0)
    };
    res.json(stats);
});

app.get('/api/user/export', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData);
});

app.delete('/api/user/data', authMiddleware, (req, res) => {
    saveUserData(req.userId, { accounts: {}, commands: {}, profiles: {}, stats: {} });
    res.json({ success: true, message: 'Все данные очищены' });
});

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Директория данных: ${DATA_DIR}`);
    
    // Автоматическая регистрация webhook для всех ботов
    setTimeout(() => {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
            files.forEach(file => {
                const userId = file.replace('user_', '').replace('.json', '');
                try {
                    const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
                    Object.entries(userData.accounts || {}).forEach(([id, account]) => {
                        if (account.token) {
                            registerWebhook(account.token, id, userId);
                        }
                    });
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            });
        }
    }, 2000);
});
// КОНЕЦ ФАЙЛА — НИЧЕГО ЛИШНЕГО НЕ ДОБАВЛЯТЬ}

function saveUserData(userId, data) {
    fs.writeFileSync(path.join(DATA_DIR, `user_${userId}.json`), JSON.stringify(data, null, 2));
}

// ============= API АВТОРИЗАЦИИ =============
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    
    res.json({ success: true, message: 'Регистрация успешна' });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    const user = users[login];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });
});

app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============= MIDDLEWARE =============
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    if (!userData.commands[req.params.accountId]) userData.commands[req.params.accountId] = [];
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

// ============= WEBHOOK РЕГИСТРАЦИЯ =============
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// ============= ОБРАБОТКА СООБЩЕНИЙ TELEGRAM =============
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(filePath));
                    const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                    if (entry) {
                        foundUserId = userId;
                        foundAccountId = entry[0];
                        break;
                    }
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            }
        }
    }
    
    if (!foundUserId) {
        console.log(`❌ Бот с токеном ${token} не найден`);
        return res.sendStatus(404);
    }
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text && msg.video) text = "🎥 Видео";
            else if (!text && msg.audio) text = "🎵 Аудио";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { 
                    chatId, 
                    userName, 
                    messages: [], 
                    lastTime: new Date().toISOString(),
                    firstSeen: new Date().toISOString()
                };
            }
            
            userData.stats[chatKey].messages.push({ 
                text, 
                type: 'incoming', 
                time: new Date().toISOString(),
                userId: userId
            });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            // Обработка команд
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { 
                        user: userName, 
                        user_id: userId, 
                        date: new Date().toLocaleDateString(), 
                        time: new Date().toLocaleTimeString(),
                        chat_id: chatId
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
                    
                    userData.stats[chatKey].messages.push({ 
                        text: response, 
                        type: 'outgoing', 
                        time: new Date().toISOString() 
                    });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting,
                        parse_mode: 'HTML'
                    });
                } else if (text === '/help' && profile.helpText) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.helpText,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
        // Обработка callback запросов от кнопок
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;
            
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: "✅ Готово!"
            });
            
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: `🔘 Вы нажали кнопку: ${data}`,
                parse_mode: 'HTML'
            });
        }
        
        // Обработка добавления бота в группу
        if (update.my_chat_member) {
            const status = update.my_chat_member.new_chat_member.status;
            const chat = update.my_chat_member.chat;
            if (status === 'member' || status === 'administrator') {
                console.log(`✅ Бот добавлен в чат: ${chat.title || chat.id}`);
                if (profile.welcomeMessage) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chat.id,
                        text: profile.welcomeMessage,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
    } catch (e) {
        console.error('Handler error:', e.message);
        if (e.response) {
            console.error('Telegram API error:', e.response.data);
        }
    }
});

// ============= ДОПОЛНИТЕЛЬНЫЕ API =============
app.get('/api/user/stats', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const stats = {
        totalChats: Object.keys(userData.stats || {}).length,
        totalMessages: Object.values(userData.stats || {}).reduce((sum, chat) => sum + chat.messages.length, 0),
        accounts: Object.keys(userData.accounts || {}).length,
        commands: Object.values(userData.commands || {}).reduce((sum, cmds) => sum + cmds.length, 0)
    };
    res.json(stats);
});

app.get('/api/user/export', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData);
});

app.delete('/api/user/data', authMiddleware, (req, res) => {
    saveUserData(req.userId, { accounts: {}, commands: {}, profiles: {}, stats: {} });
    res.json({ success: true, message: 'Все данные очищены' });
});

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Директория данных: ${DATA_DIR}`);
    console.log(`🔗 Внешний URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
    
    setTimeout(() => {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
            files.forEach(file => {
                const userId = file.replace('user_', '').replace('.json', '');
                try {
                    const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
                    Object.entries(userData.accounts || {}).forEach(([id, account]) => {
                        if (account.token) {
                            registerWebhook(account.token, id, userId);
                        }
                    });
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            });
        }
    }, 2000);
});function loadUserData(userId) {
    const filepath = path.join(DATA_DIR, `user_${userId}.json`);
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath));
    return { accounts: {}, commands: {}, profiles: {}, stats: {} };
}

function saveUserData(userId, data) {
    fs.writeFileSync(path.join(DATA_DIR, `user_${userId}.json`), JSON.stringify(data, null, 2));
}

// ============= API АВТОРИЗАЦИИ =============
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    
    res.json({ success: true, message: 'Регистрация успешна' });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    const user = users[login];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });
});

app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============= MIDDLEWARE =============
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    if (!userData.commands[req.params.accountId]) userData.commands[req.params.accountId] = [];
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

// ============= WEBHOOK РЕГИСТРАЦИЯ =============
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// ============= ОБРАБОТКА СООБЩЕНИЙ TELEGRAM =============
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(filePath));
                    const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                    if (entry) {
                        foundUserId = userId;
                        foundAccountId = entry[0];
                        break;
                    }
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            }
        }
    }
    
    if (!foundUserId) {
        console.log(`❌ Бот с токеном ${token} не найден`);
        return res.sendStatus(404);
    }
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text && msg.video) text = "🎥 Видео";
            else if (!text && msg.audio) text = "🎵 Аудио";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { 
                    chatId, 
                    userName, 
                    messages: [], 
                    lastTime: new Date().toISOString(),
                    firstSeen: new Date().toISOString()
                };
            }
            
            userData.stats[chatKey].messages.push({ 
                text, 
                type: 'incoming', 
                time: new Date().toISOString(),
                userId: userId
            });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            // Обработка команд
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { 
                        user: userName, 
                        user_id: userId, 
                        date: new Date().toLocaleDateString(), 
                        time: new Date().toLocaleTimeString(),
                        chat_id: chatId
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
                    
                    userData.stats[chatKey].messages.push({ 
                        text: response, 
                        type: 'outgoing', 
                        time: new Date().toISOString() 
                    });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting,
                        parse_mode: 'HTML'
                    });
                } else if (text === '/help' && profile.helpText) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.helpText,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
        // Обработка callback запросов от кнопок
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const chatId = callbackQuery.message.chat.id;
            const data = callbackQuery.data;
            
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: "✅ Готово!"
            });
            
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: `🔘 Вы нажали кнопку: ${data}`,
                parse_mode: 'HTML'
            });
        }
        
        // Обработка добавления бота в группу
        if (update.my_chat_member) {
            const status = update.my_chat_member.new_chat_member.status;
            const chat = update.my_chat_member.chat;
            if (status === 'member' || status === 'administrator') {
                console.log(`✅ Бот добавлен в чат: ${chat.title || chat.id}`);
                if (profile.welcomeMessage) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chat.id,
                        text: profile.welcomeMessage,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
    } catch (e) {
        console.error('Handler error:', e.message);
        if (e.response) {
            console.error('Telegram API error:', e.response.data);
        }
    }
});

// ============= ДОПОЛНИТЕЛЬНЫЕ API =============
app.get('/api/user/stats', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const stats = {
        totalChats: Object.keys(userData.stats || {}).length,
        totalMessages: Object.values(userData.stats || {}).reduce((sum, chat) => sum + chat.messages.length, 0),
        accounts: Object.keys(userData.accounts || {}).length,
        commands: Object.values(userData.commands || {}).reduce((sum, cmds) => sum + cmds.length, 0)
    };
    res.json(stats);
});

app.get('/api/user/export', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData);
});

app.delete('/api/user/data', authMiddleware, (req, res) => {
    saveUserData(req.userId, { accounts: {}, commands: {}, profiles: {}, stats: {} });
    res.json({ success: true, message: 'Все данные очищены' });
});

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Директория данных: ${DATA_DIR}`);
    console.log(`🔗 Внешний URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
    
    setTimeout(() => {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
            files.forEach(file => {
                const userId = file.replace('user_', '').replace('.json', '');
                try {
                    const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
                    Object.entries(userData.accounts || {}).forEach(([id, account]) => {
                        if (account.token) {
                            registerWebhook(account.token, id, userId);
                        }
                    });
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            });
        }
    }, 2000);
});

// ============= API АВТОРИЗАЦИИ =============
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    
    res.json({ success: true, message: 'Регистрация успешна' });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const users = loadUsers();
    const user = users[login];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });
});

app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// ============= MIDDLEWARE =============
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    if (!userData.commands[req.params.accountId]) userData.commands[req.params.accountId] = [];
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

// ============= WEBHOOK РЕГИСТРАЦИЯ =============
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// ============= ОБРАБОТКА СООБЩЕНИЙ TELEGRAM =============
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                try {
                    const userData = JSON.parse(fs.readFileSync(filePath));
                    const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                    if (entry) {
                        foundUserId = userId;
                        foundAccountId = entry[0];
                        break;
                    }
                } catch (e) {
                    console.error(`Ошибка чтения ${file}:`, e.message);
                }
            }
        }
    }
    
    if (!foundUserId) {
        console.log(`❌ Бот с токеном ${token} не найден`);
        return res.sendStatus(404);
    }
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text && msg.video) text = "🎥 Видео";
            else if (!text && msg.audio) text = "🎵 Аудио";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { 
                    chatId, 
                    userName, 
                    messages: [], 
                    lastTime: new Date().toISOString(),
                    firstSeen: new Date().toISOString()
                };
            }
            
            userData.stats[chatKey].messages.push({ 
                text, 
                type: 'incoming', 
                time: new Date().toISOString(),
                userId: userId
            });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            // Обработка команд
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { 
                        user: userName, 
                        user_id: userId, 
                        date: new Date().toLocaleDateString(), 
                        time: new Date().toLocaleTimeString(),
                        chat_id: chatId
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
                    
                    userData.stats[chatKey].messages.push({ 
                        text: response, 
                        type: 'outgoing', 
                        time: new Date().toISOString() 
                    });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting,
                        parse_mode: 'HTML'
                    });
                } else if (text === '/help' && profile.helpText) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.helpText,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
        // Обработка callback запросов от кнопок
        if (update.callback_query) {
            const callbackQuery = update.callback_query;
            const message = callbackQuery.message;
            const chatId = message.chat.id;
            const data = callbackQuery.data;
            
            // Можно добавить обработку callback данных
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                callback_query_id: callbackQuery.id,
                text: "✅ Готово!"
            });
            
            // Отправляем сообщение о нажатии кнопки
            await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: `🔘 Вы нажали кнопку: ${data}`,
                parse_mode: 'HTML'
            });
        }
        
        // Обработка добавления бота в группу
        if (update.my_chat_member) {
            const status = update.my_chat_member.new_chat_member.status;
            const chat = update.my_chat_member.chat;
            if (status === 'member' || status === 'administrator') {
                console.log(`✅ Бот добавлен в чат: ${chat.title || chat.id}`);
                if (profile.welcomeMessage) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chat.id,
                        text: profile.welcomeMessage,
                        parse_mode: 'HTML'
                    });
                }
            }
        }
        
    } catch (e) {
        console.error('Handler error:', e.message);
        if (e.response) {
            console.error('Telegram API error:', e.response.data);
        }
    }
});

// ============= ДОПОЛНИТЕЛЬНЫЕ API =============
// Получение статистики по всем чатам пользователя
app.get('/api/user/stats', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const stats = {
        totalChats: Object.keys(userData.stats || {}).length,
        totalMessages: Object.values(userData.stats || {}).reduce((sum, chat) => sum + chat.messages.length, 0),
        accounts: Object.keys(userData.accounts || {}).length,
        commands: Object.values(userData.commands || {}).reduce((sum, cmds) => sum + cmds.length, 0)
    };
    res.json(stats);
});

// Экспорт данных пользователя
app.get('/api/user/export', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData);
});

// Очистка всех данных пользователя
app.delete('/api/user/data', authMiddleware, (req, res) => {
    saveUserData(req.userId, { accounts: {}, commands: {}, profiles: {}, stats: {} });
    res.json({ success: true, message: 'Все данные очищены' });
});

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Директория данных: ${DATA_DIR}`);
    console.log(`🔗 Внешний URL: ${process.env.RENDER_EXTERNAL_URL || 'http://localhost:' + PORT}`);
    
    // Автоматическая регистрация webhook для всех ботов при запуске
    setTimeout(() => {
        if (fs.existsSync(DATA_DIR)) {
            const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json');
            files.forEach(file => {
                const userId = file.replace('user_', '').replace('.json', '');
                const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
                Object.entries(userData.accounts || {}).forEach(([id, account]) => {
                    if (account.token) {
                        registerWebhook(account.token, id, userId);
                    }
                });
            });
        }
    }, 2000);
    return res.status(401).json({ error: 'Неверный логин или пароль' });
    
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.lastLogin = new Date().toISOString();
    user.sessionToken = sessionToken;
    saveUsers(users);
    
    res.json({ success: true, userId: login, sessionToken, message: 'Вход выполнен' });


// Проверка сессии
app.post('/api/verify', (req, res) => {
    const { login, sessionToken } = req.body;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        res.json({ success: true, userId: login });
    } else {
        res.status(401).json({ success: false });
    }
});

// Middleware для авторизации
function authMiddleware(req, res, next) {
    const { login, sessiontoken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessiontoken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.accounts);
});

app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/chats/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const chats = Object.entries(userData.stats || {})
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

app.post('/api/user/accounts', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.userId, userData);
    if (token) registerWebhook(token, id, req.userId);
    res.json({ success: true });
});

app.delete('/api/user/accounts/:id', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/chat/:chatKey', authMiddleware, (req, res) => {
    const userData = loadUserData(req.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.userId, userData);
    res.json({ success: true });
});

// Регистрация webhook
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId} (user ${userId}): ${webhookUrl}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// Обработка сообщений от Telegram
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    let foundUserId = null;
    let foundAccountId = null;
    
    if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && f !== 'users.json' && !f.includes('users'));
        
        for (const file of files) {
            const userId = file.replace('user_', '').replace('.json', '');
            const filePath = path.join(DATA_DIR, file);
            if (fs.existsSync(filePath)) {
                const userData = JSON.parse(fs.readFileSync(filePath));
                const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
                if (entry) {
                    foundUserId = userId;
                    foundAccountId = entry[0];
                    break;
                }
            }
        }
    }
    
    if (!foundUserId) return res.sendStatus(404);
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUserId);
        const commands = userData.commands[foundAccountId] || [];
        const profile = userData.profiles[foundAccountId] || {};
        
        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const userId = msg.from?.id;
            const userName = msg.from?.first_name || "User";
            let text = msg.text;
            
            if (!text && msg.photo) text = "📸 Фото";
            else if (!text && msg.document) text = "📄 Документ";
            else if (!text) text = "📎 Медиа";
            
            const chatKey = `${foundAccountId}_${chatId}`;
            if (!userData.stats[chatKey]) {
                userData.stats[chatKey] = { chatId, userName, messages: [], lastTime: new Date().toISOString() };
            }
            userData.stats[chatKey].messages.push({ text, type: 'incoming', time: new Date().toISOString() });
            userData.stats[chatKey].lastTime = new Date().toISOString();
            saveUserData(foundUserId, userData);
            
            if (text && text.startsWith('/')) {
                const command = commands.find(c => c.name === text);
                
                if (command) {
                    let response = command.response;
                    const vars = { user: userName, user_id: userId, date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString() };
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
                    
                    userData.stats[chatKey].messages.push({ text: response, type: 'outgoing', time: new Date().toISOString() });
                    saveUserData(foundUserId, userData);
                } else if (text === '/start' && profile.greeting) {
                    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                        chat_id: chatId,
                        text: profile.greeting
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

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
