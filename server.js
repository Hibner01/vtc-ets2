const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfiguracja folderu na przesyłane pliki (zdjęcia, CMR)
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
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 dni
}));

// Inicjalizacja bazy danych SQLite
const dbFile = path.join(__dirname, 'vtc.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Błąd bazy danych:', err.message);
    else console.log('Połączono z bazą SQLite.');
});

// Tworzenie tabel
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trucks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_name TEXT,
        truck_model TEXT,
        trailer_model TEXT,
        plates TEXT,
        photo TEXT
    )`);
});

// --- AUTORYZACJA ---

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Uzupełnij login i hasło.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.get(`SELECT COUNT(*) as count FROM users`, async (err, row) => {
            if (err) return res.status(500).json({ error: 'Błąd bazy danych.' });
            
            const role = (row.count === 0) ? 'admin' : 'driver';

            db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hashedPassword, role], function(err) {
                if (err) return res.status(400).json({ error: 'Taki użytkownik już istnieje.' });
                res.json({ success: true });
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'Błąd serwera.' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.json({ success: true });
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/user', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    db.all(`SELECT SUM(distance) as total FROM jobs WHERE user_id = ?`, [req.session.user.id], (err, rows) => {
        const monthlyKm = rows[0]?.total || 0;
        res.json({
            id: req.session.user.id,
            username: req.session.user.username,
            role: req.session.user.role,
            monthlyKm: monthlyKm,
            limitKm: 6000
        });
    });
});

// --- STATYSTYKI FIRMY ---

app.get('/api/company-stats', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    db.get(`SELECT SUM(distance) as totalCompanyKm FROM jobs`, (err, totalRow) => {
        db.all(`
            SELECT u.username, SUM(j.distance) as km 
            FROM users u 
            LEFT JOIN jobs j ON u.id = j.user_id 
            GROUP BY u.id 
            ORDER BY km DESC
        `, (err, rankingRows) => {
            res.json({
                totalCompanyKm: totalRow?.totalCompanyKm || 0,
                driversRanking: rankingRows || []
            });
        });
    });
});

// --- TRASY (JOBS) ---

app.get('/api/jobs', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    db.all(`
        SELECT j.*, u.username 
        FROM jobs j 
        JOIN users u ON j.user_id = u.id 
        ORDER BY j.id DESC
    `, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Błąd pobierania tras.' });
        res.json(rows);
    });
});

app.post('/api/jobs', upload.fields([{ name: 'cmr', maxCount: 1 }, { name: 'summary', maxCount: 1 }]), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    const { start_city, end_city, cargo, distance } = req.body;
    const cmr_file = req.files['cmr'] ? `/uploads/${req.files['cmr'][0].filename}` : null;
    const summary_photo = req.files['summary'] ? `/uploads/${req.files['summary'][0].filename}` : null;

    db.run(
        `INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, cmr_file, summary_photo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.session.user.id, start_city, end_city, cargo, distance, cmr_file, summary_photo],
        function(err) {
            if (err) return res.status(500).json({ error: 'Błąd zapisu trasy.' });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/jobs/:id', upload.fields([{ name: 'cmr', maxCount: 1 }, { name: 'summary', maxCount: 1 }]), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    const jobId = req.params.id;
    const { start_city, end_city, cargo, distance } = req.body;

    db.get(`SELECT * FROM jobs WHERE id = ?`, [jobId], (err, job) => {
        if (err || !job) return res.status(404).json({ error: 'Trasa nie znaleziona.' });
        if (job.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień.' });
        }

        const cmr_file = req.files['cmr'] ? `/uploads/${req.files['cmr'][0].filename}` : job.cmr_file;
        const summary_photo = req.files['summary'] ? `/uploads/${req.files['summary'][0].filename}` : job.summary_photo;

        db.run(
            `UPDATE jobs SET start_city = ?, end_city = ?, cargo = ?, distance = ?, cmr_file = ?, summary_photo = ? WHERE id = ?`,
            [start_city, end_city, cargo, distance, cmr_file, summary_photo, jobId],
            (err) => {
                if (err) return res.status(500).json({ error: 'Błąd aktualizacji trasy.' });
                res.json({ success: true });
            }
        );
    });
});

app.delete('/api/jobs/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    const jobId = req.params.id;
    db.get(`SELECT * FROM jobs WHERE id = ?`, [jobId], (err, job) => {
        if (err || !job) return res.status(404).json({ error: 'Trasa nie znaleziona.' });
        if (job.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień.' });
        }

        db.run(`DELETE FROM jobs WHERE id = ?`, [jobId], (err) => {
            if (err) return res.status(500).json({ error: 'Błąd usuwania trasy.' });
            res.json({ success: true });
        });
    });
});

// --- GARAŻ / FLOTA (TRUCKS) ---

app.get('/api/trucks', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Brak sesji.' });

    db.all(`SELECT * FROM trucks ORDER BY id DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Błąd pobierania floty.' });
        res.json(rows);
    });
});

app.post('/api/trucks', upload.single('truck_photo'), (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Tylko szef może dodawać pojazdy.' });
    }

    const { driver_name, truck_model, trailer_model, plates } = req.body;
    const photo = req.file ? `/uploads/${req.file.filename}` : null;

    if (!photo) return res.status(400).json({ error: 'Zdjęcie zestawu jest wymagane.' });

    db.run(
        `INSERT INTO trucks (driver_name, truck_model, trailer_model, plates, photo) VALUES (?, ?, ?, ?, ?)`,
        [driver_name, truck_model, trailer_model, plates, photo],
        function(err) {
            if (err) return res.status(500).json({ error: 'Błąd zapisu pojazdu.' });
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.put('/api/trucks/:id', upload.single('truck_photo'), (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Brak uprawnień.' });
    }

    const truckId = req.params.id;
    const { driver_name, truck_model, trailer_model, plates } = req.body;

    db.get(`SELECT * FROM trucks WHERE id = ?`, [truckId], (err, truck) => {
        if (err || !truck) return res.status(404).json({ error: 'Pojazd nie znaleziony.' });

        const photo = req.file ? `/uploads/${req.file.filename}` : truck.photo;

        db.run(
            `UPDATE trucks SET driver_name = ?, truck_model = ?, trailer_model = ?, plates = ?, photo = ? WHERE id = ?`,
            [driver_name, truck_model, trailer_model, plates, photo, truckId],
            (err) => {
                if (err) return res.status(500).json({ error: 'Błąd aktualizacji pojazdu.' });
                res.json({ success: true });
            }
        );
    });
});

app.delete('/api/trucks/:id', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Brak uprawnień. Tylko szef może usuwać pojazdy.' });
    }

    const truckId = req.params.id;
    db.run(`DELETE FROM trucks WHERE id = ?`, [truckId], function(err) {
        if (err) return res.status(500).json({ error: 'Błąd bazy danych podczas usuwania pojazdu.' });
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Serwer VTC działa na porcie ${PORT}`);
});
