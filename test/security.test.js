'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { uploadSlots, recruitmentLimiter, validFileSignature, checkRecruitmentCapacity } = require('../security');

function response() {
    return Object.assign(new EventEmitter(), {
        statusCode: 200, headers: {},
        status(n) { this.statusCode = n; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        json(body) { this.body = body; return this; }
    });
}

test('upload slots reject excess work and release exactly once on close/finish', () => {
    const guard = uploadSlots(1);
    const first = response();
    let admitted = 0;
    guard({}, first, () => admitted++);
    const blocked = response();
    guard({}, blocked, () => admitted++);
    assert.equal(blocked.statusCode, 503);
    first.emit('close'); first.emit('finish');
    const second = response();
    guard({}, second, () => admitted++);
    const stillBlocked = response();
    guard({}, stillBlocked, () => admitted++);
    assert.equal(stillBlocked.statusCode, 503);
    assert.equal(admitted, 2);
});

function limiterDatabase() {
    let counters = new Map();
    return {
        async connect() {
            let staged;
            return {
                async query(sql, params) {
                    if (sql === 'BEGIN') { staged = new Map(counters); return {}; }
                    if (sql === 'COMMIT') { counters = staged; return {}; }
                    if (sql === 'ROLLBACK') return {};
                    const [scope, subject, limit] = params;
                    const key = scope + ':' + subject;
                    const hits = staged.get(key) || 0;
                    if (hits >= limit) return { rows: [] };
                    staged.set(key, hits + 1);
                    return { rows: [{ hits: hits + 1 }] };
                }, release() {}
            };
        }
    };
}

test('recruitment limits persist across middleware instances and rejected IPs do not spend global quota', async () => {
    const database = limiterDatabase();
    const attempt = async (ip, limiter = recruitmentLimiter(database)) => {
        const res = response();
        let allowed = false;
        await limiter({ ip }, res, () => { allowed = true; });
        return { res, allowed };
    };
    for (let i = 0; i < 3; i++) assert.equal((await attempt('127.0.0.1')).allowed, true);
    for (let i = 0; i < 12; i++) assert.equal((await attempt('127.0.0.1')).res.statusCode, 429);
    for (let i = 0; i < 7; i++) assert.equal((await attempt('127.0.0.' + (i + 2))).allowed, true);
    assert.equal((await attempt('127.0.0.100')).res.statusCode, 429);
});

test('recruitment fails closed when its database is unavailable', async () => {
    const res = response();
    await recruitmentLimiter({ async connect() { throw new Error('test outage'); } })({}, res, () => assert.fail('must not admit'));
    assert.equal(res.statusCode, 503);
});

test('file validation rejects an HTML body with a forged image MIME', () => {
    assert.equal(validFileSignature({ mimetype: 'image/png', buffer: Buffer.from('<html><script>bad()</script>') }), false);
    assert.equal(validFileSignature({ mimetype: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }), true);
    assert.equal(validFileSignature({ mimetype: 'text/html', buffer: Buffer.from('text') }), false);
});

test('recruitment capacity permits exact boundary, rejects excess and locks before checking', async () => {
    const calls = [];
    const client = { async query(sql) {
        calls.push(sql);
        return { rows: [{ bytes: '100' }] };
    } };
    await checkRecruitmentCapacity(client, 28, 128);
    assert.match(calls[0], /pg_advisory_xact_lock/);
    await assert.rejects(checkRecruitmentCapacity(client, 29, 128), error => error.status === 503);
});

// Exercise the real Express routes and Multer using an isolated session store and
// database double. No production database, Discord, or external service is used.
function isolatedApp(query) {
    const filename = path.resolve(__dirname, '../server.js');
    const localRequire = createRequire(filename);
    const realSession = localRequire('express-session');
    function session(options) { return realSession({ ...options, store: new realSession.MemoryStore() }); }
    session.Store = realSession.Store;
    const pool = { query, connect: async () => ({ query, release() {} }) };
    const customRequire = name => {
        if (name === 'pg') return { Pool: function () { return pool; } };
        if (name === 'express-session') return session;
        if (name === './client-api') return () => ({ initTables: async () => {} });
        return localRequire(name);
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: customRequire, module, __dirname: path.dirname(filename),
        process: { env: { SESSION_SECRET: 'test-only-secret-with-sufficient-entropy' } },
        console, Buffer, URL, setInterval() {}, setTimeout, clearTimeout, AbortController,
        fetch: () => assert.fail('no external calls expected')
    }, { filename });
    return module.exports.app;
}

async function withServer(app, fn) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try { await fn('http://127.0.0.1:' + server.address().port); }
    finally { await new Promise(resolve => server.close(resolve)); }
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const photo = () => new Blob([png], { type: 'image/png' });

test('anonymous uploads are refused before malformed multipart parsing', async () => {
    const app = isolatedApp(async () => assert.fail('anonymous upload must not query database'));
    await withServer(app, async base => {
        for (const [route, expected] of [['/api/documents', 403], ['/api/dispatches/1/complete', 401], ['/api/trucks', 403]]) {
            const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'broken body' });
            assert.equal(res.status, expected, route);
        }
    });
});

test('closed recruitment is checked before parsing a malformed multipart body', async () => {
    const app = isolatedApp(async sql => ({ rows: sql.includes('recruitment_open') ? [{ value: 'false' }] : [{ hits: 1 }] }));
    await withServer(app, async base => {
        const res = await fetch(base + '/api/recruitment/applications', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'broken' });
        assert.equal(res.status, 403);
    });
});

test('authenticated document uploads work, reject forged content and excess files', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('correct-test-password', 4);
    let files = 0, documents = 0;
    const app = isolatedApp(async sql => {
        if (sql.includes('SELECT * FROM users WHERE')) return { rows: [{ id: 1, username: 'Test', role: 'admin', status: 'approved', password: hash }] };
        if (sql.includes('INSERT INTO files')) { files++; return { rows: [{ id: files }] }; }
        if (sql.includes('INSERT INTO documents')) { documents++; return { rows: [] }; }
        return { rows: [] };
    });
    await withServer(app, async base => {
        const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test', password: 'correct-test-password' }) });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const send = form => fetch(base + '/api/documents', { method: 'POST', headers: { cookie }, body: form });
        const good = new FormData(); good.set('title', 'Test'); good.set('doc_file', photo(), 'test.png');
        assert.equal((await send(good)).status, 200);
        assert.equal(documents, 1);
        const bad = new FormData(); bad.set('doc_file', new Blob(['<html>'], { type: 'image/png' }), 'fake.png');
        assert.equal((await send(bad)).status, 400);
        const duplicate = new FormData(); duplicate.append('doc_file', photo(), '1.png'); duplicate.append('doc_file', photo(), '2.png');
        assert.equal((await send(duplicate)).status, 400);
        assert.equal(files, 1);
    });
});

function applicationForm() {
    const form = new FormData();
    const fields = {
        fullName: 'Test Candidate', discordName: 'TestDriver', age: '20', ets2Hours: '200',
        about: 'To jest pierwsze zdanie. To jest drugie zdanie. To jest trzecie zdanie.',
        skills: 'Umiem prowadzić pojazdy.', previousCompanies: 'Brak', dlcs: 'Brak', ets2Apps: 'Brak',
        motivation: 'Chcę dołączyć do firmy i wspólnie jeździć.', signature: 'Test',
        steamUrl: 'https://steamcommunity.com/id/test'
    };
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set('screenshotOne', photo(), 'one.png'); form.set('screenshotTwo', photo(), 'two.png');
    return form;
}

test('valid recruitment commits two photos and an application; a full quota rolls back before writing files', async () => {
    for (const full of [false, true]) {
        let files = 0;
        const queries = [];
        const app = isolatedApp(async sql => {
            queries.push(sql);
            if (sql.includes('INSERT INTO security_rate_limits')) return { rows: [{ hits: 1 }] };
            if (sql.includes('recruitment_open')) return { rows: [{ value: 'true' }] };
            if (sql.includes('octet_length')) return { rows: [{ bytes: full ? String(128 * 1024 * 1024) : '0' }] };
            if (sql.includes('INSERT INTO files')) return { rows: [{ id: ++files }] };
            if (sql.includes('INSERT INTO recruitment_applications')) return { rows: [{ id: 1 }] };
            return { rows: [] };
        });
        await withServer(app, async base => {
            const res = await fetch(base + '/api/recruitment/applications', { method: 'POST', body: applicationForm() });
            assert.equal(res.status, full ? 503 : 201);
            assert.equal(files, full ? 0 : 2);
            assert.ok(queries.includes(full ? 'ROLLBACK' : 'COMMIT'));
        });
    }
});

test('multipart file and field size limits reject oversized authenticated input', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('correct-test-password', 4);
    const app = isolatedApp(async sql => {
        if (sql.includes('SELECT * FROM users WHERE')) return { rows: [{ id: 1, username: 'Test', role: 'admin', status: 'approved', password: hash }] };
        assert.fail('oversized input must not be saved');
    });
    await withServer(app, async base => {
        const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'test', password: 'correct-test-password' }) });
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const oversized = new FormData(); oversized.set('doc_file', new Blob([Buffer.alloc(12 * 1024 * 1024 + 1)], { type: 'image/png' }), 'large.png');
        assert.equal((await fetch(base + '/api/documents', { method: 'POST', headers: { cookie }, body: oversized })).status, 413);
        const largeField = new FormData(); largeField.set('content', 'x'.repeat(16 * 1024 + 1));
        assert.equal((await fetch(base + '/api/documents', { method: 'POST', headers: { cookie }, body: largeField })).status, 400);
    });
});

// Run actual render functions with malicious saved data, not a copy of their logic.
const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
function frontendFunction(name) {
    const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.notEqual(start, -1, name);
    const end = html.indexOf('\n        }', start);
    return html.slice(start, end + '\n        }'.length);
}

test('saved report XSS is escaped in both personal and company views; script links are rejected', async () => {
    const attack = '<img src=x onerror="globalThis.compromised=true">';
    for (const name of ['loadMyJobs', 'loadAllJobs']) {
        const container = { innerHTML: '' };
        const context = vm.createContext({
            window: { location: { origin: 'https://example.test' } }, URL, console,
            document: { getElementById: () => container },
            fetch: async () => ({ ok: true, json: async () => [{ id: 1, username: attack, cargo: attack, start_city: 'A', end_city: 'B', cmr_file: 'javascript:alert(1)' }] }),
            currentUsername: attack, cacheJobs() {}, isStaff: () => false,
            placeHtml: value => value
        });
        for (const fn of ['escapeHtml', 'safeAttachmentUrl', name]) vm.runInContext(frontendFunction(fn), context);
        await vm.runInContext(name + '()', context);
        assert.ok(!container.innerHTML.includes('<img'), name);
        assert.ok(container.innerHTML.includes('&lt;img'), name);
        assert.ok(!container.innerHTML.includes('javascript:'), name);
    }
});

test('dispatch text and city arguments do not become executable markup', async () => {
    const attack = "'><img src=x onerror=alert(1)>";
    const container = { innerHTML: '' };
    const context = vm.createContext({
        console, document: { getElementById: () => container },
        fetch: async () => ({ ok: true, json: async () => [{ id: 1, status: 'W trakcie', accepted_by_username: attack, assigned_to: attack, start_city: attack, end_city: attack, truck_name: attack, notes: attack }] }),
        isStaff: () => true, currentUsername: attack, placeHtml: () => 'A', t: value => value
    });
    for (const name of ['escapeHtml', 'loadDispatches']) vm.runInContext(frontendFunction(name), context);
    await vm.runInContext('loadDispatches()', context);
    assert.ok(!container.innerHTML.includes('<img'));
    assert.ok(container.innerHTML.includes('this.dataset.startCity'));
    assert.ok(container.innerHTML.includes('&lt;img'));
});
