const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ZMIANA: pliki NIE są już zapisywane na dysku Rendera (dysk jest tymczasowy i kasuje się
// przy każdym restarcie / deployu). Trzymamy je w bazie danych (Supabase) w tabeli "files".
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 }
});

const ALLOWED_MIME = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/;

async function saveFile(file) {
    if (!file) return null;
    if (!ALLOWED_MIME.test(file.mimetype)) throw new Error('Niedozwolony typ pliku: ' + file.mimetype);
    const r = await pool.query(
        'INSERT INTO files (filename, mime, data) VALUES ($1, $2, $3) RETURNING id',
        [file.originalname, file.mimetype, file.buffer]
    );
    return '/api/files/' + r.rows[0].id;
}

// Sesje w bazie - dzięki temu restart serwera na Renderze nie wylogowuje wszystkich.
class PgSessionStore extends session.Store {
    constructor(pool) { super(); this.pool = pool; }
    get(sid, cb) {
        this.pool.query('SELECT sess FROM sessions WHERE sid = $1 AND expire > NOW()', [sid])
            .then(r => cb(null, r.rows[0] ? r.rows[0].sess : null)).catch(cb);
    }
    set(sid, sess, cb) {
        const expire = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86400000);
        this.pool.query(
            'INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = $3',
            [sid, JSON.stringify(sess), expire]
        ).then(() => cb && cb(null)).catch(e => cb && cb(e));
    }
    touch(sid, sess, cb) {
        const expire = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 86400000);
        this.pool.query('UPDATE sessions SET expire = $2 WHERE sid = $1', [sid, expire])
            .then(() => cb && cb(null)).catch(e => cb && cb(e));
    }
    destroy(sid, cb) {
        this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid])
            .then(() => cb && cb(null)).catch(e => cb && cb(e));
    }
}

const countryCode = v => (/^[A-Za-z]{2}$/.test(v || '') ? v.toUpperCase() : null);

function countryFlag(code) {
    const normalized = countryCode(code);
    if (!normalized) return '';
    return String.fromCodePoint(...[...normalized].map(ch => 127397 + ch.charCodeAt(0)));
}

// Publikuje kartę raportu dopiero po zatwierdzeniu trasy przez Szefa.
// URL webhooka jest sekretem i musi być ustawiony wyłącznie w zmiennych Rendera.
async function postApprovedJobToDiscord(job, position) {
    const webhook = String(process.env.DISCORD_WEBHOOK_URL || '').trim();
    if (!webhook) return false;

    try {
        const webhookUrl = new URL(webhook);
        if (webhookUrl.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(webhookUrl.hostname)) {
            console.warn('Discord webhook pominięty: adres musi prowadzić do oficjalnego Discorda.');
            return false;
        }

        const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
        const logoUrl = publicBaseUrl ? `${publicBaseUrl}/logo.png` : null;
        const money = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(Number(job.income) || 0);
        const distance = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(Number(job.distance) || 0);
        const startFlag = countryFlag(job.start_country);
        const endFlag = countryFlag(job.end_country);
        const embed = {
            title: `Dostawa #${job.id}`,
            description: `**${job.start_city}** → **${job.end_city}**`,
            color: 0x2684ff,
            author: { name: String(job.username || 'Kierowca').slice(0, 256) },
            fields: [
                { name: 'Z', value: `${startFlag ? startFlag + ' ' : ''}${job.start_city}`, inline: true },
                { name: 'Do', value: `${endFlag ? endFlag + ' ' : ''}${job.end_city}`, inline: true },
                { name: 'Towar', value: String(job.cargo || 'Standard').slice(0, 1024), inline: false },
                { name: 'Zatwierdzony dystans', value: `${distance} km`, inline: true },
                { name: 'Przychód', value: `${money} €`, inline: true },
                { name: 'Pozycja w firmie', value: position ? `#${position}` : '—', inline: true }
            ],
            footer: { text: 'Mazren Spedition • Zatwierdzono przez stronę/aplikację', ...(logoUrl ? { icon_url: logoUrl } : {}) },
            timestamp: new Date().toISOString(),
            ...(logoUrl ? { thumbnail: { url: logoUrl } } : {})
        };
        const payload = {
            username: 'Mazren Spedition',
            embeds: [embed],
            ...(logoUrl ? { avatar_url: logoUrl } : {})
        };

        webhookUrl.searchParams.set('wait', 'true');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        let response;
        try {
            response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            console.warn(`Discord webhook nie przyjął trasy #${job.id} (HTTP ${response.status}).`);
            return false;
        }
        return true;
    } catch (err) {
        console.warn(`Nie udało się wysłać trasy #${job.id} na Discorda: ${err.message}`);
        return false;
    }
}

// Dotychczasowa flota (wcześniej wpisana na sztywno w index.html) - zasiewana do bazy JEDEN raz.
const DEFAULT_TRUCKS = [
    { model: "SCANIA R500", cabin: "Highline", chassis: "4x2 type 2", engine: "DC13 165 500 Euro 6", gearbox: "G33CMR", interior: "Exclusive Dark Eu", accessories: "Własne", photo: "/scaniarprzod.jpg", photoBack: "/scaniartyl.jpg", plates: ["WRA 8001S", "WRA 8002S", "WRA 8003S"] },
    { model: "SCANIA PGR 520", cabin: "CR19T Topline 2008-2018", chassis: "4x2 4000mm", engine: "DC16 101 520 Euro 6", gearbox: "GRSO900R", interior: "Treated New Gauges Radio", accessories: "Własne", photo: "/scaniapgrprzod.jpg", photoBack: "/scaniapgrtyl.jpg", plates: ["WRA 6614S", "WRA 6615S", "WRA 6616S"] },
    { model: "RENAULT PRIVILEGE 400", cabin: "High Roof", chassis: "4x2", engine: "400 Euro2", gearbox: "Optidriver R", interior: "Privilege", accessories: "Własne", photo: "/renaultprzod.jpg", photoBack: "/renaulttyl.jpg", plates: ["WRA 5024S", "WRA 5025S", "WRA 5026S"] },
    { model: "VOLVO FH2 500", cabin: "Globetrotter XL", chassis: "4x2", engine: "D13A500", gearbox: "I-Shift", interior: "Standard", accessories: "Własne", photo: "/volvoprzod.jpg", photoBack: "/volvotyl.jpg", plates: ["WRA 6509S", "WRA 6510S", "WRA 6511S", "WRA 6512S"] },
    { model: "RENAULT T 480", cabin: "High Sleeper", chassis: "4x2", engine: "DTI 13 480", gearbox: "Optidriver", interior: "Exclusive Black", accessories: "Własne", photo: "/renaulttprzod.jpg", photoBack: "/renaultttyl.jpg", plates: ["WRA 7945S", "WRA 7946S", "WRA 7947S"] },
    { model: "MERCEDES MP4 476", cabin: "GigaSpace", chassis: "4x2", engine: "OM 471 476KM", gearbox: "PowerShift", interior: "Comfortline", accessories: "Własne", photo: "/mercedesprzod.jpg", photoBack: "/mercedestyl.jpg", plates: ["WRA 7217S", "WRA 7218S", "WRA 7219S"] },
    { model: "MAN TGX E6 480", cabin: "Cabin XXL", chassis: "4x2 BLS", engine: "D2676 480KM", gearbox: "TipMatic", interior: "Beige", accessories: "Własne", photo: "/manprzod.jpg", photoBack: "/mantyl.jpg", plates: ["WRA 7707S", "WRA 7708S", "WRA 7709S"] },
    { model: "DAF XF106 510", cabin: "Super Space Cab", chassis: "4x2", engine: "MX-13 510KM", gearbox: "ZF AS Tronic", interior: "Standard", accessories: "Własne", photo: "/dafprzod.jpg", photoBack: "/daftyl.jpg", plates: ["WRA 6196S", "WRA 6197S", "WRA 6198S", "WRA 6199S"] },
    { model: "VOLVO FH4 500", cabin: "Globetrotter XL", chassis: "4x2", engine: "DC13C500 500KM", gearbox: "VT2514B", interior: "Exclusive", accessories: "Własne", photo: "/volvo4przod.jpg", photoBack: "/volvo4tyl.jpg", plates: ["WRA 7605S", "WRA 7606S", "WRA 7607S"] }
];

async function seedTrucks() {
    const done = await pool.query("SELECT value FROM app_meta WHERE key = 'trucks_seeded'");
    if (done.rows.length > 0) return;

    for (const t of DEFAULT_TRUCKS) {
        const exists = await pool.query('SELECT 1 FROM trucks WHERE LOWER(truck_model) = LOWER($1) LIMIT 1', [t.model]);
        if (exists.rows.length > 0) continue;
        for (const plate of t.plates) {
            await pool.query(
                `INSERT INTO trucks (truck_model, driver_name, plates, photo, photo_back, cabin, chassis, engine, gearbox, interior, accessories)
                 VALUES ($1, 'Wolne', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [t.model, plate, t.photo, t.photoBack, t.cabin, t.chassis, t.engine, t.gearbox, t.interior, t.accessories]
            );
        }
    }
    await pool.query("INSERT INTO app_meta (key, value) VALUES ('trucks_seeded', '1') ON CONFLICT (key) DO NOTHING");
    console.log('Flota startowa dodana do bazy.');
}

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'driver',
                status VARCHAR(50) DEFAULT 'approved'
            );
            
            CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                start_city VARCHAR(255) NOT NULL,
                end_city VARCHAR(255) NOT NULL,
                cargo VARCHAR(255) DEFAULT 'Standard',
                distance INTEGER NOT NULL,
                income INTEGER DEFAULT 0,
                cmr_file TEXT,
                summary_photo TEXT,
                status VARCHAR(50) DEFAULT 'approved',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL,
                amount INTEGER NOT NULL,
                description TEXT NOT NULL,
                liters INTEGER DEFAULT 0,
                expense_date DATE DEFAULT CURRENT_DATE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS trucks (
                id SERIAL PRIMARY KEY,
                truck_model VARCHAR(255) NOT NULL,
                driver_name VARCHAR(255) DEFAULT 'Wolne',
                plates VARCHAR(50) NOT NULL,
                photo TEXT,
                cabin VARCHAR(255) DEFAULT 'Standard',
                chassis VARCHAR(255) DEFAULT 'Standard',
                engine VARCHAR(255) DEFAULT 'Standard',
                gearbox VARCHAR(255) DEFAULT 'Standard',
                interior VARCHAR(255) DEFAULT 'Standard',
                accessories VARCHAR(255) DEFAULT 'Standard'
            );

            CREATE TABLE IF NOT EXISTS dispatches (
                id SERIAL PRIMARY KEY,
                assigned_to VARCHAR(255) DEFAULT 'Wszyscy',
                start_city VARCHAR(255) NOT NULL,
                end_city VARCHAR(255) NOT NULL,
                cargo VARCHAR(255) DEFAULT 'Standard',
                notes TEXT,
                truck_name VARCHAR(255),
                status VARCHAR(50) DEFAULT 'W wolnym obiegu',
                accepted_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                accepted_by_username VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                category VARCHAR(100) DEFAULT 'Regulamin',
                content TEXT NOT NULL,
                file_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                job_id INTEGER DEFAULT NULL,
                action_tab VARCHAR(50) DEFAULT 'jobs',
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS password_reset_requests (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            status VARCHAR(20) NOT NULL DEFAULT 'open'
        );`);
        await pool.query(`CREATE INDEX IF NOT EXISTS password_reset_requests_open_idx ON password_reset_requests(status, requested_at);`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS password_reset_requests_one_open_idx ON password_reset_requests(user_id) WHERE status = 'open';`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_override INTEGER;`);
        await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (
            key VARCHAR(100) PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
        await pool.query(`CREATE TABLE IF NOT EXISTS recruitment_applications (
            id SERIAL PRIMARY KEY,
            full_name VARCHAR(150) NOT NULL DEFAULT '',
            discord_name VARCHAR(100) NOT NULL DEFAULT '',
            age INTEGER NOT NULL,
            ets2_hours INTEGER NOT NULL,
            about TEXT NOT NULL,
            skills TEXT NOT NULL DEFAULT '',
            previous_companies TEXT NOT NULL,
            source TEXT NOT NULL,
            dlcs TEXT NOT NULL,
            ets2_apps TEXT NOT NULL DEFAULT '',
            motivation TEXT NOT NULL DEFAULT '',
            signature VARCHAR(150) NOT NULL DEFAULT '',
            steam_url VARCHAR(500) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'new',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );`);
        await pool.query(`ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS full_name VARCHAR(150) NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS discord_name VARCHAR(100) NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS skills TEXT NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS ets2_apps TEXT NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS motivation TEXT NOT NULL DEFAULT '';`);
        await pool.query(`ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS signature VARCHAR(150) NOT NULL DEFAULT '';`);
        await pool.query(`CREATE INDEX IF NOT EXISTS recruitment_applications_created_idx ON recruitment_applications(created_at DESC);`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'approved';`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS correction_note TEXT;`);
        await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS job_id INTEGER DEFAULT NULL;`);
        await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS action_tab VARCHAR(50) DEFAULT 'jobs';`);
        await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_date DATE DEFAULT CURRENT_DATE;`);

        // --- NOWE ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS files (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255),
                mime VARCHAR(100) NOT NULL,
                data BYTEA NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sessions (
                sid VARCHAR PRIMARY KEY,
                sess JSONB NOT NULL,
                expire TIMESTAMP(6) NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);
            CREATE TABLE IF NOT EXISTS app_meta (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS trailers (
                id SERIAL PRIMARY KEY,
                trailer_model VARCHAR(255) NOT NULL,
                driver_name VARCHAR(255) DEFAULT 'Wolne',
                plates VARCHAR(50) NOT NULL DEFAULT 'BRAK',
                photo TEXT,
                photo_back TEXT,
                description TEXT DEFAULT ''
            );
        `);
        await pool.query(`ALTER TABLE trucks ADD COLUMN IF NOT EXISTS photo_back TEXT;`);
        await pool.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS start_country VARCHAR(2);`);
        await pool.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS end_country VARCHAR(2);`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS start_country VARCHAR(2);`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS end_country VARCHAR(2);`);
        await seedTrucks();
        await clientApi.initTables();

        console.log('Baza danych zainicjalizowana pomyślnie.');
    } catch (err) {
        console.error('Błąd inicjalizacji bazy:', err.message);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
        if (path.basename(filePath).toLowerCase() === 'index.html') {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

app.set('trust proxy', 1);
app.get('/healthz', (req, res) => res.type('text').send('ok'));
if (!process.env.SESSION_SECRET) {
    console.warn('UWAGA: brak zmiennej SESSION_SECRET - używany jest domyślny, publiczny sekret! Ustaw SESSION_SECRET w panelu Rendera.');
}
app.use(session({
    store: new PgSessionStore(pool),
    secret: process.env.SESSION_SECRET || 'mazren-spedition-secret-key',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

// Forced password change gate: only profile check, password update and logout remain available.
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && req.session.userId && req.session.mustChangePassword &&
        !['/api/user', '/api/password/change', '/api/logout'].includes(req.path)) {
        return res.status(403).json({ error: 'Najpierw ustaw nowe hasło.', mustChangePassword: true });
    }
    next();
});

// sprzątanie wygasłych sesji co godzinę
setInterval(() => { pool.query('DELETE FROM sessions WHERE expire < NOW()').catch(() => {}); }, 60 * 60 * 1000);

async function addNotification(userId, title, message, jobId = null, actionTab = 'jobs') {
    try {
        await pool.query(
            'INSERT INTO notifications (user_id, title, message, job_id, action_tab) VALUES ($1, $2, $3, $4, $5)', 
            [userId, title, message, jobId, actionTab]
        );
    } catch (e) { 
        console.error('Błąd powiadomień:', e); 
    }
}

function requireLogin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    next();
}
// Role: 'admin' (Szef), 'manager' (Kierownik: te same uprawnienia co Szef, z dwoma wyjątkami poniżej), 'driver' (Kierowca).
// Wyjątki: role nadaje tylko Szef, a kont Szefa i Kierowników (zwolnienie, usunięcie, zmiana hasła) nie rusza Kierownik.
const STAFF_ROLES = ['admin', 'manager'];
function isStaff(role) { return STAFF_ROLES.includes(role); }
function canManageUser(actorRole, targetRole) {
    if (targetRole === 'admin') return false;                  // konta Szefa nie ruszamy
    if (targetRole === 'manager') return actorRole === 'admin'; // Kierownika zarządza tylko Szef
    return isStaff(actorRole);
}

function requireAdmin(req, res, next) {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    next();
}
async function killUserSessions(userId, exceptSid) {
    try {
        await pool.query("DELETE FROM sessions WHERE (sess->>'userId')::int = $1 AND sid <> $2", [userId, exceptSid || '']);
        await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [userId]);
    } catch (e) { console.error('Błąd kasowania sesji:', e.message); }
}

// Serwowanie plików (CMR, podsumowania, zdjęcia pojazdów) z bazy danych
app.get('/api/files/:id', requireLogin, async (req, res) => {
    try {
        const r = await pool.query('SELECT mime, data FROM files WHERE id = $1', [parseInt(req.params.id)]);
        if (r.rows.length === 0) return res.status(404).send('Nie znaleziono pliku');
        res.set('Content-Type', r.rows[0].mime);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'private, max-age=31536000, immutable');
        res.send(r.rows[0].data);
    } catch (e) { res.status(500).send('Błąd pobierania pliku'); }
});

// Reset hasła e-mailem. W bazie zapisujemy tylko skrót jednorazowego tokenu.
const resetRequestLimits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of resetRequestLimits) if (v.until <= now) resetRequestLimits.delete(k); }, 10 * 60 * 1000);
app.post('/api/password/forgot', async (req, res) => {
    const login = String(req.body.login || '').trim().toLowerCase();
    if (!login || login.length > 255) return res.status(400).json({ error: 'Wpisz swój login lub e-mail.' });
    const key = req.ip + '|' + login, rate = resetRequestLimits.get(key);
    if (rate && rate.count >= 3 && rate.until > Date.now()) return res.status(429).json({ error: 'Za dużo próśb. Skontaktuj się bezpośrednio z szefem.' });
    if (rate && rate.until > Date.now()) rate.count++; else resetRequestLimits.set(key, { count: 1, until: Date.now() + 15 * 60 * 1000 });
    try {
        const user = await pool.query("SELECT id, username FROM users WHERE (LOWER(username) = $1 OR LOWER(email) = $1) AND status = 'approved'", [login]);
        if (user.rows.length) {
            const created = await pool.query("INSERT INTO password_reset_requests (user_id) VALUES ($1) ON CONFLICT (user_id) WHERE status = 'open' DO NOTHING RETURNING id", [user.rows[0].id]);
            if (created.rows.length) {
                const admins = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'manager') AND status = 'approved'");
                for (const admin of admins.rows) await addNotification(admin.id, 'Prośba o reset hasła', `Kierowca @${user.rows[0].username} prosi o reset hasła. Otwórz Zarządzanie.`, null, 'management');
            }
        }
        res.json({ success: true, message: 'Jeśli konto istnieje i jest aktywne, prośba trafiła do szefa. Skontaktuj się z nim też bezpośrednio, aby przyspieszyć reset.' });
    } catch (err) { console.error('Błąd zgłoszenia resetu hasła:', err.message); res.status(500).json({ error: 'Nie udało się zapisać prośby. Skontaktuj się bezpośrednio z szefem.' }); }
});

app.get('/api/password/reset-requests', requireAdmin, async (req, res) => {
    try {
        const r = await pool.query("SELECT pr.id, pr.user_id, pr.requested_at, u.username, u.email FROM password_reset_requests pr JOIN users u ON u.id = pr.user_id WHERE pr.status = 'open' AND ($1 = 'admin' OR u.role = 'driver') ORDER BY pr.requested_at ASC", [req.session.role]);
        res.json(r.rows);
    } catch (err) { res.status(500).json({ error: 'Nie udało się pobrać próśb.' }); }
});

app.post('/api/password/change', requireLogin, async (req, res) => {
    const password = String(req.body.password || ''), confirm = String(req.body.confirmPassword || '');
    if (password.length < 10 || password.length > 200) return res.status(400).json({ error: 'Hasło musi mieć co najmniej 10 znaków.' });
    if (password !== confirm) return res.status(400).json({ error: 'Hasła nie są identyczne.' });
    try {
        const hash = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET password = $1, must_change_password = false WHERE id = $2', [hash, req.session.userId]);
        await pool.query("DELETE FROM sessions WHERE (sess->>'userId')::int = $1 AND sid <> $2", [req.session.userId, req.sessionID]);
        await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [req.session.userId]);
        req.session.mustChangePassword = false;
        res.json({ success: true, message: 'Hasło zmienione. Możesz korzystać z aplikacji.' });
    } catch (err) { console.error('Błąd zmiany hasła:', err.message); res.status(500).json({ error: 'Nie udało się zmienić hasła.' }); }
});

app.post('/api/register', async (req, res) => {
    const { username, email, password, confirmPassword } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Uzupełnij wszystkie pola.' });
    if (password !== confirmPassword) return res.status(400).json({ error: 'Hasła nie są identyczne!' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Hasło musi mieć minimum 6 znaków.' });

    try {
        const nickTaken = await pool.query('SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
        if (nickTaken.rows.length > 0) return res.status(400).json({ error: 'Ten nick jest już zajęty.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
        const count = parseInt(userCountRes.rows[0].count);
        
        const role = count === 0 ? 'admin' : 'driver';
        const status = count === 0 ? 'approved' : 'pending';

        await pool.query('INSERT INTO users (username, email, password, role, status) VALUES ($1, $2, $3, $4, $5)', [username, email.toLowerCase().trim(), hashedPassword, role, status]);
        
        if (status === 'pending') {
            const admins = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager')");
            for (let adm of admins.rows) {
                await addNotification(adm.id, 'Nowy Kierowca', `Kierowca @${username} (${email}) zarejestrował się i oczekuje na zatwierdzenie konta.`, null, 'management');
            }
        }

        res.json({ success: true, message: status === 'pending' ? 'Konto oczekuje na akceptację Szefa!' : 'Konto Szefa utworzone!' });
    } catch (err) { res.status(400).json({ error: 'Użytkownik z tym adresem e-mail już istnieje.' }); }
});

// Ochrona przed zgadywaniem haseł: max 8 nieudanych prób / 15 min na parę IP + login.
const loginFails = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of loginFails) if (v.until < now) loginFails.delete(k);
}, 10 * 60 * 1000);

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Uzupełnij login/e-mail i hasło.' });

    const inputVal = email.toLowerCase().trim();
    const failKey = req.ip + '|' + inputVal;
    const fails = loginFails.get(failKey);
    if (fails && fails.count >= 8 && fails.until > Date.now()) {
        return res.status(429).json({ error: 'Za dużo nieudanych prób logowania. Spróbuj za kilkanaście minut.' });
    }
    const registerFail = () => {
        const cur = loginFails.get(failKey);
        if (cur && cur.until > Date.now()) cur.count++;
        else loginFails.set(failKey, { count: 1, until: Date.now() + 15 * 60 * 1000 });
    };

    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(username) = $1',
            [inputVal]
        );

        if (result.rows.length === 0) { registerFail(); return res.status(401).json({ error: 'Nieprawidłowy e-mail/login lub hasło.' }); }

        const user = result.rows[0];

        const match = await bcrypt.compare(password, user.password);
        if (!match) { registerFail(); return res.status(401).json({ error: 'Nieprawidłowy e-mail/login lub hasło.' }); }
        loginFails.delete(failKey);

        if (user.status === 'pending') return res.status(403).json({ error: 'Konto oczekuje na akceptację Szefa!' });
        if (user.status === 'fired') return res.status(403).json({ error: 'To konto zostało dezaktywowane przez Szefa.' });

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.mustChangePassword = Boolean(user.must_change_password);
        res.json({ success: true, mustChangePassword: req.session.mustChangePassword });
    } catch (err) { res.status(500).json({ error: 'Błąd logowania.' }); }
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const userRes = await pool.query('SELECT id, username, email, role, status, must_change_password FROM users WHERE id = $1', [req.session.userId]);
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'Użytkownik nie istnieje' });
        
        const user = userRes.rows[0];
        if (user.status === 'fired') {
            return req.session.destroy(() => res.status(401).json({ error: 'Konto dezaktywowane' }));
        }

        const kmRes = await pool.query(`
            SELECT SUM(distance) as total, COUNT(*) as deliveries 
            FROM jobs 
            WHERE user_id = $1 
            AND status = 'approved'
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_TIMESTAMP)
        `, [user.id]);

        const truckRes = await pool.query('SELECT * FROM trucks WHERE LOWER(driver_name) = LOWER($1) ORDER BY id LIMIT 1', [user.username]);
        const trailerRes = await pool.query('SELECT * FROM trailers WHERE LOWER(driver_name) = LOWER($1) ORDER BY id LIMIT 1', [user.username]);

        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            mustChangePassword: Boolean(user.must_change_password),
            monthlyKm: parseInt(kmRes.rows[0].total || 0),
            monthlyDeliveries: parseInt(kmRes.rows[0].deliveries || 0),
            limitKm: 6000,
            assignedTruck: truckRes.rows.length > 0 ? truckRes.rows[0] : null,
            assignedTrailer: trailerRes.rows.length > 0 ? trailerRes.rows[0] : null
        });
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania danych' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

app.get('/api/notifications', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        // przeczytane powiadomienia sprzątamy po 14 dniach
        await pool.query("DELETE FROM notifications WHERE user_id = $1 AND is_read = true AND created_at < NOW() - INTERVAL '14 days'", [req.session.userId]);
        // zwracamy przeczytane i nieprzeczytane (front sam liczy nieprzeczytane na liczniku)
        const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [req.session.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd powiadomień' }); }
});

app.put('/api/notifications/read', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [req.session.userId]);
        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Błąd aktualizacji' }); 
    }
});

app.put('/api/notifications/:id/read', requireLogin, async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd aktualizacji' }); }
});

app.delete('/api/notifications/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        await pool.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ success: true });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Błąd usuwania powiadomienia' }); 
    }
});

// =====================================================================
//  RANGI KIEROWCÓW
//  Rangi automatyczne liczą się z ZATWIERDZONYCH kilometrów (próg minKm).
//  Szef może ręcznie nadać dowolną rangę (też "specjalną", tylko ręczną) albo wrócić do "Auto".
//  Nazwy, progi, ikony (Font Awesome) i kolory zmienisz tylko tutaj.
// =====================================================================
const RANKS = [
    { name: 'Rekrut',                  minKm: 0,      icon: 'fa-seedling',       color: '#94a3b8' },
    { name: 'Kierowca',                minKm: 500,    icon: 'fa-road',           color: '#38bdf8' },
    { name: 'Kierowca Zawodowy',       minKm: 2500,   icon: 'fa-truck',          color: '#22c55e' },
    { name: 'Kierowca Międzynarodowy', minKm: 7500,   icon: 'fa-earth-europe',   color: '#14b8a6' },
    { name: 'Starszy Kierowca',        minKm: 15000,  icon: 'fa-medal',          color: '#a78bfa' },
    { name: 'Mistrz Szos',             minKm: 30000,  icon: 'fa-trophy',         color: '#f59e0b' },
    { name: 'Weteran Trasy',           minKm: 60000,  icon: 'fa-star',           color: '#fb923c' },
    { name: 'Legenda Mazren',          minKm: 100000, icon: 'fa-crown',          color: '#facc15' },
    { name: 'Dyspozytor',  manual: true,              icon: 'fa-headset',        color: '#f472b6' },
    { name: 'Instruktor',  manual: true,              icon: 'fa-chalkboard-user', color: '#fb7185' }
];

function autoRankIndex(km) {
    let idx = 0;
    RANKS.forEach((r, i) => { if (!r.manual && km >= r.minKm) idx = i; });
    return idx;
}

function rankFor(km, override) {
    const manual = Number.isInteger(override) && !!RANKS[override];
    const idx = manual ? override : autoRankIndex(km);
    const r = RANKS[idx];
    return { index: idx, name: r.name, icon: r.icon, color: r.color, manual };
}

// =====================================================================
//  WYMAGANIA DO DOŁĄCZENIA (zakładka "O nas") - edytowalne przez Szefa
//  Zapis w tabeli site_settings (klucz 'requirements'). GET jest publiczny (to informacja rekrutacyjna).
// =====================================================================
const DEFAULT_REQUIREMENTS = {
    badge: 'GRAMY NA 1.60!!!',
    badge_en: 'WE PLAY ON 1.60!!!',
    items: [
        { icon: 'fa-road',         title: 'Wymóg kilometrów miesięcznie', text: '6 000 km',
          title_en: 'Monthly distance requirement', text_en: '6,000 km' },
        { icon: 'fa-clock',        title: 'Godziny w ETS2', text: '250 h',
          title_en: 'Hours in ETS2', text_en: '250 h' },
        { icon: 'fa-gauge-high',   title: 'Jazda rzeczywista', text: 'Nie jeździmy wyścigów, tylko realistycznie (90 - 99 km/h)',
          title_en: 'Realistic driving', text_en: 'No racing, we drive realistically (90 - 99 km/h)' },
        { icon: 'fa-cake-candles', title: 'Wiek', text: 'min. 31 lat (czyt. od tyłu)',
          title_en: 'Age', text_en: 'min. 31 years old (read it backwards)' },
        { icon: 'fa-toolbox',      title: 'Posiadanie', text: 'Trucky lub Virtual Speditor',
          title_en: 'You need to have', text_en: 'Trucky or Virtual Speditor' },
        { icon: 'fa-user-tie',     title: 'Status', text: 'Bezrobotny',
          title_en: 'Status', text_en: 'Unemployed' },
        { icon: 'fa-truck',        title: 'Umiejętność', text: 'Odwzorowania zestawu 1:1',
          title_en: 'Skill', text_en: 'Recreating the truck and trailer set 1:1' },
        { icon: 'fa-file-zipper',  title: 'Posiadanie WinRAR-a', text: 'i umiejętność wypakowywania modów',
          title_en: 'You need WinRAR', text_en: 'and the ability to unpack mods' },
        { icon: 'fa-camera',       title: 'Umiejętność', text: 'Wykonywanie zdjęć na średnim/wysokim poziomie',
          title_en: 'Skill', text_en: 'Taking medium/high quality screenshots' },
        { icon: 'fa-map',          title: 'Dodatkowo', text: 'DLC mapowe i ProMods (lub ProMods + Poland Rebuilding)',
          title_en: 'Additionally', text_en: 'Map DLCs and ProMods (or ProMods + Poland Rebuilding)' }
    ]
};

// Zapisane wcześniej wymagania bez angielskiego: jeśli pasują do domyślnych, dopełniamy tłumaczenie.
function withEnglishFallback(data) {
    const defs = DEFAULT_REQUIREMENTS.items;
    const out = { badge: data.badge || '', badge_en: data.badge_en || '', items: [] };
    if (!out.badge_en && out.badge === DEFAULT_REQUIREMENTS.badge) out.badge_en = DEFAULT_REQUIREMENTS.badge_en;
    for (const it of (data.items || [])) {
        const copy = { ...it };
        if (!copy.title_en && !copy.text_en) {
            const d = defs.find(x => x.title === it.title && x.text === it.text);
            if (d) { copy.title_en = d.title_en; copy.text_en = d.text_en; }
        }
        out.items.push(copy);
    }
    return out;
}

app.get('/api/requirements', async (req, res) => {
    try {
        const r = await pool.query("SELECT value FROM site_settings WHERE key = 'requirements'");
        if (r.rows.length > 0) return res.json(withEnglishFallback(JSON.parse(r.rows[0].value)));
    } catch (e) { /* brak tabeli / uszkodzony zapis: pokazujemy domyślne */ }
    res.json(DEFAULT_REQUIREMENTS);
});

app.put('/api/requirements', requireAdmin, async (req, res) => {
    const badge = String(req.body.badge || '').trim().slice(0, 60);
    const badgeEn = String(req.body.badge_en || '').trim().slice(0, 60);
    const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 40) : null;
    if (!items) return res.status(400).json({ error: 'Nieprawidłowe dane.' });
    const clean = [];
    for (const it of items) {
        const icon = /^fa-[a-z0-9-]{1,40}$/.test(String((it && it.icon) || '')) ? it.icon : 'fa-circle-check';
        const title = String((it && it.title) || '').trim().slice(0, 80);
        const text = String((it && it.text) || '').trim().slice(0, 300);
        const titleEn = String((it && it.title_en) || '').trim().slice(0, 80);
        const textEn = String((it && it.text_en) || '').trim().slice(0, 300);
        if (!title && !text && !titleEn && !textEn) continue;
        clean.push({ icon, title, text, title_en: titleEn, text_en: textEn });
    }
    try {
        await pool.query(
            `INSERT INTO site_settings (key, value, updated_at) VALUES ('requirements', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify({ badge, badge_en: badgeEn, items: clean })]);
        res.json({ success: true });
    } catch (e) {
        console.error('Błąd zapisu wymagań:', e.message);
        res.status(500).json({ error: 'Błąd zapisu wymagań.' });
    }
});

// Public recruitment applications. The current open/closed state is stored with the other site settings.
app.get('/api/recruitment/settings', async (req, res) => {
    try {
        const result = await pool.query("SELECT value FROM site_settings WHERE key = 'recruitment_open'");
        const isOpen = result.rows.length === 0 || result.rows[0].value !== 'false';
        res.json({ isOpen });
    } catch (e) {
        console.error('Błąd odczytu statusu rekrutacji:', e.message);
        res.status(500).json({ error: 'Nie udało się pobrać statusu rekrutacji.' });
    }
});

app.put('/api/recruitment/settings', requireAdmin, async (req, res) => {
    const body = req.body || {};
    if (typeof body.isOpen !== 'boolean') return res.status(400).json({ error: 'Nieprawidłowy status rekrutacji.' });
    try {
        await pool.query(
            "INSERT INTO site_settings (key, value, updated_at) VALUES ('recruitment_open', $1, NOW()) " +
            "ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
            [String(body.isOpen)]
        );
        res.json({ success: true, isOpen: body.isOpen });
    } catch (e) {
        console.error('Błąd zapisu statusu rekrutacji:', e.message);
        res.status(500).json({ error: 'Nie udało się zapisać statusu rekrutacji.' });
    }
});

app.post('/api/recruitment/applications', async (req, res) => {
    const body = req.body || {};
    const fullName = String(body.fullName || '').trim();
    const discordName = String(body.discordName || '').trim();
    const age = Number(body.age);
    const hours = Number(body.ets2Hours);
    const about = String(body.about || '').trim();
    const skills = String(body.skills || '').trim();
    const previousCompanies = String(body.previousCompanies || '').trim();
    const dlcs = String(body.dlcs || '').trim();
    const ets2Apps = String(body.ets2Apps || '').trim();
    const motivation = String(body.motivation || '').trim();
    const signature = String(body.signature || '').trim();
    const steamUrl = String(body.steamUrl || '').trim();
    const sentenceCount = (about.match(/[.!?]+(?=\s|$)/g) || []).length;

    if (fullName.length < 2 || fullName.length > 150) return res.status(400).json({ error: 'Podaj imię (maks. 150 znaków).' });
    if (discordName.length < 2 || discordName.length > 100) return res.status(400).json({ error: 'Podaj nick Discord (maks. 100 znaków).' });
    if (!Number.isInteger(age) || age < 13 || age > 100) return res.status(400).json({ error: 'Wiek musi być liczbą od 13 do 100.' });
    if (body.ets2Hours == null || String(body.ets2Hours).trim() === '' || !Number.isInteger(hours) || hours < 0 || hours > 200000) {
        return res.status(400).json({ error: 'Podaj poprawną liczbę godzin w ETS2.' });
    }
    if (about.length < 30 || about.length > 3000 || sentenceCount < 3) return res.status(400).json({ error: 'Opisz siebie w co najmniej 3 zdaniach (maks. 3000 znaków).' });
    if (skills.length < 10 || skills.length > 3000) return res.status(400).json({ error: 'Opisz swoje umiejętności (maks. 3000 znaków).' });
    if (!previousCompanies || previousCompanies.length > 3000) return res.status(400).json({ error: 'Opisz wcześniejsze firmy lub wpisz „Brak” (maks. 3000 znaków).' });
    if (!dlcs || dlcs.length > 3000) return res.status(400).json({ error: 'Wpisz posiadane DLC (maks. 3000 znaków).' });
    if (!ets2Apps || ets2Apps.length > 2000) return res.status(400).json({ error: 'Wpisz używane programy lub narzędzia (maks. 2000 znaków).' });
    if (motivation.length < 20 || motivation.length > 3000) return res.status(400).json({ error: 'Napisz, dlaczego chcesz dołączyć do firmy (maks. 3000 znaków).' });
    if (signature.length < 2 || signature.length > 150) return res.status(400).json({ error: 'Podaj podpis kandydata (maks. 150 znaków).' });
    if (steamUrl.length > 500) return res.status(400).json({ error: 'Link Steam jest za długi.' });
    try {
        const url = new URL(steamUrl);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || !['steamcommunity.com', 'www.steamcommunity.com', 's.team'].includes(host) || url.username || url.password) throw new Error('invalid URL');
    } catch (_) {
        return res.status(400).json({ error: 'Podaj poprawny link HTTPS do profilu Steam.' });
    }

    try {
        const settings = await pool.query("SELECT value FROM site_settings WHERE key = 'recruitment_open'");
        if (settings.rows.length && settings.rows[0].value === 'false') return res.status(403).json({ error: 'Rekrutacja jest obecnie zamknięta.' });
        const result = await pool.query(
            "INSERT INTO recruitment_applications (full_name, discord_name, age, ets2_hours, about, skills, previous_companies, source, dlcs, ets2_apps, motivation, signature, steam_url) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id",
            [fullName, discordName, age, hours, about, skills, previousCompanies, '', dlcs, ets2Apps, motivation, signature, steamUrl]
        );
        try {
            const staff = await pool.query("SELECT id FROM users WHERE role IN ('admin', 'manager') AND status = 'approved'");
            await Promise.all(staff.rows.map(user => addNotification(user.id, 'Nowe podanie rekrutacyjne', 'Wpłynęło nowe podanie. Otwórz zakładkę Rekrutacja, aby je sprawdzić.', null, 'recruitment')));
        } catch (notificationError) {
            console.error('Nie udało się powiadomić kadry o nowym podaniu:', notificationError.message);
        }
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (e) {
        console.error('Błąd zapisu podania rekrutacyjnego:', e.message);
        res.status(500).json({ error: 'Nie udało się zapisać podania. Spróbuj ponownie później.' });
    }
});
app.get('/api/recruitment/applications', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, full_name, discord_name, age, ets2_hours, about, skills, previous_companies, dlcs, ets2_apps, motivation, signature, steam_url, status, created_at " +
            "FROM recruitment_applications ORDER BY created_at DESC LIMIT 200"
        );
        res.json(result.rows);
    } catch (e) {
        console.error('Błąd pobierania podań:', e.message);
        res.status(500).json({ error: 'Nie udało się pobrać podań.' });
    }
});

app.put('/api/recruitment/applications/:id/status', requireAdmin, async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const status = String((req.body || {}).status || '');
    if (!Number.isInteger(id) || id < 1 || !['new', 'reviewing', 'accepted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Nieprawidłowy status podania.' });
    }
    try {
        const result = await pool.query('UPDATE recruitment_applications SET status = $1 WHERE id = $2 RETURNING id', [status, id]);
        if (!result.rowCount) return res.status(404).json({ error: 'Nie znaleziono podania.' });
        res.json({ success: true });
    } catch (e) {
        console.error('Błąd aktualizacji podania:', e.message);
        res.status(500).json({ error: 'Nie udało się zmienić statusu podania.' });
    }
});
// =====================================================================
//  OPIS FIRMY (zakładka "O nas") - edytowalny przez Szefa/Kierownika.
//  GET jest publiczny, bo opis jest widoczny także dla gości.
// =====================================================================
const DEFAULT_ABOUT = {
    description: 'to wirtualna firma transportowa działająca w świecie Euro Truck Simulator 2, stworzona 20 września 2026 roku. Naszym celem jest stworzenie aktywnej i zgranej społeczności, w której wspólnie przemierzamy europejskie drogi, realizujemy różnorodne zlecenia oraz uczestniczymy w firmowych konwojach i wydarzeniach. Serwer jest przeznaczony dla każdego powyżej 31. (czytaj od tyłu) roku życia. Stawiamy na realistyczność, dobrą atmosferę, aktywność, kulturę jazdy i przede wszystkim wspólną zabawę. Dołącz do Mazren Spedition i rozpocznij swoją przygodę z transportem razem z nami!',
    description_en: 'is a virtual trucking company operating in the world of Euro Truck Simulator 2, founded on 20 September 2026. Our goal is to build an active, close-knit community where we drive across Europe together, complete a wide variety of jobs and take part in company convoys and events. The server is intended for everyone over 31 years of age (read it backwards). We focus on realism, a great atmosphere, activity, driving etiquette and, above all, having fun together. Join Mazren Spedition and start your trucking adventure with us!',
    social_title: 'ZNAJDŹ NAS W SIECI',
    social_title_en: 'FIND US ONLINE',
    tiktok_url: 'https://www.tiktok.com/@TWOJ_PROFIL',
    tiktok_label: 'Obserwuj na TikTok',
    tiktok_label_en: 'Follow us on TikTok'
};

app.get('/api/about', async (req, res) => {
    try {
        const r = await pool.query("SELECT value FROM site_settings WHERE key = 'about'");
        if (r.rows.length > 0) {
            const saved = JSON.parse(r.rows[0].value);
            return res.json({ ...DEFAULT_ABOUT, ...(saved && typeof saved === 'object' ? saved : {}) });
        }
    } catch (e) { /* brak tabeli / uszkodzony zapis: pokazujemy domyślne */ }
    res.json(DEFAULT_ABOUT);
});

app.put('/api/about', requireAdmin, async (req, res) => {
    const cleanText = (value, max) => String(value == null ? '' : value).trim().slice(0, max);
    const about = {
        description: cleanText(req.body.description, 3000),
        description_en: cleanText(req.body.description_en, 3000),
        social_title: cleanText(req.body.social_title, 100),
        social_title_en: cleanText(req.body.social_title_en, 100),
        tiktok_url: cleanText(req.body.tiktok_url, 500),
        tiktok_label: cleanText(req.body.tiktok_label, 80),
        tiktok_label_en: cleanText(req.body.tiktok_label_en, 80)
    };

    if (!about.description) return res.status(400).json({ error: 'Opis po polsku nie może być pusty.' });
    if (about.tiktok_url) {
        try {
            const url = new URL(about.tiktok_url);
            if (url.protocol !== 'https:' || !/(^|\.)tiktok\.com$/i.test(url.hostname) || url.username || url.password) throw new Error('invalid URL');
        } catch (_) {
            return res.status(400).json({ error: 'Wklej poprawny link HTTPS prowadzący do domeny TikTok.' });
        }
    }

    try {
        await pool.query(
            `INSERT INTO site_settings (key, value, updated_at) VALUES ('about', $1, NOW())
             ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
            [JSON.stringify(about)]
        );
        res.json({ success: true });
    } catch (e) {
        console.error('Błąd zapisu opisu firmy:', e.message);
        res.status(500).json({ error: 'Błąd zapisu opisu firmy.' });
    }
});

// =====================================================================
//  TRYB GOŚCIA - publiczny, tylko do odczytu podgląd firmy (bez logowania).
//  Gość widzi: łączne kilometry i dostawy (tylko zatwierdzone), liczbę kierowców, ranking (top 10),
//  flotę (modele, zdjęcia, dane techniczne) oraz wymagania. NIE widzi: pieniędzy, wydatków, tras,
//  dokumentów, tablic rejestracyjnych ani przydziałów kierowców.
//  PUBLIC_SHOW_RANKING = false ukrywa nicki kierowców przed gośćmi.
// =====================================================================
const PUBLIC_SHOW_RANKING = true;
let publicOverviewCache = { t: 0, data: null };

// Zdjęcia pojazdów zapisane różnymi metodami: w bazie (/api/files/ID), starsze w folderze /uploads/ albo jako pełny adres.
function toPublicPhoto(p) {
    const str = String(p || '').trim();
    if (!str) return null;
    const m = /(?:^|\/)api\/files\/(\d+)$/.exec(str);
    if (m) return '/api/public/photo/' + m[1];                                   // plik w bazie (publiczna, ograniczona trasa)
    if (/^\/uploads\/[\w.\-%() ]+$/.test(str) && !str.includes('..')) return str;  // starszy plik statyczny
    // zdjęcia startowej floty leżą jako pliki statyczne w folderze public (np. /scaniarprzod.jpg) - są i tak publiczne
    if (/^\/(?:[\w.\-%() ]+\/)?[\w.\-%() ]+\.(?:jpe?g|png|webp|gif|avif)$/i.test(str) && !str.includes('..')) return str;
    if (/^https?:\/\/[^\s"'<>]+$/i.test(str)) return str;                         // pełny adres
    return null;
}

app.get('/api/public/overview', async (req, res) => {
    if (publicOverviewCache.data && Date.now() - publicOverviewCache.t < 60 * 1000) return res.json(publicOverviewCache.data);
    try {
        const jobs = await pool.query("SELECT COALESCE(SUM(distance), 0) AS km, COUNT(*) AS n FROM jobs WHERE status = 'approved'");
        const drivers = await pool.query("SELECT COUNT(*) AS n FROM users WHERE status = 'approved'");
        let ranking = [];
        if (PUBLIC_SHOW_RANKING) {
            const r = await pool.query(
                `SELECT u.username, u.rank_override, SUM(j.distance) AS km, COUNT(j.id) AS deliveries
                 FROM jobs j JOIN users u ON u.id = j.user_id
                 WHERE j.status = 'approved'
                 GROUP BY u.username, u.rank_override ORDER BY km DESC LIMIT 10`);
            ranking = r.rows.map(d => {
                const km = parseInt(d.km) || 0;
                return { username: d.username, km, deliveries: parseInt(d.deliveries) || 0, rank: rankFor(km, d.rank_override) };
            });
        }
        const trucks = await pool.query(
            `SELECT truck_model AS model, MAX(NULLIF(cabin, '')) AS cabin, MAX(NULLIF(engine, '')) AS engine,
                    MAX(NULLIF(gearbox, '')) AS gearbox, COUNT(*) AS count
             FROM trucks GROUP BY truck_model ORDER BY LOWER(truck_model)`);
        const truckPhotos = await pool.query(
            `SELECT truck_model AS model, photo AS p FROM trucks WHERE photo IS NOT NULL AND photo <> ''
             UNION ALL SELECT truck_model, photo_back FROM trucks WHERE photo_back IS NOT NULL AND photo_back <> ''`);
        const trailers = await pool.query(
            `SELECT trailer_model AS model, MAX(NULLIF(description, '')) AS description
             FROM trailers GROUP BY trailer_model ORDER BY LOWER(trailer_model)`);
        const trailerPhotos = await pool.query(
            `SELECT trailer_model AS model, photo AS p FROM trailers WHERE photo IS NOT NULL AND photo <> ''
             UNION ALL SELECT trailer_model, photo_back FROM trailers WHERE photo_back IS NOT NULL AND photo_back <> ''`);
        const photosOf = rows => {
            const m = new Map();
            for (const r of rows) {
                const u = toPublicPhoto(r.p);
                if (!u) continue;
                if (!m.has(r.model)) m.set(r.model, []);
                if (!m.get(r.model).includes(u)) m.get(r.model).push(u);
            }
            return m;
        };
        const tp = photosOf(truckPhotos.rows), rp = photosOf(trailerPhotos.rows);
        const data = {
            totalKm: parseInt(jobs.rows[0].km) || 0,
            totalDeliveries: parseInt(jobs.rows[0].n) || 0,
            drivers: parseInt(drivers.rows[0].n) || 0,
            ranking,
            trucks: trucks.rows.map(t => ({ model: t.model, photo: (tp.get(t.model) || [])[0] || null, photos: tp.get(t.model) || [], cabin: t.cabin, engine: t.engine, gearbox: t.gearbox, count: parseInt(t.count) || 1 })),
            trailers: trailers.rows.map(t => ({ model: t.model, photo: (rp.get(t.model) || [])[0] || null, photos: rp.get(t.model) || [], description: t.description || '' }))
        };
        publicOverviewCache = { t: Date.now(), data };
        res.json(data);
    } catch (e) {
        console.error('Błąd podglądu publicznego:', e.message);
        res.status(500).json({ error: 'Błąd pobierania danych' });
    }
});

// Zdjęcia pojazdów dla gości: wyłącznie pliki, które faktycznie są zdjęciami ciężarówek/naczep
// (pozostałe pliki, np. CMR i zrzuty tras, nadal wymagają logowania).
app.get('/api/public/photo/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (!Number.isInteger(id)) return res.status(404).send('Nie znaleziono');
        const r = await pool.query(
            `SELECT f.mime, f.data FROM files f WHERE f.id = $1 AND (
                EXISTS (SELECT 1 FROM trucks t WHERE t.photo LIKE '%/api/files/' || f.id::text OR t.photo_back LIKE '%/api/files/' || f.id::text)
                OR EXISTS (SELECT 1 FROM trailers t WHERE t.photo LIKE '%/api/files/' || f.id::text OR t.photo_back LIKE '%/api/files/' || f.id::text))`, [id]);
        if (r.rows.length === 0) return res.status(404).send('Nie znaleziono');
        res.set('Content-Type', r.rows[0].mime);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(r.rows[0].data);
    } catch (e) { res.status(500).send('Błąd pobierania zdjęcia'); }
});

app.get('/api/ranks', requireLogin, (req, res) => {
    res.json({ ranks: RANKS.map(r => ({ name: r.name, minKm: r.minKm || 0, manual: !!r.manual, icon: r.icon, color: r.color })) });
});

app.get('/api/my-rank', requireLogin, async (req, res) => {
    try {
        const r = await pool.query(
            `SELECT u.rank_override, COALESCE((SELECT SUM(distance) FROM jobs WHERE user_id = u.id AND status = 'approved'), 0) AS km
             FROM users u WHERE u.id = $1`, [req.session.userId]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Brak użytkownika' });
        const km = parseInt(r.rows[0].km) || 0;
        const info = rankFor(km, r.rows[0].rank_override);
        const autoIdx = autoRankIndex(km);
        const next = RANKS.slice(autoIdx + 1).find(x => !x.manual) || null;
        res.json({ ...info, km, current_min: RANKS[autoIdx].minKm, next: next ? { name: next.name, minKm: next.minKm } : null });
    } catch (e) { res.status(500).json({ error: 'Błąd rangi' }); }
});

app.get('/api/users', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        const result = await pool.query(
            `SELECT u.id, u.username, u.email, u.role, u.status, u.rank_override,
                    COALESCE((SELECT SUM(distance) FROM jobs j WHERE j.user_id = u.id AND j.status = 'approved'), 0) AS approved_km
             FROM users u ORDER BY u.id DESC`);
        res.json(result.rows.map(u => ({
                    id: u.id, username: u.username, email: u.email, role: u.role, status: u.status,
            approved_km: parseInt(u.approved_km) || 0,
            rank: rankFor(parseInt(u.approved_km) || 0, u.rank_override)
        })));
    } catch (err) { res.status(500).json({ error: 'Błąd użytkowników' }); }
});

// Szef nadaje rangę ręcznie (rank: numer z listy /api/ranks) albo zdejmuje ją (rank: null / "auto").
app.put('/api/users/:id/rank', requireAdmin, async (req, res) => {
    const v = req.body.rank;
    let val = null;
    if (v !== null && v !== undefined && v !== '' && v !== 'auto') {
        val = parseInt(v);
        if (!Number.isInteger(val) || !RANKS[val]) return res.status(400).json({ error: 'Nieprawidłowa ranga.' });
    }
    try {
        const r = await pool.query('UPDATE users SET rank_override = $1 WHERE id = $2 RETURNING id', [val, req.params.id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono kierowcy.' });
        if (val !== null) await addNotification(req.params.id, 'Nowa ranga', `Szef nadał Ci rangę: ${RANKS[val].name}`, null, 'jobs');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Błąd zmiany rangi' }); }
});

// =====================================================================
//  IMPORT HISTORII TRAS (np. z Trucksbook) - tylko Szef.
//  rows: [{ username, date, start_city, end_city, cargo, distance, income, line }], dry_run: true = tylko sprawdź
// =====================================================================
function parseImportDate(v) {
    const str = String(v || '').trim();
    let y, m, d;
    let mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(str);
    if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/.exec(str))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
    else return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

app.post('/api/admin/import-jobs', requireAdmin, async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 2000) : [];
    const dryRun = req.body.dry_run === true;
    if (rows.length === 0) return res.status(400).json({ error: 'Brak wierszy do importu.' });

    const client = await pool.connect();
    try {
        const users = await client.query('SELECT id, username FROM users');
        const byName = new Map(users.rows.map(u => [u.username.toLowerCase(), u.id]));
        let imported = 0, skipped = 0;
        const errors = [];

        await client.query('BEGIN');
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i] || {};
            const line = r.line || (i + 1);
            const uid = byName.get(String(r.username || '').trim().toLowerCase());
            const start = String(r.start_city || '').trim().slice(0, 255);
            const end = String(r.end_city || '').trim().slice(0, 255);
            const cargo = String(r.cargo || '').trim().slice(0, 255) || 'Standard';
            const dist = Math.round(Number(r.distance));
            const inc = Math.max(0, Math.round(Number(r.income) || 0));
            const date = parseImportDate(r.date);

            if (!uid) { errors.push(`Wiersz ${line}: nie ma kierowcy "${r.username}" (kierowca musi mieć konto na stronie)`); continue; }
            if (!start || !end) { errors.push(`Wiersz ${line}: brak miasta startu lub celu`); continue; }
            if (!Number.isFinite(dist) || dist <= 0 || dist > 20000) { errors.push(`Wiersz ${line}: zły dystans`); continue; }
            if (!date) { errors.push(`Wiersz ${line}: zła data "${r.date}" (użyj np. 15.09.2026 albo 2026-09-15)`); continue; }

            const dup = await client.query(
                'SELECT 1 FROM jobs WHERE user_id = $1 AND start_city = $2 AND end_city = $3 AND distance = $4 AND created_at::date = $5::date LIMIT 1',
                [uid, start, end, dist, date]);
            if (dup.rows.length > 0) { skipped++; continue; }

            await client.query(
                `INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, income, cmr_file, summary_photo, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, '', '', 'approved', $7::date + TIME '12:00')`,
                [uid, start, end, cargo, dist, inc, date]);
            imported++;
        }
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        res.json({ success: true, dry_run: dryRun, imported, skipped, errors });
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Błąd importu tras:', e.message);
        res.status(500).json({ error: 'Błąd importu tras (nic nie zapisano).' });
    } finally { client.release(); }
});

// Nadawanie ról: tylko Szef. Zmiana wylogowuje użytkownika, żeby nowa rola zadziałała od razu po ponownym logowaniu.
const ROLE_LABELS = { driver: 'Kierowca', manager: 'Kierownik', admin: 'Szef' };
app.put('/api/users/:id/role', requireLogin, async (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Role może nadawać tylko Szef.' });
    const role = String(req.body.role || '');
    const id = parseInt(req.params.id);
    if (!ROLE_LABELS[role]) return res.status(400).json({ error: 'Nieprawidłowa rola.' });
    if (id === req.session.userId) return res.status(400).json({ error: 'Nie możesz zmienić własnej roli.' });
    try {
        const u = await pool.query('SELECT id, username, role, status FROM users WHERE id = $1', [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono użytkownika.' });
        const target = u.rows[0];
        if (target.status !== 'approved') return res.status(400).json({ error: 'Rolę można nadać tylko aktywnemu (zatwierdzonemu) kontu.' });
        if (target.role === role) return res.json({ success: true });
        if (target.role === 'admin' && role !== 'admin') {
            const others = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'approved' AND id <> $1", [id]);
            if (parseInt(others.rows[0].n) === 0) return res.status(400).json({ error: 'W firmie musi zostać przynajmniej jeden Szef.' });
        }
        await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
        await addNotification(id, 'Zmiana roli', `Twoja rola w firmie to teraz: ${ROLE_LABELS[role]}. Zaloguj się ponownie, żeby zmiana zadziałała.`, null, 'jobs');
        await killUserSessions(id);
        res.json({ success: true });
    } catch (e) {
        console.error('Błąd zmiany roli:', e.message);
        res.status(500).json({ error: 'Błąd zmiany roli.' });
    }
});

app.put('/api/users/:id/approve', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['approved', req.params.id]);
        await addNotification(req.params.id, 'Konto Aktywne', 'Twoje konto zostało zatwierdzone przez Szefa!', null, 'jobs');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd zatwierdzania' }); }
});

function randomPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    let out = '';
    for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
    return out;
}

// ZWOLNIENIE kierowcy: blokuje konto, zwalnia pojazdy, ale ZACHOWUJE jego trasy i statystyki firmy.
app.put('/api/users/:id/fire', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    try {
        const u = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
        if (u.rows[0].role === 'admin') return res.status(400).json({ error: 'Nie można zwolnić konta Szefa.' });
        if (!canManageUser(req.session.role, u.rows[0].role)) return res.status(403).json({ error: 'Kierownika może zwolnić tylko Szef.' });

        const username = u.rows[0].username;
        await pool.query("UPDATE users SET status = 'fired' WHERE id = $1", [id]);
        await pool.query("UPDATE trucks SET driver_name = 'Wolne' WHERE LOWER(driver_name) = LOWER($1)", [username]);
        await pool.query("UPDATE trailers SET driver_name = 'Wolne' WHERE LOWER(driver_name) = LOWER($1)", [username]);
        await pool.query(
            "UPDATE dispatches SET status = 'W wolnym obiegu', accepted_by_id = NULL, accepted_by_username = NULL WHERE accepted_by_id = $1 AND status = 'W trakcie'",
            [id]
        );
        await killUserSessions(id);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Błąd zwalniania kierowcy' });
    }
});

// ZMIANA HASŁA przez Szefa (np. gdy kierowca zapomni). Puste hasło = wygeneruj losowe.
app.put('/api/users/:id/password', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    let pw = (req.body.password || '').trim();
    let generated = false;
    if (!pw) { pw = randomPassword(); generated = true; }
    if (pw.length < 6) return res.status(400).json({ error: 'Hasło musi mieć minimum 6 znaków.' });

    try {
        const u = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
        if (id !== req.session.userId && !canManageUser(req.session.role, u.rows[0].role)) {
            return res.status(403).json({ error: 'Hasło Szefa lub Kierownika może zmienić tylko Szef (albo on sam).' });
        }

        const hashed = await bcrypt.hash(pw, 10);
        await pool.query('UPDATE users SET password = $1, must_change_password = true WHERE id = $2', [hashed, id]);
        await pool.query("UPDATE password_reset_requests SET status = 'resolved' WHERE user_id = $1 AND status = 'open'", [id]);
        await killUserSessions(id, req.sessionID);
        res.json({ success: true, password: generated ? pw : undefined });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Błąd zmiany hasła' });
    }
});

// TRWAŁE USUNIĘCIE - tylko dla kont oczekujących lub już zwolnionych.
// Uwaga: kasuje też trasy i wydatki tego użytkownika (ON DELETE CASCADE w bazie).
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id);
    if (id === req.session.userId) return res.status(400).json({ error: 'Nie możesz usunąć własnego konta.' });
    try {
        const u = await pool.query('SELECT role, status FROM users WHERE id = $1', [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });
        if (u.rows[0].role === 'admin') return res.status(400).json({ error: 'Nie można usunąć konta Szefa.' });
        if (!canManageUser(req.session.role, u.rows[0].role)) return res.status(403).json({ error: 'Kierownika może usunąć tylko Szef.' });
        if (u.rows[0].status === 'approved') return res.status(400).json({ error: 'Najpierw zwolnij kierowcę, potem możesz usunąć konto na stałe.' });

        await killUserSessions(id);
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania' }); }
});

app.get('/api/documents', requireLogin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM documents ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania dokumentów' }); }
});

app.post('/api/documents', upload.single('doc_file'), async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    const { title, category, content } = req.body;
    let fileUrl = null;

    try {
        fileUrl = await saveFile(req.file);
        await pool.query(
            'INSERT INTO documents (title, category, content, file_url) VALUES ($1, $2, $3, $4)',
            [title, category || 'Regulamin', content || '', fileUrl]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd dodawania dokumentu' }); }
});

app.delete('/api/documents/:id', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM documents WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania dokumentu' }); }
});

app.get('/api/dispatches', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        let query = '';
        let params = [];

        if (isStaff(req.session.role)) {
            query = 'SELECT * FROM dispatches ORDER BY id DESC';
        } else {
            query = 'SELECT * FROM dispatches WHERE assigned_to = $1 OR assigned_to = $2 OR accepted_by_id = $3 ORDER BY id DESC';
            params = ['Wszyscy', req.session.username, req.session.userId];
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania zleceń' }); }
});

app.post('/api/dispatches', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    const { assigned_to, start_city, end_city, truck_name, notes, start_country, end_country } = req.body;
    try {
        const newDispatch = await pool.query(
            'INSERT INTO dispatches (assigned_to, start_city, end_city, truck_name, notes, status, start_country, end_country) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [assigned_to || 'Wszyscy', start_city, end_city, truck_name || 'Standardowy Zestaw', notes || '', 'W wolnym obiegu', countryCode(start_country), countryCode(end_country)]
        );
        
        const newDispatchId = newDispatch.rows[0].id;

        if (assigned_to && assigned_to !== 'Wszyscy') {
            const targetUser = await pool.query('SELECT id FROM users WHERE username = $1', [assigned_to]);
            if (targetUser.rows.length > 0) {
                await addNotification(
                    targetUser.rows[0].id, 
                    'Nowe Zlecenie', 
                    `Szef przydzielił Ci nową trasę: ${start_city} ➔ ${end_city}`, 
                    newDispatchId, 
                    'dispatch'
                );
            }
        }

        res.json({ success: true, id: newDispatchId });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Błąd tworzenia zlecenia' }); 
    }
});

app.put('/api/dispatches/:id', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    const { assigned_to, start_city, end_city, truck_name, notes, start_country, end_country } = req.body;
    try {
        await pool.query(
            'UPDATE dispatches SET assigned_to = $1, start_city = $2, end_city = $3, truck_name = $4, notes = $5, start_country = $6, end_country = $7 WHERE id = $8',
            [assigned_to || 'Wszyscy', start_city, end_city, truck_name, notes || '', countryCode(start_country), countryCode(end_country), req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd edycji zlecenia' }); }
});

app.delete('/api/dispatches/:id', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM dispatches WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania zlecenia' }); }
});

app.put('/api/dispatches/:id/accept', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        // Jedno zapytanie = atomowo: zlecenie musi być wolne i przeznaczone dla tego kierowcy (albo dla Wszystkich).
        const upd = await pool.query(
            `UPDATE dispatches SET status = 'W trakcie', accepted_by_id = $1, accepted_by_username = $2
             WHERE id = $3 AND status = 'W wolnym obiegu' AND (assigned_to = 'Wszyscy' OR assigned_to = $2)
             RETURNING id`,
            [req.session.userId, req.session.username, req.params.id]
        );
        if (upd.rows.length > 0) return res.json({ success: true });

        const cur = await pool.query('SELECT assigned_to, status, accepted_by_id FROM dispatches WHERE id = $1', [req.params.id]);
        if (cur.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono zlecenia' });
        const d = cur.rows[0];
        if (d.accepted_by_id === req.session.userId) return res.json({ success: true });
        if (d.assigned_to !== 'Wszyscy' && d.assigned_to !== req.session.username) {
            return res.status(403).json({ error: 'To zlecenie jest przypisane do innego kierowcy!' });
        }
        res.status(409).json({ error: 'To zlecenie zostało już przyjęte przez innego kierowcę.' });
    } catch (err) { res.status(500).json({ error: 'Błąd akceptacji' }); }
});

app.post('/api/dispatches/:id/complete', upload.fields([{ name: 'cmr_file' }, { name: 'summary_photo' }]), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    
    const { distance, income, cargo } = req.body;
    const parsedDist = parseInt(distance) || 0;
    const parsedInc = parseInt(income) || 0;

    if (parsedDist <= 0) return res.status(400).json({ error: 'Podaj prawidłowy dystans w km.' });

    let cmrPath = '';
    let summaryPath = '';

    try {
        const dispRes = await pool.query('SELECT * FROM dispatches WHERE id = $1', [req.params.id]);
        if (dispRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono zlecenia' });
        const disp = dispRes.rows[0];

        if (!isStaff(req.session.role) && disp.accepted_by_id !== req.session.userId) {
            return res.status(403).json({ error: 'To zlecenie nie zostało przyjęte przez Ciebie.' });
        }

        // pliki zapisujemy w bazie (trwale), a w trasie trzymamy tylko link /api/files/ID
        if (req.files && req.files['cmr_file']) cmrPath = await saveFile(req.files['cmr_file'][0]);
        if (req.files && req.files['summary_photo']) summaryPath = await saveFile(req.files['summary_photo'][0]);

        await pool.query(
            'INSERT INTO jobs (user_id, start_city, end_city, start_country, end_country, cargo, distance, income, cmr_file, summary_photo, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
            [req.session.userId, disp.start_city, disp.end_city, disp.start_country, disp.end_country, cargo || 'Standard', parsedDist, parsedInc, cmrPath, summaryPath, 'pending']
        );

        await pool.query('DELETE FROM dispatches WHERE id = $1', [req.params.id]);

        const admins = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager')");
        for (let adm of admins.rows) {
            await addNotification(adm.id, 'Nowy Raport Trasy', `Kierowca @${req.session.username} przesłał raport trasy do weryfikacji.`, null, 'jobs');
        }

        res.json({ success: true });
    } catch (err) { console.error('Błąd raportowania trasy:', err);
        res.status(500).json({ error: 'Błąd raportowania trasy (sprawdź rozmiar i typ pliku).' }); }
});

app.get('/api/expenses', requireLogin, async (req, res) => {
    try {
        const query = `SELECT expenses.*, users.username FROM expenses JOIN users ON expenses.user_id = users.id ORDER BY expenses.id DESC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania wydatków' }); }
});

app.post('/api/expenses', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const { type, amount, description, expense_date, liters } = req.body;
    const parsedAmount = parseInt(amount) || 0;
    if (parsedAmount <= 0) return res.status(400).json({ error: 'Kwota musi być większa od 0.' });
    if (type === 'purchase' && !isStaff(req.session.role)) return res.status(403).json({ error: 'Zakupy pojazdów może zapisywać tylko Szef.' });

    try {
        await pool.query(
            'INSERT INTO expenses (user_id, type, amount, description, expense_date, liters) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.session.userId, type || 'other', parsedAmount, description || 'Wydatek', expense_date || new Date(), parseInt(liters) || 0]
        );
        res.json({ success: true });
    } catch (err) { 
        console.error("Błąd zapisu wydatku:", err);
        res.status(500).json({ error: 'Błąd zapisu wydatku' }); 
    }
});

app.put('/api/expenses/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const { type, amount, description } = req.body;
    const parsedAmount = parseInt(amount) || 0;
    if (parsedAmount <= 0) return res.status(400).json({ error: 'Kwota musi być większa od 0.' });

    try {
        const expCheck = await pool.query('SELECT user_id FROM expenses WHERE id = $1', [req.params.id]);
        if (expCheck.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono wydatku' });

        if (!isStaff(req.session.role) && expCheck.rows[0].user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Możesz edytować tylko własne wydatki!' });
        }

        await pool.query(
            'UPDATE expenses SET type = $1, amount = $2, description = $3 WHERE id = $4',
            [type, parsedAmount, description || '', req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd edycji wydatku' }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const userRes = await pool.query('SELECT role FROM users WHERE id = $1', [req.session.userId]);
        const userRole = userRes.rows.length > 0 ? userRes.rows[0].role : null;

        const expCheck = await pool.query('SELECT user_id FROM expenses WHERE id = $1', [req.params.id]);
        if (expCheck.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono wydatku' });

        const isOwner = expCheck.rows[0].user_id === req.session.userId;
        const isAdmin = isStaff(userRole);

        if (!isAdmin && !isOwner) {
            return res.status(403).json({ error: 'Możesz usuwać tylko własne wydatki lub musisz być szefem!' });
        }

        await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { 
        console.error("Błąd usuwania wydatku:", err);
        res.status(500).json({ error: 'Błąd serwera' }); 
    }
});

// ====================== POJAZDY: CIĘŻARÓWKI + NACZEPY ======================
const vehicleUpload = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'photo_back', maxCount: 1 }]);

function registerVehicleRoutes(base, table, modelCol, extra) {
    const extraKeys = Object.keys(extra);

    app.get(base, requireLogin, async (req, res) => {
        try {
            const r = await pool.query(`SELECT * FROM ${table} ORDER BY LOWER(${modelCol}), id`);
            res.json(r.rows);
        } catch (err) { res.status(500).json({ error: 'Błąd pobierania pojazdów' }); }
    });

    // Dodanie nowego modelu (z kilkoma tablicami naraz) albo kolejnej sztuki istniejącego modelu.
    app.post(base, requireAdmin, vehicleUpload, async (req, res) => {
        const model = (req.body.model_name || '').trim();
        if (!model) return res.status(400).json({ error: 'Podaj nazwę / model.' });

        const plates = (req.body.plates || '').split(/[,;\n]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (plates.length === 0) plates.push('BRAK');

        try {
            const existing = await pool.query(`SELECT * FROM ${table} WHERE LOWER(${modelCol}) = LOWER($1) ORDER BY id LIMIT 1`, [model]);
            const proto = existing.rows[0] || {};
            const modelName = proto[modelCol] || model;

            const photo = (await saveFile(req.files && req.files.photo ? req.files.photo[0] : null)) || proto.photo || '';
            const photoBack = (await saveFile(req.files && req.files.photo_back ? req.files.photo_back[0] : null)) || proto.photo_back || '';
            const extraVals = extraKeys.map(k => ((req.body[k] || '').trim()) || proto[k] || extra[k]);

            let added = 0;
            for (const plate of plates) {
                if (plate !== 'BRAK') {
                    const dup = await pool.query(`SELECT 1 FROM ${table} WHERE plates = $1`, [plate]);
                    if (dup.rows.length > 0) continue;
                }
                const cols = [modelCol, 'plates', 'photo', 'photo_back', ...extraKeys];
                const vals = [modelName, plate, photo, photoBack, ...extraVals];
                const ph = vals.map((_, i) => '$' + (i + 1)).join(', ');
                await pool.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, vals);
                added++;
            }
            if (added === 0) return res.status(400).json({ error: 'Pojazd z takimi tablicami już istnieje.' });
            res.json({ success: true, added });
        } catch (err) {
            console.error('Błąd dodawania pojazdu:', err);
            res.status(500).json({ error: 'Błąd dodawania pojazdu (sprawdź rozmiar i typ zdjęć).' });
        }
    });

    // Przypisanie / zwolnienie konkretnej sztuki (puste driver_name = wolny)
    app.put(`${base}/:id/assign`, requireAdmin, async (req, res) => {
        const driver = (req.body.driver_name || '').trim() || 'Wolne';
        try {
            const r = await pool.query(
                `UPDATE ${table} SET driver_name = $1 WHERE id = $2 RETURNING ${modelCol} AS model, plates`,
                [driver, req.params.id]
            );
            if (r.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono pojazdu' });

            if (driver !== 'Wolne') {
                const target = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [driver]);
                if (target.rows.length > 0) {
                    await addNotification(target.rows[0].id, 'Przydział pojazdu', `Szef przypisał Ci: ${r.rows[0].model} (${r.rows[0].plates})`, null, 'garage');
                }
            }
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: 'Błąd przypisania' }); }
    });

    app.delete(`${base}/model/:model`, requireAdmin, async (req, res) => {
        try {
            await pool.query(`DELETE FROM ${table} WHERE LOWER(${modelCol}) = LOWER($1)`, [req.params.model]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: 'Błąd usuwania modelu' }); }
    });

    app.delete(`${base}/:id`, requireAdmin, async (req, res) => {
        try {
            await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: 'Błąd usuwania pojazdu' }); }
    });
}

registerVehicleRoutes('/api/trucks', 'trucks', 'truck_model', {
    cabin: 'Standard', chassis: 'Standard', engine: 'Standard', gearbox: 'Standard', interior: 'Standard', accessories: 'Standard'
});
registerVehicleRoutes('/api/trailers', 'trailers', 'trailer_model', { description: '' });

// Jednorazowy import przydziałów, które wcześniej siedziały w localStorage przeglądarki Szefa.
app.post('/api/trucks/import-assignments', requireAdmin, async (req, res) => {
    const map = req.body.assignments || {};
    let updated = 0;
    try {
        for (const [plate, driver] of Object.entries(map)) {
            const r = await pool.query(
                "UPDATE trucks SET driver_name = $1 WHERE plates = $2 AND (driver_name IS NULL OR driver_name = '' OR driver_name = 'Wolne')",
                [String(driver), plate]
            );
            updated += r.rowCount;
        }
        res.json({ success: true, updated });
    } catch (err) { res.status(500).json({ error: 'Błąd importu przydziałów' }); }
});

app.get('/api/jobs', requireLogin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT jobs.*, users.username, TO_CHAR(jobs.created_at, 'DD.MM.YYYY HH24:MI') as formatted_date,
                   EXISTS (SELECT 1 FROM trips WHERE trips.job_id = jobs.id) AS has_trip
            FROM jobs 
            JOIN users ON jobs.user_id = users.id 
            ORDER BY jobs.id DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania tras' }); }
});

app.put('/api/jobs/:id/approve', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        const jobRes = await pool.query(
            `SELECT jobs.*, users.username FROM jobs JOIN users ON users.id = jobs.user_id WHERE jobs.id = $1`,
            [req.params.id]
        );
        if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono trasy' });

        const job = jobRes.rows[0];
        if (job.status === 'approved') return res.json({ success: true, already_approved: true });
        if (!['pending', 'revised'].includes(job.status)) return res.status(409).json({ error: 'Trasa musi zostać poprawiona przez kierowcę przed zatwierdzeniem.' });

        const kmBefore = parseInt((await pool.query("SELECT COALESCE(SUM(distance),0) AS km FROM jobs WHERE user_id = $1 AND status = 'approved'", [job.user_id])).rows[0].km) || 0;
        const approval = await pool.query(
            "UPDATE jobs SET status = 'approved' WHERE id = $1 AND status IN ('pending', 'revised') RETURNING id",
            [req.params.id]
        );
        if (approval.rowCount === 0) return res.json({ success: true, already_approved: true });

        // Miejsce w rankingu liczymy po zatwierdzonych kilometrach. Błąd rankingu
        // nie może zatrzymać publikacji ani samego zatwierdzenia raportu.
        let position = null;
        try {
            const ranking = await pool.query(
                `SELECT position FROM (
                    SELECT user_id, RANK() OVER (ORDER BY SUM(distance) DESC) AS position
                    FROM jobs WHERE status = 'approved' GROUP BY user_id
                 ) ranked WHERE user_id = $1`,
                [job.user_id]
            );
            position = parseInt(ranking.rows[0] && ranking.rows[0].position, 10) || null;
        } catch (rankErr) {
            console.warn('Nie udało się pobrać pozycji kierowcy do raportu Discord:', rankErr.message);
        }
        const discordSent = await postApprovedJobToDiscord(job, position);
        
        await addNotification(job.user_id, 'Trasa Zatwierdzona', `Szef zatwierdził Twoją trasę: ${job.start_city} ➔ ${job.end_city}`, null, 'jobs');

        // automatyczny awans (tylko gdy Szef nie nadał rangi ręcznie)
        const after = await pool.query("SELECT u.rank_override, COALESCE((SELECT SUM(distance) FROM jobs WHERE user_id = u.id AND status = 'approved'),0) AS km FROM users u WHERE u.id = $1", [job.user_id]);
        if (after.rows.length > 0 && after.rows[0].rank_override === null) {
            const kmAfter = parseInt(after.rows[0].km) || 0;
            if (autoRankIndex(kmAfter) > autoRankIndex(kmBefore)) {
                await addNotification(job.user_id, 'Awans!', `Gratulacje! Awansowałeś do rangi: ${RANKS[autoRankIndex(kmAfter)].name}`, null, 'jobs');
            }
        }
        res.json({ success: true, discord_sent: discordSent });
    } catch (err) { res.status(500).json({ error: 'Błąd akceptacji trasy' }); }
});


app.put('/api/jobs/:id/request-correction', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    const reason = String(req.body.reason || '').trim().slice(0, 1000);
    if (!reason) return res.status(400).json({ error: 'Podaj kierowcy powód poprawki.' });
    try {
        const jobRes = await pool.query(
            'SELECT id, user_id, start_city, end_city, status FROM jobs WHERE id = $1',
            [req.params.id]
        );
        if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono trasy.' });
        const job = jobRes.rows[0];
        if (!['pending', 'revised', 'approved'].includes(job.status)) {
            return res.status(409).json({ error: 'Ta trasa już czeka na poprawę albo nie może zostać odesłana.' });
        }
        await pool.query(
            "UPDATE jobs SET status = 'needs_correction', correction_note = $2 WHERE id = $1",
            [job.id, reason]
        );
        await addNotification(
            job.user_id,
            'Trasa do poprawy',
            `Kadra prosi o poprawę trasy ${job.start_city} ➔ ${job.end_city}. Powód: ${reason}`,
            job.id,
            'jobs'
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Błąd kierowania trasy do poprawy:', err);
        res.status(500).json({ error: 'Nie udało się oznaczyć trasy do poprawy.' });
    }
});

app.put('/api/jobs/:id/correction', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Zaloguj się.' });
    const jobId = Number.parseInt(req.params.id, 10);
    const distance = Number(req.body.distance);
    if (!Number.isInteger(distance) || distance < 1 || distance > 20000) {
        return res.status(400).json({ error: 'Kilometry muszą być liczbą całkowitą od 1 do 20 000.' });
    }
    const client = await pool.connect();
    let job;
    try {
        await client.query('BEGIN');
        const found = await client.query(
            'SELECT id, user_id, start_city, end_city, distance, status FROM jobs WHERE id = $1 FOR UPDATE',
            [jobId]
        );
        if (!found.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Nie znaleziono trasy.' });
        }
        job = found.rows[0];
        if (Number(job.user_id) !== Number(req.session.userId)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Możesz poprawiać tylko swoje trasy.' });
        }
        if (job.status !== 'needs_correction') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Kadra nie oznaczyła tej trasy do poprawy.' });
        }
        await client.query(
            "UPDATE jobs SET distance = $2, status = 'revised' WHERE id = $1",
            [jobId, distance]
        );
        await client.query('UPDATE trips SET distance = $2 WHERE job_id = $1', [jobId, distance]);
        await client.query('COMMIT');
        const staff = await pool.query(
            "SELECT id FROM users WHERE role IN ('admin', 'manager') AND status = 'approved'"
        );
        for (const member of staff.rows) {
            await addNotification(
                member.id,
                'Trasa poprawiona',
                `Kierowca poprawił dystans trasy ${job.start_city} ➔ ${job.end_city}: ${job.distance} km → ${distance} km. Czeka na ponowne zatwierdzenie.`,
                jobId,
                'jobs'
            );
        }
        res.json({ success: true, status: 'revised', distance });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('Błąd poprawiania trasy:', err);
        res.status(500).json({ error: 'Nie udało się zapisać poprawki.' });
    } finally {
        client.release();
    }
});

app.delete('/api/jobs/:id', async (req, res) => {
    if (!req.session.userId || !isStaff(req.session.role)) return res.status(403).json({ error: 'Brak uprawnień' });
    const { reason } = req.body;
    try {
        const jobRes = await pool.query('SELECT user_id, start_city, end_city FROM jobs WHERE id = $1', [req.params.id]);
        if (jobRes.rows.length > 0) {
            const job = jobRes.rows[0];
            const msg = reason ? `Szef odrzucił Twoją trasę (${job.start_city} ➔ ${job.end_city}). Powód: ${reason}` : `Szef odrzucił Twoją trasę (${job.start_city} ➔ ${job.end_city}).`;
            await addNotification(job.user_id, 'Trasa Odrzucona', msg, null, 'jobs');
        }

        await pool.query('DELETE FROM jobs WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania trasy' }); }
});

app.get('/api/company-stats', requireLogin, async (req, res) => {
    try {
        // Statystyki firmy i ranking są narastające od początku działalności,
        // ale obejmują wyłącznie zatwierdzone trasy.
        const totalKmRes = await pool.query("SELECT COALESCE(SUM(distance), 0) as total FROM jobs WHERE status = 'approved'");
        const totalDeliveriesRes = await pool.query("SELECT COUNT(*) as total FROM jobs WHERE status = 'approved'");
        const totalIncomeRes = await pool.query("SELECT COALESCE(SUM(income), 0) as total_income FROM jobs WHERE status = 'approved'");
        const totalExpensesRes = await pool.query('SELECT SUM(amount) as total_expenses FROM expenses');
        
        const totalCompanyKm = parseInt(totalKmRes.rows[0].total || 0);
        const totalDeliveries = parseInt(totalDeliveriesRes.rows[0].total || 0);
        const totalIncome = parseInt(totalIncomeRes.rows[0].total_income || 0);
        const totalExpenses = parseInt(totalExpensesRes.rows[0].total_expenses || 0);

        const rankingRes = await pool.query(`
            SELECT users.username, users.rank_override, SUM(jobs.distance) as km, COUNT(jobs.id) as deliveries,
                   COALESCE(SUM(jobs.distance) FILTER (WHERE jobs.status = 'approved'), 0) as approved_km
            FROM jobs JOIN users ON jobs.user_id = users.id 
            WHERE jobs.status = 'approved'
            GROUP BY users.username, users.rank_override ORDER BY km DESC
        `);

        res.json({
            totalCompanyKm,
            totalDeliveries,
            totalIncome,
            totalExpenses,
            totalCompanyBudget: totalIncome - totalExpenses,
            driversRanking: rankingRes.rows.map(d => ({ username: d.username, km: d.km, deliveries: d.deliveries, rank: rankFor(parseInt(d.approved_km) || 0, d.rank_override) }))
        });
    } catch (err) { res.status(500).json({ error: 'Błąd statystyk' }); }
});

// API aplikacji kierowcy (telemetria ETS2) - patrz client-api.js
const clientApi = require('./client-api')({ app, pool, requireLogin, addNotification });

initDB().then(() => app.listen(PORT, () => console.log(`Serwer VTC działa na porcie ${PORT}`)));
