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
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_override INTEGER;`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'approved';`);
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
app.use(express.static(path.join(__dirname, 'public')));
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
function requireAdmin(req, res, next) {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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
            const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
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
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd logowania.' }); }
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const userRes = await pool.query('SELECT id, username, email, role, status FROM users WHERE id = $1', [req.session.userId]);
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'Użytkownik nie istnieje' });
        
        const user = userRes.rows[0];
        if (user.status === 'fired') {
            return req.session.destroy(() => res.status(401).json({ error: 'Konto dezaktywowane' }));
        }

        const kmRes = await pool.query(`
            SELECT SUM(distance) as total, COUNT(*) as deliveries 
            FROM jobs 
            WHERE user_id = $1 
            AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_TIMESTAMP)
        `, [user.id]);

        const truckRes = await pool.query('SELECT * FROM trucks WHERE LOWER(driver_name) = LOWER($1) ORDER BY id LIMIT 1', [user.username]);
        const trailerRes = await pool.query('SELECT * FROM trailers WHERE LOWER(driver_name) = LOWER($1) ORDER BY id LIMIT 1', [user.username]);

        res.json({
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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

app.put('/api/users/:id/approve', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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
        const u = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
        if (u.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono użytkownika' });

        const hashed = await bcrypt.hash(pw, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, id]);
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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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

        if (req.session.role === 'admin') {
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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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

        if (req.session.role !== 'admin' && disp.accepted_by_id !== req.session.userId) {
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

        const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
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

        if (req.session.role !== 'admin' && expCheck.rows[0].user_id !== req.session.userId) {
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
        const isAdmin = userRole === 'admin';

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
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        const jobRes = await pool.query('SELECT user_id, start_city, end_city FROM jobs WHERE id = $1', [req.params.id]);
        if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono trasy' });

        const job = jobRes.rows[0];
        const kmBefore = parseInt((await pool.query("SELECT COALESCE(SUM(distance),0) AS km FROM jobs WHERE user_id = $1 AND status = 'approved'", [job.user_id])).rows[0].km) || 0;
        await pool.query("UPDATE jobs SET status = 'approved' WHERE id = $1", [req.params.id]);
        
        await addNotification(job.user_id, 'Trasa Zatwierdzona', `Szef zatwierdził Twoją trasę: ${job.start_city} ➔ ${job.end_city}`, null, 'jobs');

        // automatyczny awans (tylko gdy Szef nie nadał rangi ręcznie)
        const after = await pool.query("SELECT u.rank_override, COALESCE((SELECT SUM(distance) FROM jobs WHERE user_id = u.id AND status = 'approved'),0) AS km FROM users u WHERE u.id = $1", [job.user_id]);
        if (after.rows.length > 0 && after.rows[0].rank_override === null) {
            const kmAfter = parseInt(after.rows[0].km) || 0;
            if (autoRankIndex(kmAfter) > autoRankIndex(kmBefore)) {
                await addNotification(job.user_id, 'Awans!', `Gratulacje! Awansowałeś do rangi: ${RANKS[autoRankIndex(kmAfter)].name}`, null, 'jobs');
            }
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd akceptacji trasy' }); }
});

app.delete('/api/jobs/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
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
        const totalKmRes = await pool.query("SELECT SUM(distance) as total FROM jobs");
        const totalDeliveriesRes = await pool.query("SELECT COUNT(*) as total FROM jobs");
        const totalIncomeRes = await pool.query("SELECT SUM(income) as total_income FROM jobs");
        const totalExpensesRes = await pool.query('SELECT SUM(amount) as total_expenses FROM expenses');
        
        const totalCompanyKm = parseInt(totalKmRes.rows[0].total || 0);
        const totalDeliveries = parseInt(totalDeliveriesRes.rows[0].total || 0);
        const totalIncome = parseInt(totalIncomeRes.rows[0].total_income || 0);
        const totalExpenses = parseInt(totalExpensesRes.rows[0].total_expenses || 0);

        const rankingRes = await pool.query(`
            SELECT users.username, users.rank_override, SUM(jobs.distance) as km, COUNT(jobs.id) as deliveries,
                   COALESCE(SUM(jobs.distance) FILTER (WHERE jobs.status = 'approved'), 0) as approved_km
            FROM jobs JOIN users ON jobs.user_id = users.id 
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
