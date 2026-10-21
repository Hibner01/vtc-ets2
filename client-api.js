// =====================================================================
//  client-api.js  -  API dla aplikacji kierowcy (odczyt telemetrii z ETS2)
//
//  Podpinane w server.js jednym wywołaniem:
//      const clientApi = require('./client-api')({ app, pool, requireLogin, addNotification });
//
//  Autoryzacja aplikacji kierowcy: nagłówek  Authorization: Bearer <token>
//  Token generuje kierowca na stronie (zakładka "Aplikacja"). W bazie
//  trzymamy tylko jego skrót SHA-256, więc wyciek bazy nie ujawnia tokenów.
// =====================================================================
const crypto = require('crypto');

// Ustawienia (zmienne środowiskowe na Renderze):
//  AUTO_APPROVE_TRIPS=true  -> kursy zgodne ze zleceniem zatwierdzają się same
//                              (domyślnie: false, Szef zatwierdza ręcznie)
//  REQUIRE_DISPATCH=true    -> kurs bez pasującego, przyjętego zlecenia jest odrzucany
//                              (domyślnie: false, taki kurs trafia do Szefa jako "bez zlecenia")
const AUTO_APPROVE = String(process.env.AUTO_APPROVE_TRIPS || '').toLowerCase() === 'true';
const REQUIRE_DISPATCH = String(process.env.REQUIRE_DISPATCH || '').toLowerCase() === 'true';

//  LENIENT_LINK=false      -> wyłącza łączenie kursu z jedynym przyjętym zleceniem, gdy trasa w grze
//                              jest INNA niż w zleceniu (domyślnie: true, Szef widzi ostrzeżenie)
const LENIENT_LINK = String(process.env.LENIENT_LINK || 'true').toLowerCase() !== 'false';

const MAX_POINTS_PER_BATCH = 300;
const MAX_POINTS_PER_TRIP = 20000;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// "Frankfurt am Main" == "frankfurt-am-main" == "Frankfürt am Main".
// ETS2 telemetry can also return the English city name while the dispatch
// uses its Polish exonym (for example, Riga vs. Ryga).
const CITY_ALIASES = new Map([
    ['riga', 'ryga'],
    ['ryga', 'ryga'],
]);

function normCity(s) {
    const normalized = String(s || '')
        .toLowerCase()
        .replace(/ł/g, 'l')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
    return CITY_ALIASES.get(normalized) || normalized;
}
function cityMatch(a, b) {
    const x = normCity(a), y = normCity(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x));
}

const cleanStr = (v, max = 255) => String(v == null ? '' : v).trim().slice(0, max);
const cleanNum = (v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
};

module.exports = function ({ app, pool, requireLogin, addNotification }) {

    // ------------------------------------------------------------------
    //  Tabele (wywoływane z initDB w server.js)
    // ------------------------------------------------------------------
    async function initTables() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS api_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash VARCHAR(64) NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);

            CREATE TABLE IF NOT EXISTS trips (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                dispatch_id INTEGER,
                job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
                start_city VARCHAR(255),
                end_city VARCHAR(255),
                cargo VARCHAR(255),
                distance INTEGER DEFAULT 0,
                income INTEGER DEFAULT 0,
                fuel_used INTEGER DEFAULT 0,
                damage_pct NUMERIC(5,2) DEFAULT 0,
                max_speed INTEGER DEFAULT 0,
                status VARCHAR(30) DEFAULT 'active',
                matched BOOLEAN DEFAULT false,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                finished_at TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS trips_job_idx ON trips (job_id);
            CREATE INDEX IF NOT EXISTS trips_user_status_idx ON trips (user_id, status);
            -- jeden aktywny kurs na kierowcę
            CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_idx ON trips (user_id) WHERE status = 'active';

            CREATE TABLE IF NOT EXISTS trip_points (
                id BIGSERIAL PRIMARY KEY,
                trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
                t BIGINT NOT NULL,
                x REAL NOT NULL,
                z REAL NOT NULL,
                speed REAL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS trip_points_trip_idx ON trip_points (trip_id, t);
        `);
    }

    // Sprzątanie: porzucone kursy i kursy odrzuconych tras nie zaśmiecają darmowej bazy.
    async function housekeeping() {
        try {
            await pool.query("UPDATE trips SET status = 'aborted', finished_at = NOW() WHERE status = 'active' AND started_at < NOW() - INTERVAL '2 days'");
            await pool.query("DELETE FROM trips WHERE status IN ('aborted','cancelled') AND COALESCE(finished_at, started_at) < NOW() - INTERVAL '7 days'");
            await pool.query("DELETE FROM trips WHERE status = 'finished' AND job_id IS NULL AND finished_at < NOW() - INTERVAL '7 days'");
        } catch (e) { /* tabele mogą jeszcze nie istnieć przy pierwszym starcie */ }
    }
    setInterval(housekeeping, 60 * 60 * 1000);
    setTimeout(housekeeping, 30 * 1000);

    // ------------------------------------------------------------------
    //  Zarządzanie tokenem (z poziomu strony, sesja kierowcy)
    // ------------------------------------------------------------------
    app.get('/api/client/token/status', requireLogin, async (req, res) => {
        try {
            const r = await pool.query('SELECT created_at, last_used_at FROM api_tokens WHERE user_id = $1', [req.session.userId]);
            res.json(r.rows.length
                ? { has_token: true, created_at: r.rows[0].created_at, last_used_at: r.rows[0].last_used_at }
                : { has_token: false });
        } catch (e) { res.status(500).json({ error: 'Błąd odczytu tokenu' }); }
    });

    // Generuje NOWY token (stary przestaje działać). Token jest pokazany tylko raz.
    app.post('/api/client/token', requireLogin, async (req, res) => {
        try {
            const token = crypto.randomBytes(24).toString('hex'); // 48 znaków hex
            await pool.query(
                `INSERT INTO api_tokens (user_id, token_hash) VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET token_hash = $2, created_at = NOW(), last_used_at = NULL`,
                [req.session.userId, sha256(token)]
            );
            res.json({ success: true, token });
        } catch (e) {
            console.error('Błąd generowania tokenu:', e.message);
            res.status(500).json({ error: 'Błąd generowania tokenu' });
        }
    });

    app.delete('/api/client/token', requireLogin, async (req, res) => {
        try {
            await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [req.session.userId]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Błąd odwoływania tokenu' }); }
    });

    // ------------------------------------------------------------------
    //  Autoryzacja aplikacji kierowcy (Bearer token)
    // ------------------------------------------------------------------
    const calls = new Map(); // proste ograniczenie: max 120 żądań / minutę / kierowcę
    setInterval(() => calls.clear(), 60 * 1000);

    async function clientAuth(req, res, next) {
        const m = /^Bearer\s+([a-f0-9]{48})$/i.exec(req.headers.authorization || '');
        if (!m) return res.status(401).json({ error: 'Brak lub zły token. Wygeneruj nowy na stronie (zakładka Aplikacja).' });
        const hash = sha256(m[1].toLowerCase());
        try {
            const r = await pool.query(
                `SELECT u.id, u.username, u.status FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
                [hash]
            );
            if (r.rows.length === 0) return res.status(401).json({ error: 'Token nieważny. Wygeneruj nowy na stronie.' });
            const u = r.rows[0];
            if (u.status !== 'approved') return res.status(403).json({ error: 'Konto nieaktywne.' });

            const n = (calls.get(u.id) || 0) + 1;
            calls.set(u.id, n);
            if (n > 120) return res.status(429).json({ error: 'Za dużo żądań, zwolnij.' });

            req.clientUser = { id: u.id, username: u.username };
            pool.query('UPDATE api_tokens SET last_used_at = NOW() WHERE token_hash = $1', [hash]).catch(() => {});
            next();
        } catch (e) {
            console.error('Błąd autoryzacji klienta:', e.message);
            res.status(500).json({ error: 'Błąd serwera' });
        }
    }

    // Kto jestem + jakie mam przyjęte zlecenia (klient pokazuje to w konsoli).
    app.get('/api/client/me', clientAuth, async (req, res) => {
        try {
            const d = await pool.query(
                "SELECT id, start_city, end_city, cargo, truck_name FROM dispatches WHERE accepted_by_id = $1 AND status = 'W trakcie' ORDER BY id",
                [req.clientUser.id]
            );
            const t = await pool.query(
                `SELECT t.id, t.start_city, t.end_city, t.dispatch_id, t.matched,
                        d.start_city AS dispatch_start_city, d.end_city AS dispatch_end_city
                 FROM trips t
                 LEFT JOIN dispatches d ON d.id = t.dispatch_id
                     AND d.accepted_by_id = $1 AND d.status = 'W trakcie'
                 WHERE t.user_id = $1 AND t.status = 'active'`,
                [req.clientUser.id]
            );
            let activeTrip = t.rows[0] || null;
            if (activeTrip) {
                const matchesDispatch = activeTrip.dispatch_start_city && activeTrip.dispatch_end_city
                    && cityMatch(activeTrip.dispatch_start_city, activeTrip.start_city)
                    && cityMatch(activeTrip.dispatch_end_city, activeTrip.end_city);
                if (matchesDispatch) {
                    activeTrip.start_city = activeTrip.dispatch_start_city;
                    activeTrip.end_city = activeTrip.dispatch_end_city;
                }
                activeTrip = {
                    id: activeTrip.id,
                    start_city: activeTrip.start_city,
                    end_city: activeTrip.end_city,
                };
            }
            res.json({ username: req.clientUser.username, dispatches: d.rows, active_trip: activeTrip });
        } catch (e) { res.status(500).json({ error: 'Błąd serwera' }); }
    });

    // ------------------------------------------------------------------
    //  Start kursu
    //  Klient wysyła miasta z gry; serwer sam szuka pasującego, PRZYJĘTEGO zlecenia.
    // ------------------------------------------------------------------
    app.post('/api/client/trips/start', clientAuth, async (req, res) => {
        const source = cleanStr(req.body.source_city);
        const dest = cleanStr(req.body.destination_city);
        const cargo = cleanStr(req.body.cargo) || null;
        if (!source || !dest) return res.status(400).json({ error: 'Brak miast trasy z telemetrii.' });

        const uid = req.clientUser.id;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // szukamy przyjętego zlecenia pasującego do trasy z gry
            const dRes = await client.query(
                "SELECT id, start_city, end_city FROM dispatches WHERE accepted_by_id = $1 AND status = 'W trakcie' ORDER BY id",
                [uid]
            );
            let dispatch = dRes.rows.find(d => cityMatch(d.start_city, source) && cityMatch(d.end_city, dest)) || null;
            const exact = !!dispatch;
            // Trasa w grze inna niż w zleceniu (np. Virtual Speditor nie umie stworzyć takiej trasy z modowej mapy):
            // jeśli kierowca ma dokładnie jedno przyjęte zlecenie, wiążemy kurs z nim i oznaczamy jako niezgodny.
            if (!dispatch && LENIENT_LINK && dRes.rows.length === 1) dispatch = dRes.rows[0];

            if (!dispatch && REQUIRE_DISPATCH) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: `Brak przyjętego zlecenia ${source} -> ${dest}. Przyjmij je najpierw na stronie (Dyspozytornia).` });
            }

            // czy jest już aktywny kurs? ten sam -> wznawiamy, inny -> porzucamy
            const act = await client.query("SELECT * FROM trips WHERE user_id = $1 AND status = 'active' FOR UPDATE", [uid]);
            if (act.rows.length > 0) {
                const a = act.rows[0];
                if (cityMatch(a.start_city, source) && cityMatch(a.end_city, dest)) {
                    const activeDispatch = dRes.rows.find(d => d.id === a.dispatch_id) || dispatch;
                    const activeMatched = !!activeDispatch
                        && cityMatch(activeDispatch.start_city, a.start_city)
                        && cityMatch(activeDispatch.end_city, a.end_city);
                    if (activeMatched && !a.matched) {
                        await client.query(
                            'UPDATE trips SET start_city = $2, end_city = $3, matched = true WHERE id = $1',
                            [a.id, activeDispatch.start_city, activeDispatch.end_city]
                        );
                    }
                    await client.query('COMMIT');
                    return res.json({
                        success: true,
                        trip_id: a.id,
                        resumed: true,
                        matched: activeMatched || !!a.matched,
                        linked: !!a.dispatch_id,
                        source_city: activeMatched ? activeDispatch.start_city : a.start_city,
                        destination_city: activeMatched ? activeDispatch.end_city : a.end_city,
                    });
                }
                await client.query("UPDATE trips SET status = 'aborted', finished_at = NOW() WHERE id = $1", [a.id]);
            }

            const ins = await client.query(
                `INSERT INTO trips (user_id, dispatch_id, start_city, end_city, cargo, matched)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [
                    uid,
                    dispatch ? dispatch.id : null,
                    exact ? dispatch.start_city : source,
                    exact ? dispatch.end_city : dest,
                    cargo,
                    exact,
                ]
            );
            await client.query('COMMIT');
            res.json({ success: true, trip_id: ins.rows[0].id, resumed: false, matched: exact, linked: !!dispatch });
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error('Błąd startu kursu:', e.message);
            res.status(500).json({ error: 'Błąd startu kursu' });
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    //  Punkty trasy (paczki)
    // ------------------------------------------------------------------
    app.post('/api/client/trips/:id/points', clientAuth, async (req, res) => {
        const tripId = parseInt(req.params.id);
        const pts = Array.isArray(req.body.points) ? req.body.points.slice(0, MAX_POINTS_PER_BATCH) : [];
        if (!tripId || pts.length === 0) return res.status(400).json({ error: 'Brak punktów.' });

        try {
            const t = await pool.query("SELECT status FROM trips WHERE id = $1 AND user_id = $2", [tripId, req.clientUser.id]);
            if (t.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono kursu.' });
            if (t.rows[0].status !== 'active') return res.status(409).json({ error: 'Kurs nie jest aktywny.' });

            const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM trip_points WHERE trip_id = $1', [tripId]);
            if (cnt.rows[0].n >= MAX_POINTS_PER_TRIP) return res.json({ success: true, stored: 0, note: 'limit punktów osiągnięty' });

            const ts = [], xs = [], zs = [], sp = [];
            for (const p of pts) {
                const x = Number(p.x), z = Number(p.z), tt = Number(p.t);
                if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(tt)) continue;
                ts.push(Math.round(tt)); xs.push(x); zs.push(z);
                sp.push(cleanNum(p.speed, 0, 400));
            }
            if (ts.length === 0) return res.status(400).json({ error: 'Niepoprawne punkty.' });

            await pool.query(
                `INSERT INTO trip_points (trip_id, t, x, z, speed)
                 SELECT $1::int, * FROM unnest($2::bigint[], $3::real[], $4::real[], $5::real[])`,
                [tripId, ts, xs, zs, sp]
            );
            res.json({ success: true, stored: ts.length });
        } catch (e) {
            console.error('Błąd zapisu punktów:', e.message);
            res.status(500).json({ error: 'Błąd zapisu punktów' });
        }
    });

    // ------------------------------------------------------------------
    //  Anulowanie kursu (np. kierowca zrezygnował ze zlecenia w grze)
    // ------------------------------------------------------------------
    app.post('/api/client/trips/:id/cancel', clientAuth, async (req, res) => {
        try {
            const r = await pool.query(
                "UPDATE trips SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id",
                [parseInt(req.params.id), req.clientUser.id]
            );
            if (r.rows.length === 0) return res.status(404).json({ error: 'Nie znaleziono aktywnego kursu.' });
            res.json({ success: true, status: 'cancelled' });
        } catch (e) { res.status(500).json({ error: 'Błąd anulowania' }); }
    });

    // ------------------------------------------------------------------
    //  Zakończenie kursu -> powstaje wpis w "jobs" (jak przy ręcznym raporcie)
    // ------------------------------------------------------------------
    app.post('/api/client/trips/:id/finish', clientAuth, async (req, res) => {
        const tripId = parseInt(req.params.id);
        const uid = req.clientUser.id;
        const username = req.clientUser.username;
        const delivered = req.body.delivered !== false;

        const distance = Math.round(cleanNum(req.body.distance, 0, 20000));
        const income = Math.round(cleanNum(req.body.income, 0, 10000000));
        const fuel = Math.round(cleanNum(req.body.fuel_used, 0, 100000));
        const damage = Math.round(cleanNum(req.body.damage_pct, 0, 100) * 100) / 100;
        const maxSpeed = Math.round(cleanNum(req.body.max_speed, 0, 400));
        const cargoBody = cleanStr(req.body.cargo);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const tRes = await client.query('SELECT * FROM trips WHERE id = $1 AND user_id = $2 FOR UPDATE', [tripId, uid]);
            if (tRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nie znaleziono kursu.' }); }
            const trip = tRes.rows[0];
            if (trip.status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Kurs jest już zamknięty.' }); }

            if (!delivered) {
                await client.query("UPDATE trips SET status = 'cancelled', finished_at = NOW() WHERE id = $1", [tripId]);
                await client.query('COMMIT');
                return res.json({ success: true, status: 'cancelled' });
            }

            // zlecenie wciąż musi być przyjęte przez tego kierowcę
            let dispatch = null;
            if (trip.dispatch_id) {
                const d = await client.query(
                    "SELECT * FROM dispatches WHERE id = $1 AND accepted_by_id = $2 AND status = 'W trakcie' FOR UPDATE",
                    [trip.dispatch_id, uid]
                );
                dispatch = d.rows[0] || null;
            }
            const linked = !!dispatch;                 // kurs powiązany z jakimś zleceniem
            // Starsze kursy mogły zostać powiązane lenientnie zanim dodano alias
            // nazwy miasta (np. Riga/Ryga). Sprawdź trasę ponownie przy zamknięciu.
            const matched = linked && (
                !!trip.matched
                || (cityMatch(dispatch.start_city, trip.start_city)
                    && cityMatch(dispatch.end_city, trip.end_city))
            );

            // zgodna trasa -> miasta ze zlecenia (z krajami); niezgodna -> to, co naprawdę przejechano (z telemetrii)
            const startCity = matched ? dispatch.start_city : trip.start_city;
            const endCity = matched ? dispatch.end_city : trip.end_city;
            const startCountry = matched ? dispatch.start_country : null;
            const endCountry = matched ? dispatch.end_country : null;
            const cargo = cargoBody || trip.cargo || (linked ? dispatch.cargo : null) || 'Standard';
            const jobStatus = (matched && AUTO_APPROVE) ? 'approved' : 'pending';

            const job = await client.query(
                `INSERT INTO jobs (user_id, start_city, end_city, start_country, end_country, cargo, distance, income, cmr_file, summary_photo, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', '', $9) RETURNING id`,
                [uid, startCity, endCity, startCountry, endCountry, cargo, Math.max(1, distance), income, jobStatus]
            );
            const jobId = job.rows[0].id;

            await client.query(
                `UPDATE trips SET status = 'finished', finished_at = NOW(), job_id = $2, matched = $3,
                        distance = $4, income = $5, fuel_used = $6, damage_pct = $7, max_speed = $8, cargo = $9
                 WHERE id = $1`,
                [tripId, jobId, matched, distance, income, fuel, damage, maxSpeed, cargo]
            );
            if (linked) await client.query('DELETE FROM dispatches WHERE id = $1', [dispatch.id]);
            await client.query('COMMIT');

            // powiadomienia (poza transakcją, błędy nie psują wyniku)
            if (jobStatus === 'approved') {
                await addNotification(uid, 'Trasa Zatwierdzona', `Trasa ${startCity} ➔ ${endCity} została zaliczona automatycznie.`, null, 'jobs');
            } else {
                const admins = await pool.query("SELECT id FROM users WHERE role = 'admin'");
                let note;
                if (matched) note = `Kierowca @${username} zakończył trasę ${startCity} ➔ ${endCity} (dane z telemetrii). Czeka na zatwierdzenie.`;
                else if (linked) note = `Kierowca @${username} zamknął zlecenie ${dispatch.start_city} ➔ ${dispatch.end_city}, ale w grze przejechał INNĄ trasę: ${startCity} ➔ ${endCity}. Sprawdź i zatwierdź lub odrzuć.`;
                else note = `Kierowca @${username} przejechał trasę ${startCity} ➔ ${endCity} BEZ przyjętego zlecenia (dane z telemetrii). Sprawdź i zatwierdź lub odrzuć.`;
                for (const adm of admins.rows) await addNotification(adm.id, 'Nowy Raport Trasy', note, jobId, 'jobs');
            }

            // trasa jest już zapisana z telemetrii, brakuje tylko CMR: przypominamy kierowcy
            await addNotification(uid, 'Dodaj CMR', `Trasa ${startCity} ➔ ${endCity} została zapisana z telemetrii. Dodaj zdjęcie CMR: Pulpit → Moje trasy → Dodaj CMR.`, jobId, 'jobs');

            res.json({ success: true, status: 'finished', job_id: jobId, matched, linked, job_status: jobStatus });
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) {}
            console.error('Błąd zamykania kursu:', e.message);
            res.status(500).json({ error: 'Błąd zamykania kursu' });
        } finally {
            client.release();
        }
    });

    // ------------------------------------------------------------------
    //  Podgląd trasy na stronie (zalogowani)
    // ------------------------------------------------------------------
    app.get('/api/trips/by-job/:jobId', requireLogin, async (req, res) => {
        try {
            const t = await pool.query(
                `SELECT id, start_city, end_city, cargo, distance, income, fuel_used, damage_pct, max_speed,
                        started_at, finished_at, matched, (dispatch_id IS NOT NULL) AS linked
                 FROM trips WHERE job_id = $1 ORDER BY id DESC LIMIT 1`,
                [parseInt(req.params.jobId)]
            );
            if (t.rows.length === 0) return res.status(404).json({ error: 'Brak zapisu trasy dla tego kursu.' });

            const p = await pool.query('SELECT t, x, z, speed FROM trip_points WHERE trip_id = $1 ORDER BY t', [t.rows[0].id]);
            let rows = p.rows;
            const LIMIT = 1500; // ograniczamy rozmiar odpowiedzi
            if (rows.length > LIMIT) {
                const step = rows.length / LIMIT;
                const picked = [];
                for (let i = 0; i < LIMIT; i++) picked.push(rows[Math.floor(i * step)]);
                picked.push(rows[rows.length - 1]);
                rows = picked;
            }
            res.json({
                trip: t.rows[0],
                points: rows.map(r => [Number(r.t), r.x, r.z, r.speed])
            });
        } catch (e) {
            console.error('Błąd pobierania trasy:', e.message);
            res.status(500).json({ error: 'Błąd pobierania trasy' });
        }
    });

    return { initTables };
};
