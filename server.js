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

            CREATE TABLE IF NOT EXISTS trucks (
                id SERIAL PRIMARY KEY,
                driver_name VARCHAR(255) NOT NULL,
                truck_model VARCHAR(255) NOT NULL,
                trailer_model VARCHAR(255),
                plates VARCHAR(50) NOT NULL,
                photo TEXT NOT NULL
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
        const monthlyKm = parseInt(
