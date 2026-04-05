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

// Регистрация
app.post('/api/register', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    const users = loadUsers();
    if (users[login]) return res.status(400).json({ error: 'Пользователь уже существует' });
    users[login] = { password: hashPassword(password), createdAt: new Date().toISOString() };
    saveUsers(users);
    res.json({ success: true });
});

// Логин
app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните все поля' });
    const users = loadUsers();
    const user = users[login];
    if (!user || user.password !== hashPassword(password)) {
        return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    const sessionToken = crypto.randomBytes(32).toString('hex');
    user.sessionToken = sessionToken;
    saveUsers(users);
    res.json({ success: true, userId: login, sessionToken });
});

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

// Middleware
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

// API
app.get('/api/user/accounts', authMiddleware, (req, res) => {
    res.json(loadUserData(req.userId).accounts);
});
app.get('/api/user/commands/:accountId', authMiddleware, (req, res) => {
    res.json(loadUserData(req.userId).commands[req.params.accountId] || []);
});
app.get('/api/user/profile/:accountId', authMiddleware, (req, res) => {
    res.json(loadUserData(req.userId).profiles[req.params.accountId] || {});
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

// Webhook регистрация
async function registerWebhook(botToken, botId, userId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
    const webhookUrl = `${baseUrl}/webhook/${botToken}`;
    try {
        await axios.post(`https://api.telegram.org/bot${botToken}/setWebhook`, { url: webhookUrl });
        console.log(`✅ Webhook для бота ${botId}`);
    } catch (e) {
        console.error(`❌ Ошибка webhook:`, e.message);
    }
}

// Обработка сообщений
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    let foundUserId = null;
    let foundAccountId = null;
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && !f.includes('users'));
    for (const file of files) {
        const userId = file.replace('user_', '').replace('.json', '');
        const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
        const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
        if (entry) {
            foundUserId = userId;
            foundAccountId = entry[0];
            break;
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

// Загрузка данных пользователя
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
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && !f.includes('users'));
    
    for (const file of files) {
        const userId = file.replace('user_', '').replace('.json', '');
        const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
        const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
        if (entry) {
            foundUserId = userId;
            foundAccountId = entry[0];
            break;
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
});    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath));
    return { accounts: {}, commands: {}, profiles: {}, stats: {} };

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
    
    // Генерируем простую сессию (в реальном проекте используйте JWT)
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

// ============= API ДАННЫХ ПОЛЬЗОВАТЕЛЯ =============
function authMiddleware(req, res, next) {
    const { login, sessionToken } = req.headers;
    const users = loadUsers();
    const user = users[login];
    
    if (user && user.sessionToken === sessionToken) {
        req.userId = login;
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

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
    const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_') && !f.includes('users'));
    
    for (const file of files) {
        const userId = file.replace('user_', '').replace('.json', '');
        const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file)));
        const entry = Object.entries(userData.accounts || {}).find(([_, a]) => a.token === token);
        if (entry) {
            foundUserId = userId;
            foundAccountId = entry[0];
            break;
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

// Регистрация webhook
async function registerWebhook(botToken, botId) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `https://axius-bot.onrender.com`;
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
            
            const chatKey = `${accountId}_${chatId}`;
            if (!botStats[chatKey]) {
                botStats[chatKey] = { chatId, userName, messages: [], lastTime: new Date().toISOString() };
            }
            botStats[chatKey].messages.push({ text, type: 'incoming', time: new Date().toISOString() });
            botStats[chatKey].lastTime = new Date().toISOString();
            saveAll();
            
            if (text && text.startsWith('/')) {
                const commands = botCommands[accountId] || [];
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

// API для веб-интерфейса
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
});    const hmac = require('crypto').createHmac('sha256', secret).update(checkString).digest('hex');
    return hmac === hash;
}

// API для авторизации
app.post('/api/auth', (req, res) => {
    const { tgData } = req.body;
    if (verifyTelegramAuth(tgData)) {
        const userId = tgData.id.toString();
        req.session = { userId };
        res.json({ success: true, userId, name: tgData.first_name });
    } else {
        res.status(401).json({ success: false, error: 'Unauthorized' });
    }
});

// API для получения данных пользователя
app.get('/api/user/:userId/accounts', (req, res) => {
    const userData = loadUserData(req.params.userId);
    res.json(userData.accounts);
});

app.get('/api/user/:userId/commands/:accountId', (req, res) => {
    const userData = loadUserData(req.params.userId);
    res.json(userData.commands[req.params.accountId] || []);
});

app.get('/api/user/:userId/profile/:accountId', (req, res) => {
    const userData = loadUserData(req.params.userId);
    res.json(userData.profiles[req.params.accountId] || {});
});

app.get('/api/user/:userId/chats/:accountId', (req, res) => {
    const userData = loadUserData(req.params.userId);
    const chats = Object.entries(userData.stats)
        .filter(([key]) => key.startsWith(req.params.accountId))
        .map(([key, val]) => ({ id: key, ...val }));
    res.json(chats);
});

// API для сохранения данных
app.post('/api/user/:userId/accounts', (req, res) => {
    const userData = loadUserData(req.params.userId);
    const { id, token, name } = req.body;
    userData.accounts[id] = { id, token, name };
    saveUserData(req.params.userId, userData);
    
    // Регистрируем webhook для бота
    if (token) registerWebhook(token, id);
    res.json({ success: true });
});

app.delete('/api/user/:userId/accounts/:id', (req, res) => {
    const userData = loadUserData(req.params.userId);
    delete userData.accounts[req.params.id];
    saveUserData(req.params.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/:userId/commands/:accountId', (req, res) => {
    const userData = loadUserData(req.params.userId);
    userData.commands[req.params.accountId] = req.body;
    saveUserData(req.params.userId, userData);
    res.json({ success: true });
});

app.post('/api/user/:userId/profile/:accountId', (req, res) => {
    const userData = loadUserData(req.params.userId);
    userData.profiles[req.params.accountId] = req.body;
    saveUserData(req.params.userId, userData);
    res.json({ success: true });
});

app.delete('/api/user/:userId/chat/:chatKey', (req, res) => {
    const userData = loadUserData(req.params.userId);
    delete userData.stats[req.params.chatKey];
    saveUserData(req.params.userId, userData);
    res.json({ success: true });
});

// Webhook для Telegram (обработка сообщений)
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

// Обработка входящих сообщений
app.post('/webhook/:token', async (req, res) => {
    const token = req.params.token;
    
    // Ищем пользователя, у которого есть этот бот
    let foundUser = null;
    let foundAccountId = null;
    const users = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('user_'));
    
    for (const userFile of users) {
        const userId = userFile.replace('user_', '').replace('.json', '');
        const userData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, userFile)));
        const accountEntry = Object.entries(userData.accounts).find(([_, a]) => a.token === token);
        if (accountEntry) {
            foundUser = userId;
            foundAccountId = accountEntry[0];
            break;
        }
    }
    
    if (!foundUser) return res.sendStatus(404);
    
    const update = req.body;
    res.sendStatus(200);
    
    try {
        const userData = loadUserData(foundUser);
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
            saveUserData(foundUser, userData);
            
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
                    saveUserData(foundUser, userData);
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
});}

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
