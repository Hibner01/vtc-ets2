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
                cargo VARCHAR(255) DEFAULT 'Standard',
                notes TEXT,
                truck_name VARCHAR(255),
                status VARCHAR(50) DEFAULT 'W wolnym obiegu',
                accepted_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                accepted_by_username VARCHAR(255),
                reported_distance INTEGER DEFAULT 0,
                reported_income INTEGER DEFAULT 0,
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

// --- AUTORYZACJA I REJESTRACJA ---

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
            res.json({ success: true, message: 'Konto zostało utworzone. Poczekaj na zatwierdzenie przez Szefa!' });
        } else {
            res.json({ success: true, message: 'Konto administratora zostało utworzone!' });
        }
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
        if (user.status === 'pending') {
            return res.status(403).json({ error: 'Twoje konto oczekuje na zatwierdzenie przez Szefa!' });
        }

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
        const userRes = await pool.query('SELECT id, username, role, status FROM users WHERE id = $1', [req.session.userId]);
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
    req.session.destroy(() => res.json({ success: true }));
});

// --- PANEL SZEFA: AKCEPTACJA KONT I UŻYTKOWNICY ---

app.get('/api/users', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        const result = await pool.query('SELECT id, username, role, status FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania użytkowników' });
    }
});

app.put('/api/users/:id/approve', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    try {
        await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['approved', req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd zatwierdzania konta' });
    }
});

app.put('/api/users/:id/password', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const { newPassword } = req.body;
    try {
        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd zmiany hasła' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Nie możesz usunąć siebie.' });

    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
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
        res.status(500).json({ error: 'Błąd pobierania zleceń' });
    }
});

app.post('/api/dispatches', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const { assigned_to, start_city, end_city, truck_name, notes } = req.body;
    try {
        await pool.query(
            'INSERT INTO dispatches (assigned_to, start_city, end_city, truck_name, notes) VALUES ($1, $2, $3, $4, $5)',
            [assigned_to || 'Wszyscy', start_city, end_city, truck_name || 'Standardowy Zestaw', notes || '']
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
        if (disp.status !== 'W wolnym obiegu') return res.status(400).json({ error: 'Zlecenie zostało już przyjęte!' });

        const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        const username = userRes.rows[0].username;

        if (disp.assigned_to !== 'Wszyscy' && disp.assigned_to !== username) {
            return res.status(403).json({ error: `Zlecenie przeznaczone tylko dla: ${disp.assigned_to}` });
        }

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
    const { distance, income, cargo, fuel_amount, fuel_liters } = req.body;

    try {
        const dispRes = await pool.query('SELECT * FROM dispatches WHERE id = $1', [dispatchId]);
        if (dispRes.rows.length === 0) return res.status(404).json({ error: 'Zlecenie nie znalezione' });
        
        await pool.query(
            'UPDATE dispatches SET status = $1, reported_distance = $2, reported_income = $3, cargo = $4 WHERE id = $5',
            ['Oczekuje na zatwierdzenie', parseInt(distance), parseInt(income), cargo || 'Towar', dispatchId]
        );

        if (fuel_amount && parseInt(fuel_amount) > 0) {
            await pool.query(
                'INSERT INTO expenses (user_id, type, amount, description, liters) VALUES ($1, $2, $3, $4, $5)',
                [req.session.userId, 'fuel', parseInt(fuel_amount), `Tankowanie w trasie`, parseInt(fuel_liters || 0)]
            );
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd rozliczania zlecenia' });
    }
});

app.put('/api/dispatches/:id/approve', async (req, res) => {
    if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Brak uprawnień' });
    const dispatchId = req.params.id;

    try {
        const dispRes = await pool.query('SELECT * FROM dispatches WHERE id = $1', [dispatchId]);
        if (dispRes.rows.length === 0) return res.status(404).json({ error: 'Zlecenie nie znalezione' });
        const disp = dispRes.rows[0];

        await pool.query(
            'INSERT INTO jobs (user_id, start_city, end_city, cargo, distance, income, cmr_file, summary_photo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [disp.accepted_by_id, disp.start_city, disp.end_city, disp.cargo, disp.reported_distance, disp.reported_income, 'https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/wzor.jpg', 'https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/przyklad-summary.jpg']
        );

        await pool.query('UPDATE dispatches SET status = $1 WHERE id = $2', ['Zakończone', dispatchId]);

        const rankingRes = await pool.query(`
            SELECT users.id, users.username, SUM(jobs.distance) as km 
            FROM jobs JOIN users ON jobs.user_id = users.id 
            GROUP BY users.id, users.username ORDER BY km DESC
        `);
        
        let rankPosition = 1;
        rankingRes.rows.forEach((r, idx) => {
            if (parseInt(r.id) === parseInt(disp.accepted_by_id)) rankPosition = idx + 1;
        });

        const webhookUrl = "https://discord.com/api/webhooks/1558211120228073512/xYLNti0-1Q0Pn32oHAI_v0XJogBTw6LPnqNp6hbHNKK5qdbbtkjDKrdoKUWaBARI3m9J";
        const discordPayload = {
            embeds: [{
                title: `Dostawa #${disp.id}`,
                description: `**[Rzeczywiste]** - ${disp.reported_distance} km\n\n**Z**\n🏙️ ${disp.start_city}\n**Do**\n🏙️ ${disp.end_city}\n\n**Detale**\nTowar: ${disp.cargo}\nZaakceptowany dystans: ${disp.reported_distance} km\nZysk: ${disp.reported_income.toLocaleString()} €\nCiągnik: ${disp.truck_name || 'Scania/Volvo'}\nStatystyki: Rzeczywiste\nPozycja w firmie: ${rankPosition}.`,
                color: 3447003,
                author: { name: disp.accepted_by_username },
                thumbnail: { url: "https://raw.githubusercontent.com/Hibner01/vtc-ets2/main/public/uploads/wzor.jpg" },
                footer: { text: "Mazren Spedition • Webhook VTC" }
            }]
        };

        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordPayload)
        }).catch(e => console.log('Błąd Discord:', e));

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Błąd zatwierdzania trasy' });
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

// --- FINANSE I NAPRAWA SERWIS/PALIWO ---

app.get('/api/expenses', async (req, res) => {
    try {
        const query = `
            SELECT expenses.*, users.username 
            FROM expenses JOIN users ON expenses.user_id = users.id 
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
    
    const parsedAmount = parseInt(amount) || 0;
    const parsedLiters = parseInt(liters) || 0;
    const expType = type || 'fuel';
    const finalDesc = (description && description.trim() !== '') 
        ? description.trim() 
        : (expType === 'fuel' ? 'Tankowanie' : 'Serwis / Naprawa');

    if (parsedAmount <= 0) {
        return res.status(400).json({ error: 'Kwota wydatku musi być większa od 0.' });
    }

    try {
        await pool.query(
            'INSERT INTO expenses (user_id, type, amount, description, liters) VALUES ($1, $2, $3, $4, $5)',
            [req.session.userId, expType, parsedAmount, finalDesc, parsedLiters]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Błąd dodawania wydatku:', err);
        res.status(500).json({ error: 'Błąd zapisu wydatku' });
    }
});

// --- TRASY I GARAŻ ---

app.get('/api/jobs', async (req, res) => {
    try {
        const result = await pool.query('SELECT jobs.*, users.username FROM jobs JOIN users ON jobs.user_id = users.id ORDER BY jobs.id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Błąd pobierania tras' });
    }
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
    } catch (err) {
        res.status(500).json({ error: 'Błąd statystyk' });
    }
});

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
        await pool.query('INSERT INTO trucks (driver_name, truck_model, trailer_model, plates, photo) VALUES ($1, $2, $3, $4, $5)', [driver_name, truck_model, trailer_model || '', plates, photoUrl]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Błąd dodawania pojazdu' });
    }
});

app.listen(PORT, () => console.log(`Serwer VTC działa na porcie ${PORT}`));
