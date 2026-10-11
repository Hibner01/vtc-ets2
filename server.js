const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL,
                amount INTEGER NOT NULL,
                description TEXT NOT NULL,
                liters INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS trucks (
                id SERIAL PRIMARY KEY,
                truck_model VARCHAR(255) NOT NULL,
                driver_name VARCHAR(255) DEFAULT 'Wolne',
                plates VARCHAR(50) NOT NULL,
                photo TEXT NOT NULL,
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

            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Baza danych zainicjalizowana pomyślnie.');
    } catch (err) {
        console.error('Błąd inicjalizacji bazy:', err.message);
    }
}
initDB();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'mazren-spedition-secret-key',
    resave: false,
    saveUninitialized: false
}));

async function addNotification(userId, title, message) {
    try {
        await pool.query('INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)', [userId, title, message]);
    } catch (e) { console.error('Błąd powiadomień:', e); }
}

// --- AUTORYZACJA ---

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Uzupełnij login i hasło.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
        const count = parseInt(userCountRes.rows[0].count);
        
        const role = count === 0 ? 'admin' : 'driver';
        const status = count === 0 ? 'approved' : 'pending';

        await pool.query('INSERT INTO users (username, password, role, status) VALUES ($1, $2, $3, $4)', [username, hashedPassword, role, status]);
        
        if (status === 'pending') {
            const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
            for (let adm of admins.rows) {
                await addNotification(adm.id, '👤 Nowy Kierowca', `Kierowca @${username} zarejestrował się i oczekuje na zatwierdzenie konta.`);
            }
        }

        res.json({ success: true, message: status === 'pending' ? 'Konto oczekuje na akceptację Szefa!' : 'Konto Szefa utworzone!' });
    } catch (err) { res.status(400).json({ error: 'Użytkownik już istnieje.' }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        const user = result.rows[0];
        if (user.status === 'pending') return res.status(403).json({ error: 'Konto oczekuje na akceptację Szefa!' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd logowania.' }); }
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const userRes = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId]);
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'Użytkownik nie istnieje' });
        
        const user = userRes.rows[0];
        const kmRes = await pool.query('SELECT SUM(distance) as total FROM jobs WHERE user_id = $1', [user.id]);

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            monthlyKm: parseInt(kmRes.rows[0].total || 0),
            limitKm: 6000
        });
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania danych' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

// --- POWIADOMIENIA ---

app.get('/api/notifications', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 15', [req.session.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd powiadomień' }); }
});

app.put('/api/notifications/read', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.session.userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd aktualizacji' }); }
});

// --- ZARZĄDZANIE KONTAMI ---

app.get('/api/users', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        const result = await pool.query('SELECT id, username, role, status FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd użytkowników' }); }
});

app.put('/api/users/:id/approve', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['approved', req.params.id]);
        await addNotification(req.params.id, '🎉 Konto Aktywne', 'Twoje konto zostało zatwierdzone przez Szefa!');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd zatwierdzania' }); }
});

app.delete('/api/users/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania' }); }
});

// --- DYSPOZYTOR ---

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
    const { assigned_to, start_city, end_city, truck_name, notes } = req.body;
    try {
        await pool.query(
            'INSERT INTO dispatches (assigned_to, start_city, end_city, truck_name, notes, status) VALUES ($1, $2, $3, $4, $5, $6)',
            [assigned_to || 'Wszyscy', start_city, end_city, truck_name || 'Standardowy Zestaw', notes || '', 'W wolnym obiegu']
        );

        if (assigned_to && assigned_to !== 'Wszyscy') {
            const targetUser = await pool.query('SELECT id FROM users WHERE username = $1', [assigned_to]);
            if (targetUser.rows.length > 0) {
                await addNotification(targetUser.rows[0].id, '📡 Nowe Zlecenie', `Szef przydzielił Ci nową trasę: ${start_city} ➔ ${end_city}`);
            }
        }

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd dodawania zlecenia' }); }
});

app.put('/api/dispatches/:id/accept', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const dispRes = await pool.query('SELECT assigned_to FROM dispatches WHERE id = $1', [req.params.id]);
        if (dispRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono zlecenia' });

        const disp = dispRes.rows[0];
        // Blokada: Nikt nie może przyjąć imiennego zlecenia przeznaczonego dla kogoś innego!
        if (disp.assigned_to !== 'Wszyscy' && disp.assigned_to !== req.session.username) {
            return res.status(403).json({ error: 'To zlecenie jest przypisane do innego kierowcy!' });
        }

        await pool.query(
            'UPDATE dispatches SET status = $1, accepted_by_id = $2, accepted_by_username = $3 WHERE id = $4',
            ['W trakcie', req.session.userId, req.session.username, req.params.id]
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd akceptacji' }); }
});

app.post('/api/dispatches/:id/complete', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const { distance, income, cargo, cmr_file, summary_photo } = req.body;
    const parsedDist = parseInt(distance) || 0;
    const parsedInc = parseInt(income) || 0;

    if (parsedDist <= 0) return res.status(400).json({ error: 'Podaj prawidłowy dystans w km.' });

    try {
        const dispRes = await pool.query('SELECT * FROM dispatches WHERE id = $1', [req.params.id]);
        if (dispRes.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono zlecenia' });
        const disp = dispRes.rows[0];

        await pool.query(
            'INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, income, cmr_file, summary_photo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [req.session.userId, disp.start_city, disp.end_city, cargo || 'Standard', parsedDist, parsedInc, cmr_file || '', summary_photo || '']
        );

        await pool.query('DELETE FROM dispatches WHERE id = $1', [req.params.id]);

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd raportowania trasy' }); }
});

// --- FINANSE ---

app.get('/api/expenses', async (req, res) => {
    try {
        const query = `SELECT expenses.*, users.username FROM expenses JOIN users ON expenses.user_id = users.id ORDER BY expenses.id DESC`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania wydatków' }); }
});

app.post('/api/expenses', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const { type, amount, description } = req.body;
    const parsedAmount = parseInt(amount) || 0;
    if (parsedAmount <= 0) return res.status(400).json({ error: 'Kwota musi być większa od 0.' });

    try {
        await pool.query(
            'INSERT INTO expenses (user_id, type, amount, description) VALUES ($1, $2, $3, $4)',
            [req.session.userId, type || 'fuel', parsedAmount, description || 'Wydatek']
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd zapisu wydatku' }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania wydatku' }); }
});

// --- GARAŻ VTC ---

app.get('/api/trucks', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM trucks ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania floty' }); }
});

app.post('/api/trucks', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const { truck_model, driver_name, plates, cabin, chassis, engine, gearbox, interior, accessories } = req.body;
    const defaultPhoto = 'https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/wzor.jpg';

    try {
        await pool.query(
            `INSERT INTO trucks (truck_model, driver_name, plates, photo, cabin, chassis, engine, gearbox, interior, accessories) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [truck_model, driver_name || 'Wolne', plates || 'BRAK', defaultPhoto, cabin || 'Standard', chassis || 'Standard', engine || 'Standard', gearbox || 'Standard', interior || 'Standard', accessories || 'Standard']
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd dodawania pojazdu' }); }
});

app.delete('/api/trucks/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM trucks WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Błąd usuwania pojazdu' }); }
});

// --- STATYSTYKI ---

app.get('/api/jobs', async (req, res) => {
    try {
        const result = await pool.query('SELECT jobs.*, users.username FROM jobs JOIN users ON jobs.user_id = users.id ORDER BY jobs.id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: 'Błąd pobierania tras' }); }
});

app.get('/api/company-stats', async (req, res) => {
    try {
        const totalKmRes = await pool.query('SELECT SUM(distance) as total FROM jobs');
        const totalIncomeRes = await pool.query('SELECT SUM(income) as total_income FROM jobs');
        const totalExpensesRes = await pool.query('SELECT SUM(amount) as total_expenses FROM expenses');
        
        const totalCompanyKm = parseInt(totalKmRes.rows[0].total || 0);
        const totalIncome = parseInt(totalIncomeRes.rows[0].total_income || 0);
        const totalExpenses = parseInt(totalExpensesRes.rows[0].total_expenses || 0);

        const rankingRes = await pool.query(`
            SELECT users.username, SUM(jobs.distance) as km 
            FROM jobs JOIN users ON jobs.user_id = users.id 
            GROUP BY users.username ORDER BY km DESC
        `);

        res.json({
            totalCompanyKm,
            totalIncome,
            totalExpenses,
            totalCompanyBudget: totalIncome - totalExpenses,
            driversRanking: rankingRes.rows
        });
    } catch (err) { res.status(500).json({ error: 'Błąd statystyk' }); }
});

app.listen(PORT, () => console.log(`Serwer VTC działa na porcie ${PORT}`));
