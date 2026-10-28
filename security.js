'use strict';

const crypto = require('node:crypto');

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

// Bound all in-memory multipart parsing, including requests that later fail validation.
function uploadSlots(max = 2) {
    let active = 0;
    return (req, res, next) => {
        if (active >= max) {
            res.set('Retry-After', '10');
            return res.status(503).json({ error: 'Trwa przesyłanie innych plików. Spróbuj za chwilę.' });
        }
        active++;
        let released = false;
        const release = () => {
            if (!released) { released = true; active--; }
        };
        res.once('finish', release);
        res.once('close', release);
        next();
    };
}

// Atomic counters in PostgreSQL survive restarts and are shared by all instances.
function recruitmentLimiter(pool) {
    return async (req, res, next) => {
        const key = crypto.createHash('sha256').update(req.ip || req.socket?.remoteAddress || 'unknown').digest('hex');
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');
            // Global first bounds the number of persistent IP counters. Roll back both
            // reservations if either limit is reached so one IP cannot spend all slots.
            for (const [scope, subject, limit] of [['recruitment-global', 'all', 10], ['recruitment-ip', key, 3]]) {
                const result = await client.query(`
                    INSERT INTO security_rate_limits (scope, subject, window_start, hits)
                    VALUES ($1, $2, date_trunc('hour', NOW()), 1)
                    ON CONFLICT (scope, subject, window_start) DO UPDATE
                    SET hits = security_rate_limits.hits + 1
                    WHERE security_rate_limits.hits < $3
                    RETURNING hits`, [scope, subject, limit]);
                if (!result.rows.length) {
                    await client.query('ROLLBACK');
                    res.set('Retry-After', '3600');
                    return res.status(429).json({ error: 'Limit prób rekrutacji został osiągnięty. Spróbuj za godzinę.' });
                }
            }
            await client.query('COMMIT');
            next();
        } catch (error) {
            if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
            console.error('Błąd limitu rekrutacji:', error.message);
            res.set('Retry-After', '60');
            res.status(503).json({ error: 'Rekrutacja chwilowo niedostępna. Spróbuj później.' });
        } finally {
            if (client) client.release();
        }
    };
}

function validFileSignature(file) {
    const b = file && file.buffer;
    if (!Buffer.isBuffer(b)) return false;
    switch (file.mimetype) {
        case 'image/jpeg': return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
        case 'image/png': return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        case 'image/webp': return b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
        case 'image/gif': return ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6));
        case 'application/pdf': return b.toString('ascii', 0, 5) === '%PDF-';
        default: return false;
    }
}

async function checkRecruitmentCapacity(client, incomingBytes, capBytes) {
    // Serialize checks and writes across application instances, not just one process.
    await client.query('SELECT pg_advisory_xact_lock(172904, 1)');
    const used = await client.query(`
        SELECT COALESCE(SUM(octet_length(f.data)), 0)::bigint AS bytes
        FROM files f WHERE EXISTS (
            SELECT 1 FROM recruitment_applications ra
            WHERE ra.screenshot_one_file_id = f.id OR ra.screenshot_two_file_id = f.id
        )`);
    if (Number(used.rows[0].bytes) + incomingBytes > capBytes) {
        throw httpError(503, 'Rekrutacja chwilowo niedostępna. Skontaktuj się z kadrą.');
    }
}

module.exports = { httpError, uploadSlots, recruitmentLimiter, validFileSignature, checkRecruitmentCapacity };
