const express = require('express');
const { body, validationResult } = require('express-validator');
const path = require('path');
const logger = require('./logger');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getProviderSettings } = require('./emailProviders');
const { testImapConnection, testPop3Connection, testSmtpConnection, fetchImapEmails, fetchPop3Emails, sendEmail, markAsRead, getFolders } = require('./emailUtils');
const { callCustomApi, logActivity } = require('./apiClient');

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy for HTTPS redirects in production (limit to 1 hop)
app.set('trust proxy', 1);

// Security headers with Helmet (configured for Replit iframe compatibility)
app.use(helmet({
    frameguard: false, // Allow iframe embedding in Replit
    crossOriginResourcePolicy: { policy: 'same-site' },
    hidePoweredBy: true,
    hsts: process.env.NODE_ENV === 'production'
}));

// Configure CSP for Replit iframe and inline handlers
app.use(helmet.contentSecurityPolicy({
    directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for onclick handlers
        scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers
        styleSrc: ["'self'", "https:", "'unsafe-inline'"], // Allow inline styles
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'", "https://*.replit.com", "https://replit.com"] // Allow Replit iframe
    }
}));

// Global no-cache middleware for all routes
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// HTTPS redirect in production
app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && !req.secure) {
        return res.redirect(308, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
});

// Rate limiting for authentication endpoints
const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: { error: 'Too many authentication attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting for email action endpoints
const emailRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // limit each IP to 30 requests per minute
    message: { error: 'Too many email requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/custom-api-call', emailRateLimit, [
    body('email').isEmail().withMessage('Некорректный email'),
    body('action').notEmpty().withMessage('Отсутствует действие'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Ошибка валидации при вызове API: ${JSON.stringify(errors.array())}`);
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, action, accountData } = req.body;
    logger.info(`Пользователь ${email} вызывает API с действием: ${action}`);

    try {
        const apiResult = await callCustomApi({ email, action, data: accountData });
        await logActivity('custom_api_call', { email, action, success: true });
        res.json({ success: true, data: apiResult, message: 'Вызов API успешно обработан' });
    } catch (error) {
        logger.error(`Ошибка при вызове внешнего API для ${email}: ${error.message}`);
        await logActivity('custom_api_call', { email, action, success: false, error: error.message });
        res.status(500).json({ success: false, error: 'Ошибка при вызове внешнего API.' });
    }
});

app.post('/api/test-connection', authRateLimit, [
    body('email').isEmail().withMessage('Некорректиный email'),
    body('password').notEmpty().withMessage('Пароль не может быть пустым'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Ошибка валидации при тестировании подключения: ${JSON.stringify(errors.array())}`);
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, fetchProtocol, imapHost, imapPort, pop3Host, pop3Port, smtpHost, smtpPort } = req.body;
    let fetchResult = false;
    let smtpResult = false;
    let errs = [];

    const providerSettings = getProviderSettings(email);
    const finalImapHost = providerSettings ? providerSettings.imap.host : imapHost;
    const finalImapPort = providerSettings ? providerSettings.imap.port : imapPort;
    const finalPop3Host = providerSettings ? providerSettings.pop3.host : pop3Host;
    const finalPop3Port = providerSettings ? providerSettings.pop3.port : pop3Port;
    const finalSmtpHost = providerSettings ? providerSettings.smtp.host : smtpHost;
    const finalSmtpPort = providerSettings ? providerSettings.smtp.port : smtpPort;

    if (fetchProtocol === 'imap') {
        if (!finalImapHost || !finalImapPort) {
            logger.error(`Не удалось определить настройки IMAP для ${email}.`);
            return res.json({ success: false, error: 'Не удалось определить настройки IMAP сервера. Пожалуйста, укажите хост и порт вручную.' });
        }
        try {
            await testImapConnection({ email, password, imapHost: finalImapHost, imapPort: finalImapPort });
            fetchResult = true;
        } catch (error) {
            errs.push(`IMAP: ${error.message}`);
            logger.error(`Ошибка IMAP для ${email}: ${error.message}`);
        }
    } else if (fetchProtocol === 'pop3') {
        if (!finalPop3Host || !finalPop3Port) {
            logger.error(`Не удалось определить настройки POP3 для ${email}.`);
            return res.json({ success: false, error: 'Не удалось определить настройки POP3 сервера. Пожалуйста, укажите хост и порт вручную.' });
        }
        try {
            await testPop3Connection({ email, password, pop3Host: finalPop3Host, pop3Port: finalPop3Port });
            fetchResult = true;
        } catch (error) {
            errs.push(`POP3: ${error.message}`);
            logger.error(`Ошибка POP3 для ${email}: ${error.message}`);
        }
    } else {
        errs.push('Неизвестный протокол получения.');
    }

    try {
        await testSmtpConnection({ email, password, smtpHost: finalSmtpHost, smtpPort: finalSmtpPort });
        smtpResult = true;
    } catch (error) {
        errs.push(`SMTP: ${error.message}`);
        logger.error(`Ошибка SMTP для ${email}: ${error.message}`);
    }

    if (fetchResult && smtpResult) {
        logger.info(`Подключение для ${email} успешно протестировано.`);
        await logActivity('connection_test_success', { email, [fetchProtocol]: true, smtp: true });
    } else {
        await logActivity('connection_test_failed', { email, [fetchProtocol]: fetchResult, smtp: smtpResult, errors: errs.join(', ') });
    }

    res.json({
        success: fetchResult && smtpResult,
        [fetchProtocol]: fetchResult,
        smtp: smtpResult,
        error: errs.length > 0 ? errs.join(', ') : null
    });
});

app.post('/api/fetch-emails', emailRateLimit, [
    body('email').isEmail().withMessage('Некорректный email'),
    body('password').notEmpty().withMessage('Пароль не может быть пустым'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Ошибка валидации при получении писем: ${JSON.stringify(errors.array())}`);
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, fetchProtocol, imapHost, imapPort, pop3Host, pop3Port, folder = 'INBOX', count = 10 } = req.body;
    logger.info(`Пользователь ${email} пытается получить письма по протоколу ${fetchProtocol.toUpperCase()}.`);
    
    const providerSettings = getProviderSettings(email);
    const finalImapHost = providerSettings ? providerSettings.imap.host : imapHost;
    const finalImapPort = providerSettings ? providerSettings.imap.port : imapPort;
    const finalPop3Host = providerSettings ? providerSettings.pop3.host : pop3Host;
    const finalPop3Port = providerSettings ? providerSettings.pop3.port : pop3Port;

    try {
        let emails;
        if (fetchProtocol === 'imap') {
            if (!finalImapHost) {
                return res.json({ success: false, error: 'Не удалось определить настройки IMAP сервера.' });
            }
            emails = await fetchImapEmails({ email, password, imapHost: finalImapHost, imapPort: finalImapPort, folder, count });
        } else if (fetchProtocol === 'pop3') {
            if (!finalPop3Host) {
                return res.json({ success: false, error: 'Не удалось определить настройки POP3 сервера.' });
            }
            emails = await fetchPop3Emails({ email, password, pop3Host: finalPop3Host, pop3Port: finalPop3Port, count });
        } else {
            throw new Error('Неизвестный протокол получения.');
        }

        logger.info(`Получено ${emails.length} писем для ${email} с помощью ${fetchProtocol.toUpperCase()}.`);
        await logActivity('emails_fetched', { email, protocol: fetchProtocol, count: emails.length });
        res.json({ success: true, emails: emails, count: emails.length });
    } catch (error) {
        logger.error(`Ошибка при получении писем (${fetchProtocol.toUpperCase()}) для ${email}: ${error.message}`);
        await logActivity('emails_fetch_failed', { email, protocol: fetchProtocol, error: error.message });
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/send-email', emailRateLimit, [
    body('email').isEmail().withMessage('Некорректный email отправителя'),
    body('password').notEmpty().withMessage('Пароль не может быть пустым'),
    body('to').isEmail().withMessage('Некорректный email получателя'),
    body('subject').notEmpty().withMessage('Тема не может быть пустой'),
    body('text').notEmpty().withMessage('Тело письма не может быть пустым'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Ошибка валидации при отправке письма: ${JSON.stringify(errors.array())}`);
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, smtpHost, smtpPort, to, subject, text } = req.body;
    logger.info(`Пользователь ${email} пытается отправить письмо на ${to} с темой "${subject}".`);

    const providerSettings = getProviderSettings(email);
    const finalSmtpHost = providerSettings ? providerSettings.smtp.host : smtpHost;
    const finalSmtpPort = providerSettings ? providerSettings.smtp.port : smtpPort;

    if (!finalSmtpHost) {
        logger.error(`Не удалось определить настройки SMTP для ${email}.`);
        return res.json({ success: false, error: 'Не удалось определить настройки SMTP сервера.' });
    }

    try {
        await sendEmail({ from: email, password, smtpHost: finalSmtpHost, smtpPort: finalSmtpPort, to, subject, text });
        logger.info(`Письмо от ${email} на ${to} успешно отправлено.`);
        await logActivity('email_sent_success', { email, to, subject });
        res.json({ success: true, message: 'Email sent successfully' });
    } catch (error) {
        logger.error(`Ошибка при отправке письма от ${email}: ${error.message}`);
        await logActivity('email_sent_failed', { email, to, subject, error: error.message });
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/mark-read', emailRateLimit, [
    body('email').isEmail().withMessage('Некорректный email'),
    body('password').notEmpty().withMessage('Пароль не может быть пустым'),
    body('messageIds').isArray().withMessage('messageIds должен быть массивом'),
    body('messageIds.*').isInt().withMessage('messageIds должны быть числами'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Ошибка валидации при пометке писем как прочитанных: ${JSON.stringify(errors.array())}`);
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, imapHost, imapPort, messageIds } = req.body;
    logger.info(`Пользователь ${email} помечает ${messageIds.length} писем как прочитанные.`);

    const providerSettings = getProviderSettings(email);
    const finalImapHost = providerSettings ? providerSettings.imap.host : imapHost;
    const finalImapPort = providerSettings ? providerSettings.imap.port : imapPort;

    if (!finalImapHost) {
        logger.error(`Не удалось определить настройки IMAP для ${email}.`);
        return res.json({ success: false, error: 'Не удалось определить настройки IMAP сервера.' });
    }

    try {
        await markAsRead({ email, password, imapHost: finalImapHost, imapPort: finalImapPort, messageIds });
        logger.info(`Письма для ${email} успешно помечены как прочитанные.`);
        await logActivity('emails_marked_read', { email, count: messageIds.length });
        res.json({ success: true, message: 'Messages marked as read' });
    } catch (error) {
        logger.error(`Ошибка при пометке писем как прочитанных для ${email}: ${error.message}`);
        await logActivity('emails_mark_read_failed', { email, count: messageIds.length, error: error.message });
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/get-folders', emailRateLimit, [
    body('email').isEmail().withMessage('Некорректный email'),
    body('password').notEmpty().withMessage('Пароль не может быть пустым'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Ошибка валидации при получении списка папок: ${JSON.stringify(errors.array())}`);
        return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password, imapHost, imapPort, fetchProtocol } = req.body;
    logger.info(`Пользователь ${email} запрашивает список папок.`);
    
    // Проверяем, что используется IMAP, так как POP3 не поддерживает папки
    if (fetchProtocol === 'pop3') {
        logger.info(`Запрос папок для POP3 аккаунта ${email}. Возвращаем пустой список.`);
        return res.json({ success: true, folders: [] });
    }

    const providerSettings = getProviderSettings(email);
    const finalImapHost = providerSettings ? providerSettings.imap.host : imapHost;
    const finalImapPort = providerSettings ? providerSettings.imap.port : imapPort;

    if (!finalImapHost) {
        logger.error(`Не удалось определить настройки IMAP для ${email}.`);
        return res.json({ success: false, error: 'Не удалось определить настройки IMAP сервера.' });
    }

    try {
        const folders = await getFolders({ email, password, imapHost: finalImapHost, imapPort: finalImapPort });
        logger.info(`Получено ${folders.length} папок для ${email}.`);
        await logActivity('folders_fetched', { email, count: folders.length });
        res.json({ success: true, folders: folders });
    } catch (error) {
        logger.error(`Ошибка при получении папок для ${email}: ${error.message}`);
        await logActivity('folders_fetch_failed', { email, error: error.message });
        res.json({ success: false, error: error.message });
    }
});

app.use((err, req, res, next) => {
    logger.error(`Необработанная ошибка сервера: ${err.stack}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╭─────────────────────────────────────────╮
│         📧 Email Client Server          │
│                                         │
│  Server running on: http://localhost:${PORT}  │
│                                         │
│  Features:                              │
│  ✓ IMAP email fetching                  │
│  ✓ POP3 email fetching                  │
│  ✓ SMTP email sending                   │
│  ✓ Multiple account management          │
│  ✓ Connection testing                   │
│                                         │
│  Supported providers:                   │
│  • Gmail                                │
│  • Outlook/Hotmail                      │
│  • Yandex                               │
│  • Yahoo                                │
│  • Custom IMAP/POP3/SMTP servers        │
╰─────────────────────────────────────────╯
    `);
    logger.info(`Сервер запущен на порту ${PORT}.`);
});

process.on('SIGTERM', () => {
    logger.info('Сервер завершает работу...');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('Сервер завершает работу...');
    process.exit(0);
});