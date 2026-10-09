const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfiguracja połączenia z PostgreSQL (Supabase / Render)
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

db.connect((err) => {
    if (err) console.error('Błąd połączenia z bazą PostgreSQL:', err.message);
    else console.log('Połączono z bazą PostgreSQL w chmurze.');
});

// Tworzenie tabel w PostgreSQL
db.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'driver'
    );
    CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        start_city TEXT,
        end_city TEXT,
        cargo TEXT,
        distance INTEGER,
        cmr_file TEXT,
        summary_photo TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS trucks (
        id SERIAL PRIMARY KEY,
        driver_name TEXT,
        truck_model TEXT,
        trailer_model TEXT,
        plates TEXT,
        photo TEXT
    );
`).catch(err => console.error('Błąd tworzenia tabel:', err.message));

// Konfiguracja folderu na przesyłane pliki
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'mazren-vtc-secret-key-12345',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// --- AUTORYZACJA ---

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Uzupełnij login i hasło.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const userCount = await db.query(`SELECT COUNT(*) FROM users`);
        const role = (parseInt(userCount.rows[0].count) === 0) ? 'admin' : 'driver';

        await db.query(`INSERT INTO users (username, password, role) VALUES ($1, $2, $3)`, [username, hashedPassword, role]);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') {
            return res.status(400).json({ error: 'Taki użytkownik już istnieje.' });
        }
        res.status(500).json({ error: 'Błąd serwera.' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.query(`SELECT * FROM users WHERE username = $1`, [username], async (err, result) => {
        if (err || result.rows.length === 0) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.json({ success: true });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/user', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    try {
        const totalResult = await db.query(`SELECT SUM(distance) as total FROM jobs WHERE user_id = $1`, [req.session.user.id]);
        const monthlyKm = totalResult.rows[0]?.total || 0;
        res.json({
            id: req.session.user.id,
            username: req.session.user.username,
            role: req.session.user.role,
            monthlyKm: parseInt(monthlyKm),
            limitKm: 6000
        });
    } catch (e) {
        res.status(500).json({ error: 'Błąd serwera.' });
    }
});

// --- STATYSTYKI FIRMY ---

app.get('/api/company-stats', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    try {
        const totalRow = await db.query(`SELECT SUM(distance) as total FROM jobs`);
        const rankingRows = await db.query(`
            SELECT u.username, COALESCE(SUM(j.distance), 0) as km 
            FROM users u 
            LEFT JOIN jobs j ON u.id = j.user_id 
            GROUP BY u.id, u.username 
            ORDER BY km DESC
        `);

        res.json({
            totalCompanyKm: parseInt(totalRow.rows[0]?.total || 0),
            driversRanking: rankingRows.rows || []
        });
    } catch (e) {
        res.status(500).json({ error: 'Błąd statystyk.' });
    }
});

// --- TRASY (JOBS) ---

app.get('/api/jobs', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    try {
        const result = await db.query(`
            SELECT j.*, u.username 
            FROM jobs j 
            JOIN users u ON j.user_id = u.id 
            ORDER BY j.id DESC
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Błąd pobierania tras.' });
    }
});

app.post('/api/jobs', upload.fields([{ name: 'cmr', maxCount: 1 }, { name: 'summary', maxCount: 1 }]), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    const { start_city, end_city, cargo, distance } = req.body;
    const cmr_file = req.files['cmr'] ? `/uploads/${req.files['cmr'][0].filename}` : null;
    const summary_photo = req.files['summary'] ? `/uploads/${req.files['summary'][0].filename}` : null;

    try {
        const result = await db.query(
            `INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, cmr_file, summary_photo) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [req.session.user.id, start_city, end_city, cargo, distance, cmr_file, summary_photo]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
        res.status(500).json({ error: 'Błąd zapisu trasy.' });
    }
});

app.put('/api/jobs/:id', upload.fields([{ name: 'cmr', maxCount: 1 }, { name: 'summary', maxCount: 1 }]), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    const jobId = req.params.id;
    const { start_city, end_city, cargo, distance } = req.body;

    try {
        const jobResult = await db.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Trasa nie znaleziona.' });

        const job = jobResult.rows[0];
        if (job.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień.' });
        }

        const cmr_file = req.files['cmr'] ? `/uploads/${req.files['cmr'][0].filename}` : job.cmr_file;
        const summary_photo = req.files['summary'] ? `/uploads/${req.files['summary'][0].filename}` : job.summary_photo;

        await db.query(
            `UPDATE jobs SET start_city = $1, end_city = $2, cargo = $3, distance = $4, cmr_file = $5, summary_photo = $6 WHERE id = $7`,
            [start_city, end_city, cargo, distance, cmr_file, summary_photo, jobId]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Błąd aktualizacji trasy.' });
    }
});

app.delete('/api/jobs/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    const jobId = req.params.id;
    try {
        const jobResult = await db.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Trasa nie znaleziona.' });

        const job = jobResult.rows[0];
        if (job.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień.' });
        }

        await db.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Błąd usuwania trasy.' });
    }
});

// --- GARAŻ / FLOTA (TRUCKS) ---

app.get('/api/trucks', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    try {
        const result = await db.query(`SELECT * FROM trucks ORDER BY id DESC`);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: 'Błąd pobierania floty.' });
    }
});

app.post('/api/trucks', upload.single('truck_photo'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Tylko szef może dodawać pojazdy.' });
    }

    const { driver_name, truck_model, trailer_model, plates } = req.body;
    const photo = req.file ? `/uploads/${req.file.filename}` : null;

    if (!photo) return res.status(400).json({ error: 'Zdjęcie zestawu jest wymagane.' });

    try {
        const result = await db.query(
            `INSERT INTO trucks (driver_name, truck_model, trailer_model, plates, photo) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [driver_name, truck_model, trailer_model, plates, photo]
        );
        res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
        res.status(500).json({ error: 'Błąd zapisu pojazdu.' });
    }
});

app.put('/api/trucks/:id', upload.single('truck_photo'), async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Brak uprawnień.' });
    }

    const truckId = req.params.id;
    const { driver_name, truck_model, trailer_model, plates } = req.body;

    try {
        const truckResult = await db.query(`SELECT * FROM trucks WHERE id = $1`, [truckId]);
        if (truckResult.rows.length === 0) return res.status(404).json({ error: 'Pojazd nie znaleziony.' });

        const truck = truckResult.rows[0];
        const photo = req.file ? `/uploads/${req.file.filename}` : truck.photo;

        await db.query(
            `UPDATE trucks SET driver_name = $1, truck_model = $2, trailer_model = $3, plates = $4, photo = $5 WHERE id = $6`,
            [driver_name, truck_model, trailer_model, plates, photo, truckId]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Błąd aktualizacji pojazdu.' });
    }
});

app.delete('/api/trucks/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Brak uprawnień. Tylko szef może usuwać pojazdy.' });
    }

    const truckId = req.params.id;
    try {
        await db.query(`DELETE FROM trucks WHERE id = $1`, [truckId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Błąd bazy danych podczas usuwania pojazdu.' });
    }
});

app.listen(PORT, () => {
    console.log(`Serwer VTC działa na porcie ${PORT}`);
});
