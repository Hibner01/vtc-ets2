const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Konfiguracja połączenia z PostgreSQL (Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Test połączenia z bazą
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Błąd połączenia z bazą PostgreSQL:', err.message);
    } else {
        console.log('Połączono z bazą PostgreSQL pomyślnie!');
    }
});

// Tworzenie tabel, jeśli nie istnieją
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'driver'
            );
            
            CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                start_city VARCHAR(255) NOT NULL,
                end_city VARCHAR(255) NOT NULL,
                cargo VARCHAR(255) NOT NULL,
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
                driver_name VARCHAR(255) NOT NULL,
                truck_model VARCHAR(255) NOT NULL,
                trailer_model VARCHAR(255),
                plates VARCHAR(50) NOT NULL,
                photo TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dispatches (
                id SERIAL PRIMARY KEY,
                assigned_to VARCHAR(255) DEFAULT 'Wszyscy',
                start_city VARCHAR(255) NOT NULL,
                end_city VARCHAR(255) NOT NULL,
                cargo VARCHAR(255) NOT NULL,
                notes TEXT,
                status VARCHAR(50) DEFAULT 'W wolnym obiegu',
                accepted_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                accepted_by_username VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Tabele zostały pomyślnie zainicjalizowane.');
    } catch (err) {
        console.error('Błąd tworzenia tabel:', err.message);
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

const upload = multer({ storage: multer.memoryStorage() });

// --- ENDPOINTY AUTORYZACJI ---

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Uzupełnij login i hasło.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const userCountRes = await pool.query('SELECT COUNT(*) FROM users');
        const role = parseInt(userCountRes.rows[0].count) === 0 ? 'admin' : 'driver';

        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, hashedPassword, role]);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Użytkownik o takiej nazwie już istnieje.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Nieprawidłowy login lub hasło.' });

        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd serwera podczas logowania.' });
    }
});

app.get('/api/user', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const userRes = await pool.query('SELECT id, username, role FROM users WHERE id = $1', [req.session.userId]);
        if (userRes.rows.length === 0) return res.status(401).json({ error: 'Użytkownik nie istnieje' });
        
        const user = userRes.rows[0];
        const kmRes = await pool.query('SELECT SUM(distance) as total FROM jobs WHERE user_id = $1', [user.id]);
        const monthlyKm = parseInt(kmRes.rows[0].total || 0);

        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            monthlyKm: monthlyKm,
            limitKm: 6000
        });
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania danych użytkownika' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// --- PANEL SZEFA: ZARZĄDZANIE KIEROWCAMI ---

app.get('/api/users', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        const result = await pool.query('SELECT id, username, role FROM users ORDER BY username ASC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania listy użytkowników' });
    }
});

app.put('/api/users/:id/password', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const { newPassword } = req.body;
    const targetUserId = req.params.id;

    if (!newPassword) return res.status(400).json({ error: 'Nowe hasło jest wymagane' });

    try {
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, targetUserId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd zmiany hasła' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const targetUserId = req.params.id;

    if (parseInt(targetUserId) === req.session.userId) {
        return res.status(400).json({ error: 'Nie możesz usunąć własnego konta administratora.' });
    }

    try {
        await pool.query('DELETE FROM users WHERE id = $1', [targetUserId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd usuwania użytkownika' });
    }
});

// --- DYSPOZYTOR / ZLECENIA ---

app.get('/api/dispatches', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM dispatches ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania zleceń dyspozytora' });
    }
});

app.post('/api/dispatches', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Brak uprawnień dyspozytora' });
    }
    const { assigned_to, start_city, end_city, cargo, notes } = req.body;
    try {
        await pool.query(
            'INSERT INTO dispatches (assigned_to, start_city, end_city, cargo, notes) VALUES ($1, $2, $3, $4, $5)',
            [assigned_to || 'Wszyscy', start_city, end_city, cargo, notes || '']
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd dodawania zlecenia' });
    }
});

app.put('/api/dispatches/:id/accept', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const dispatchRes = await pool.query('SELECT * FROM dispatches WHERE id = $1', [req.params.id]);
        if (dispatchRes.rows.length === 0) return res.status(404).json({ error: 'Zlecenie nie znalezione' });
        
        const disp = dispatchRes.rows[0];
        if (disp.status !== 'W wolnym obiegu') {
            return res.status(400).json({ error: 'To zlecenie zostało już przez kogoś przyjęte!' });
        }

        const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        const username = userRes.rows[0].username;

        await pool.query(
            'UPDATE dispatches SET status = $1, accepted_by_id = $2, accepted_by_username = $3 WHERE id = $4',
            ['W trakcie', req.session.userId, username, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd przyjmowania zlecenia' });
    }
});

app.post('/api/dispatches/:id/complete', upload.fields([{ name: 'cmr' }, { name: 'summary' }]), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const dispatchId = req.params.id;
    const { distance, income, fuel_amount, fuel_liters } = req.body;

    try {
        const dispRes = await pool.query('SELECT * FROM dispatches WHERE id = $1', [dispatchId]);
        if (dispRes.rows.length === 0) return res.status(404).json({ error: 'Zlecenie nie znalezione' });
        const disp = dispRes.rows[0];

        const cmrFile = 'https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/wzor.jpg';
        const summaryPhoto = 'https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/przyklad-summary.jpg';

        // 1. Zapis trasy
        await pool.query(
            'INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, income, cmr_file, summary_photo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [req.session.userId, disp.start_city, disp.end_city, disp.cargo, parseInt(distance), parseInt(income), cmrFile, summaryPhoto]
        );

        // 2. Zapis paliwa (jeśli podano)
        if (fuel_amount && parseInt(fuel_amount) > 0) {
            await pool.query(
                'INSERT INTO expenses (user_id, type, amount, description, liters) VALUES ($1, $2, $3, $4, $5)',
                [req.session.userId, 'fuel', parseInt(fuel_amount), `Paliwo za trasę: ${disp.start_city} -> ${disp.end_city}`, parseInt(fuel_liters || 0)]
            );
        }

        // 3. Zamknięcie zlecenia
        await pool.query('UPDATE dispatches SET status = $1 WHERE id = $2', ['Zakończone', dispatchId]);

        // 4. Powiadomienie Discord
        const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        const username = userRes.rows[0] ? userRes.rows[0].username : 'Kierowca';

        const webhookUrl = "https://discord.com/api/webhooks/1558211120228073512/xYLNti0-1Q0Pn32oHAI_v0XJogBTw6LPnqNp6hbHNKK5qdbbtkjDKrdoKUWaBARI3m9J";
        const discordPayload = {
            embeds: [{
                title: `🚚 Dostawa z Dyspozytorni: ${username}`,
                color: 3447003,
                fields: [
                    { name: "Trasa", value: `${disp.start_city} ➔ ${disp.end_city}`, inline: true },
                    { name: "Towar", value: disp.cargo, inline: true },
                    { name: "\u200b", value: "\u200b", inline: false },
                    { name: "Dystans", value: `${distance} km`, inline: true },
                    { name: "Zysk", value: `${parseInt(income).toLocaleString()} €`, inline: true }
                ],
                footer: { text: "Mazren Spedition VTC" }
            }]
        };
        
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordPayload)
        }).catch(err => console.log('Błąd Discord:', err));

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Błąd kończenia zlecenia' });
    }
});

app.delete('/api/dispatches/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM dispatches WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd usuwania zlecenia' });
    }
});

// --- TRASY I ZWYKŁE ZLECENIA ---

app.get('/api/jobs', async (req, res) => {
    try {
        const query = `
            SELECT jobs.*, users.username 
            FROM jobs 
            JOIN users ON jobs.user_id = users.id 
            ORDER BY jobs.id DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania tras' });
    }
});

app.delete('/api/jobs/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    try {
        const jobId = req.params.id;
        const jobRes = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
        if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Trasa nie znaleziona' });

        const job = jobRes.rows[0];
        if (job.user_id !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień' });
        }

        await pool.query('DELETE FROM jobs WHERE id = $1', [jobId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd usuwania trasy' });
    }
});

// --- FINANSE I WYDATKI ---

app.get('/api/expenses', async (req, res) => {
    try {
        const query = `
            SELECT expenses.*, users.username 
            FROM expenses 
            JOIN users ON expenses.user_id = users.id 
            ORDER BY expenses.id DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania wydatków' });
    }
});

app.post('/api/expenses', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const { type, amount, description, liters } = req.body;
    try {
        await pool.query(
            'INSERT INTO expenses (user_id, type, amount, description, liters) VALUES ($1, $2, $3, $4, $5)',
            [req.session.userId, type, parseInt(amount), description, parseInt(liters || 0)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd zapisu wydatku' });
    }
});

app.put('/api/expenses/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const expenseId = req.params.id;
    const { amount, description } = req.body;
    try {
        const expRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [expenseId]);
        if (expRes.rows.length === 0) return res.status(404).json({ error: 'Wydatek nie znaleziony' });
        
        const exp = expRes.rows[0];
        if (exp.user_id !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień' });
        }

        await pool.query('UPDATE expenses SET amount = $1, description = $2 WHERE id = $3', [parseInt(amount), description, expenseId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd edycji wydatku' });
    }
});

app.delete('/api/expenses/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Brak sesji' });
    const expenseId = req.params.id;
    try {
        const expRes = await pool.query('SELECT * FROM expenses WHERE id = $1', [expenseId]);
        if (expRes.rows.length === 0) return res.status(404).json({ error: 'Wydatek nie znaleziony' });
        
        const exp = expRes.rows[0];
        if (exp.user_id !== req.session.userId && req.session.role !== 'admin') {
            return res.status(403).json({ error: 'Brak uprawnień' });
        }

        await pool.query('DELETE FROM expenses WHERE id = $1', [expenseId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd usuwania wydatku' });
    }
});

// --- STATYSTYKI FIRMY ---

app.get('/api/company-stats', async (req, res) => {
    try {
        const totalKmRes = await pool.query('SELECT SUM(distance) as total FROM jobs');
        const totalIncomeRes = await pool.query('SELECT SUM(income) as total_income FROM jobs');
        const totalExpensesRes = await pool.query('SELECT SUM(amount) as total_expenses FROM expenses');
        
        const totalCompanyKm = parseInt(totalKmRes.rows[0].total || 0);
        const totalIncome = parseInt(totalIncomeRes.rows[0].total_income || 0);
        const totalExpenses = parseInt(totalExpensesRes.rows[0].total_expenses || 0);
        const totalCompanyBudget = totalIncome - totalExpenses;

        const rankingRes = await pool.query(`
            SELECT users.username, SUM(jobs.distance) as km 
            FROM jobs 
            JOIN users ON jobs.user_id = users.id 
            GROUP BY users.username 
            ORDER BY km DESC
        `);

        res.json({
            totalCompanyKm,
            totalIncome,
            totalExpenses,
            totalCompanyBudget,
            driversRanking: rankingRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: 'Błąd statystyk firmy' });
    }
});

// --- GARAŻ VTC ---

app.get('/api/trucks', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM trucks ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania floty' });
    }
});

app.post('/api/trucks', upload.single('truck_photo'), async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const { driver_name, truck_model, trailer_model, plates } = req.body;
    const photoUrl = 'https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/wzor.jpg';

    try {
        await pool.query(
            'INSERT INTO trucks (driver_name, truck_model, trailer_model, plates, photo) VALUES ($1, $2, $3, $4, $5)',
            [driver_name, truck_model, trailer_model || '', plates, photoUrl]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd dodawania pojazdu' });
    }
});

app.put('/api/trucks/:id', upload.single('truck_photo'), async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const { driver_name, truck_model, trailer_model, plates } = req.body;
    try {
        await pool.query(
            'UPDATE trucks SET driver_name = $1, truck_model = $2, trailer_model = $3, plates = $4 WHERE id = $5',
            [driver_name, truck_model, trailer_model || '', plates, req.params.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd edycji pojazdu' });
    }
});

app.delete('/api/trucks/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('DELETE FROM trucks WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd usuwania pojazdu' });
    }
});

app.listen(PORT, () => {
    console.log(`Serwer VTC działa na porcie ${PORT}`);
});
