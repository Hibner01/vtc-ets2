const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// <-- TUTAJ WKLEJ SWÓJ LINK WEBHOOK Z DISCORDA (jeśli chcesz) -->
const DISCORD_WEBHOOK_URL = ''; 

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database(path.join(__dirname, 'vtc.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'driver'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        start_city TEXT,
        end_city TEXT,
        cargo TEXT,
        distance INTEGER,
        cmr_file TEXT,
        summary_photo TEXT,
        date TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trucks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_name TEXT,
        truck_model TEXT,
        trailer_model TEXT,
        plates TEXT,
        photo TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'vtc-secret-key-change-it',
    resave: false,
    saveUninitialized: false
}));

async function sendDiscordNotification(job) {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `🚚 **Nowa trasa w VTC!**\n👤 **Kierowca:** ${job.username}\n📍 **Trasa:** ${job.start_city} ➔ ${job.end_city}\n📦 **Ładunek:** ${job.cargo}\n🛣️ **Dystans:** ${job.distance} km`
            })
        });
    } catch (e) {
        console.error('Błąd wysyłania webhooka na Discord:', e);
    }
}

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Uzupełnij wszystkie pola.' });

    db.get(`SELECT COUNT(*) as count FROM users`, async (err, row) => {
        const role = (row && row.count === 0) ? 'admin' : 'driver';
        try {
            const hash = await bcrypt.hash(password, 10);
            db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hash, role], (err) => {
                if (err) return res.status(400).json({ error: 'Użytkownik o takiej nazwie już istnieje.' });
                res.json({ success: true });
            });
        } catch (e) {
            res.status(500).json({ error: 'Błąd serwera.' });
        }
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ error: 'Nieprawidłowy login lub hasło.' });
        }
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.json({ success: true, username: user.username, role: user.role });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/user', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const month = new Date().toISOString().slice(0, 7);
    db.get(`SELECT SUM(distance) as totalKm FROM jobs WHERE user_id = ? AND date LIKE ?`, [req.session.userId, `${month}%`], (err, row) => {
        res.json({
            id: req.session.userId,
            username: req.session.username,
            role: req.session.role,
            monthlyKm: row?.totalKm || 0,
            limitKm: 6000
        });
    });
});

app.get('/api/company-stats', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const month = new Date().toISOString().slice(0, 7);
    db.get(`SELECT SUM(distance) as totalCompanyKm FROM jobs WHERE date LIKE ?`, [`${month}%`], (err, rowC) => {
        db.all(`
            SELECT u.username, SUM(j.distance) as km 
            FROM jobs j 
            JOIN users u ON j.user_id = u.id 
            WHERE j.date LIKE ? 
            GROUP BY u.id 
            ORDER BY km DESC
        `, [`${month}%`], (err, rowD) => {
            res.json({
                totalCompanyKm: rowC?.totalCompanyKm || 0,
                driversRanking: rowD || []
            });
        });
    });
});

app.post('/api/jobs', upload.fields([{ name: 'cmr', maxCount: 1 }, { name: 'summary', maxCount: 1 }]), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Musisz być zalogowany.' });

    const { start_city, end_city, cargo, distance } = req.body;
    const cmr = req.files['cmr'] ? `/uploads/${req.files['cmr'][0].filename}` : null;
    const summary = req.files['summary'] ? `/uploads/${req.files['summary'][0].filename}` : null;
    
    db.run(
        `INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, cmr_file, summary_photo, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.session.userId, start_city, end_city, cargo, distance, cmr, summary, new Date().toISOString()],
        function(err) {
            if (err) return res.status(500).json({ error: 'Błąd zapisu trasy.' });
            sendDiscordNotification({ username: req.session.username, start_city, end_city, cargo, distance });
            res.json({ success: true });
        }
    );
});

app.put('/api/jobs/:id', upload.fields([{ name: 'cmr', maxCount: 1 }, { name: 'summary', maxCount: 1 }]), (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });

    db.get(`SELECT * FROM jobs WHERE id = ?`, [req.params.id], (err, job) => {
        if (!job || (job.user_id !== req.session.userId && req.session.role !== 'admin')) {
            return res.status(403).json({ error: 'Brak uprawnień.' });
        }

        const { start_city, end_city, cargo, distance } = req.body;
        const cmr = req.files['cmr'] ? `/uploads/${req.files['cmr'][0].filename}` : job.cmr_file;
        const summary = req.files['summary'] ? `/uploads/${req.files['summary'][0].filename}` : job.summary_photo;
        
        db.run(
            `UPDATE jobs SET start_city = ?, end_city = ?, cargo = ?, distance = ?, cmr_file = ?, summary_photo = ? WHERE id = ?`,
            [start_city, end_city, cargo, distance, cmr, summary, req.params.id],
            (err) => {
                if (err) return res.status(500).json({ error: 'Błąd aktualizacji.' });
                res.json({ success: true });
            }
        );
    });
});

app.get('/api/jobs', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    db.all(`SELECT j.*, u.username FROM jobs j JOIN users u ON j.user_id = u.id ORDER BY j.id DESC`, [], (err, rows) => {
        res.json(rows || []);
    });
});

app.delete('/api/jobs/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    db.get(`SELECT * FROM jobs WHERE id = ?`, [req.params.id], (err, job) => {
        if (!job || (job.user_id !== req.session.userId && req.session.role !== 'admin')) {
            return res.status(403).json({ error: 'Brak uprawnień.' });
        }
        db.run(`DELETE FROM jobs WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
    });
});

app.get('/api/trucks', (req, res) => {
    db.all(`SELECT * FROM trucks ORDER BY id DESC`, [], (err, rows) => {
        res.json(rows || []);
    });
});

// Tylko Szef może dodawać pojazdy i naczepy do floty!
app.post('/api/trucks', upload.single('truck_photo'), (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Tylko Szef może dodawać pojazdy i naczepy do garażu!' });
    }

    const { driver_name, truck_model, trailer_model, plates } = req.body;
    const photo = req.file ? `/uploads/${req.file.filename}` : null;
    
    db.run(
        `INSERT INTO trucks (driver_name, truck_model, trailer_model, plates, photo) VALUES (?, ?, ?, ?, ?)`,
        [driver_name, truck_model, trailer_model || 'Brak', plates, photo],
        (err) => {
            if (err) return res.status(500).json({ error: 'Błąd zapisu pojazdu.' });
            res.json({ success: true });
        }
    );
});

app.get('/api/settings/logo', (req, res) => {
    db.get(`SELECT value FROM settings WHERE key = 'logo'`, [], (err, row) => {
        res.json({ logo: row?.value || null });
    });
});

app.post('/api/settings/logo', upload.single('logo'), (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień.' });
    const logoPath = req.file ? `/uploads/${req.file.filename}` : null;
    if (!logoPath) return res.status(400).json({ error: 'Brak pliku.' });
    
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('logo', ?)`, [logoPath], () => {
        res.json({ success: true, logo: logoPath });
    });
});

app.listen(PORT, () => {
    console.log(`Serwer VTC działa na porcie ${PORT}`);
});