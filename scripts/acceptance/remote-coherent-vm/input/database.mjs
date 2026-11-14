async function snapshot(coreDb, stateDb) { const result = {}; for (const table of ['projects', 'memories', 'executions', 'tasks', 'embedding_profiles', 'embeddings']) {
    const rows = (await coreDb.query(`SELECT * FROM forge.${table} ORDER BY id`)).rows;
    result[table] = { count: rows.length, sha256: hash(JSON.stringify(rows)) };
} const rows = (await stateDb.query('SELECT * FROM forge_coordinator.jobs ORDER BY id')).rows; result.jobs = { count: rows.length, sha256: hash(JSON.stringify(rows)) }; return result; }
import assert from 'node:assert/strict';
import { reportRows, inventory, validatedReceipts, validateReports, verifyReportFiles, captureReports } from './report-fixture.mjs';
import pg from 'pg';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { ForgePersistenceGateway, OperationalGate } from 'forge-persistence-gateway';
import { Coordinator, PostgresJobStore, ImmutableReportPublisher, RestoredReportVerifier, captureReportTarget } from './packages/coordinator/dist/index.js';
import { applyMigrations } from './packages/schema/src/migrations.mjs';
import { captureCoherentPostgresArchive } from './packages/resilience/dist/coherent.js';
import { sealCoherentDatabases } from './packages/resilience/dist/coherent-database-gate.js';
import { safeConnection } from './packages/resilience/dist/config.js';
const root = 'C:/ForgeFixture', bin = 'C:/ForgeFixtureInput/postgres/bin', reports = root + '/report-parent/reports';
let active, seal, gate, admin, state, core, store, cutTick;
export let dbEvidence = {};
const hash = x => createHash('sha256').update(x).digest('hex');
const env = () => Object.fromEntries(['PATH', 'Path', 'PATHEXT', 'ComSpec', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
async function exec(cmd, args, extra = {}) { const c = spawn(cmd, args, { env: { ...env(), ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); let out = '', err = ''; c.stdout.on('data', x => out += x); c.stderr.on('data', x => err += x); const code = await new Promise((r, j) => { c.on('error', j); c.on('exit', r); }); return { code, out, err }; }
async function run(cmd, args, extra = {}) { const r = await exec(cmd, args, extra); dbEvidence.exits ??= []; dbEvidence.exits.push({ tool: path.basename(cmd), code: r.code }); if (r.code !== 0) {
    const e = new Error('Fixture command failed');
    e.code = r.code;
    e.tool = path.basename(cmd);
    e.diagnosticHash = hash(r.err);
    throw e;
} return r.out; }
async function client(url) { const c = new pg.Client({ connectionString: String(url), connectionTimeoutMillis: 5000 }); c.on('error', () => { }); await c.connect(); return c; }
async function port() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function cluster(kind) { const dir = root + (kind === 'source' ? '/capturer' : '/private') + '/' + kind; await mkdir(dir); const password = randomUUID() + randomUUID(), p = await port(), pass = dir + '/init.pass'; await writeFile(pass, password + '\n', { flag: 'wx' }); try {
    await run(bin + '/initdb.exe', ['-D', dir + '/data', '-U', 'forge_pilot', '-A', 'scram-sha-256', '--pwfile=' + pass, '--locale=C', '--encoding=UTF8']);
}
finally {
    await rm(pass, { force: true });
} active = { dir, p }; await run(bin + '/pg_ctl.exe', ['-D', dir + '/data', '-l', dir + '/postgres.log', '-o', `-h 127.0.0.1 -p ${p}`, '-w', 'start']); const url = new URL(`postgresql://forge_pilot:${password}@127.0.0.1:${p}/postgres`); const c = await client(url); try {
    const row = (await c.query("SELECT current_setting('data_directory') directory,host(inet_server_addr()) host,inet_server_port() port,current_user usr,current_database() db")).rows[0];
    assert.equal(path.resolve(row.directory).toLowerCase(), path.resolve(dir + '/data').toLowerCase());
    assert.equal(row.host, '127.0.0.1');
    assert.equal(row.port, p);
    assert.equal(row.usr, 'forge_pilot');
    assert.equal(row.db, 'postgres');
    const id = (await c.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier;
    dbEvidence.preflight = { beforeDDL: true, pathOwned: true, loopback: true, systemIdentifierHash: hash(id), port: p };
    return { url, id, dir, p };
}
finally {
    await c.end();
} }
async function stop() { if (!active)
    return; const { dir, p } = active; await run(bin + '/pg_ctl.exe', ['-D', dir + '/data', '-m', 'immediate', '-w', 'stop']); await new Promise((resolve, reject) => { const s = connect({ host: '127.0.0.1', port: p }); s.on('connect', () => { s.destroy(); reject(new Error('Port remains open')); }); s.on('error', resolve); }); await rm(dir, { recursive: true }); await assert.rejects(stat(dir), { code: 'ENOENT' }); dbEvidence.clusterStoppedAndRemoved = true; active = undefined; }
async function configure(url, password) { await run(process.execPath, ['packages/schema/scripts/configure-runtime-role.mjs'], { FORGE_ADMIN_DATABASE_URL: String(url), FORGE_RUNTIME_PASSWORD: password }); }
async function roleTest(url) { await run(process.execPath, ['--test', 'packages/schema/tests/runtime-role.test.mjs'], { FORGE_DATABASE_URL: String(url) }); }
export async function capture() {
    dbEvidence.postgresVersion = (await run(bin + '/postgres.exe', ['--version'])).trim();
    assert.match(dbEvidence.postgresVersion, /18\.4/);
    dbEvidence.phase = 'source-init';
    const c = await cluster('source');
    admin = await client(c.url);
    const cu = new URL('/core', c.url), su = new URL('/state', c.url);
    await admin.query('CREATE DATABASE core TEMPLATE template0');
    await admin.query('CREATE DATABASE state TEMPLATE template0');
    await admin.end();
    admin = await client(cu);
    state = await client(su);
    dbEvidence.phase = 'migrations';
    await applyMigrations({ exec: s => admin.query(s), query: (s, p) => admin.query(s, p) });
    const rp = randomUUID(), sp = randomUUID(), mp = randomUUID();
    await configure(cu, rp);
    const runtime = new URL(cu);
    runtime.username = 'forge_runtime';
    runtime.password = rp;
    await roleTest(runtime);
    await admin.query(`CREATE ROLE operational_state LOGIN PASSWORD '${sp}'`);
    await admin.query(`CREATE ROLE operational_migration LOGIN PASSWORD '${mp}'`);
    await admin.query('CREATE ROLE operational_backup NOLOGIN');
    await state.query('CREATE SCHEMA forge_coordinator AUTHORIZATION operational_state');
    const stateRuntime = new URL(su);
    stateRuntime.username = 'operational_state';
    stateRuntime.password = sp;
    const setup = await client(stateRuntime);
    await setup.query(await readFile('packages/coordinator/sql/setup.sql', 'utf8'));
    await setup.end();
    for (const [db, schema] of [[admin, 'forge'], [state, 'forge_coordinator']]) {
        await db.query(`GRANT USAGE ON SCHEMA ${schema} TO operational_backup`);
        await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO operational_backup`);
        await db.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO operational_backup`);
        await db.query(`GRANT CREATE ON SCHEMA ${schema} TO operational_migration`);
    }
    gate = await OperationalGate.initialize(root + '/capturer/gate');
    process.env.FORGE_OPERATIONAL_GATE_ROOT = gate.root;
    core = ForgePersistenceGateway.connect({ connectionString: String(runtime) });
    store = new PostgresJobStore(String(stateRuntime));
    await mkdir(reports);
    const project = await core.registerProject({ projectKey: 'operational', name: 'Synthetic isolated custody' }), agent = await core.registerAgent({ agentKey: 'operational-agent', name: 'Fixture' });
    await core.assignAgent(project.id, agent.id);
    const task = await core.createTask({ projectId: project.id, taskKey: 'effect', title: 'Fixture', status: 'ready', assignedAgentId: agent.id, idempotencyKey: 'operational-task' });
    const seed = await core.remember({ projectId: project.id, memoryType: 'observation', title: 'Seed', content: 'Synthetic representative memory', idempotencyKey: 'seed' });
    await core.registerEmbeddingProfile({ profileKey: 'custody-vector', provider: 'fixture', model: 'synthetic-no-provider', dimensions: 3 });
    await core.putEmbedding({ projectId: project.id, profileKey: 'custody-vector', sourceKind: 'memory', sourceId: seed.id, sourceVersion: seed.version, embedding: [1, 0, 0], idempotencyKey: 'fixture-vector' });
    dbEvidence.vector = 'synthetic pgvector [1,0,0]';
    const publisher = new ImmutableReportPublisher(reports);
    // Creation-time population is independent of SQL/file discovery at the cut.
    const expected = [{ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId: agent.id }];
    for (let index = 1; index <= 2; index++) {
        const other = await core.registerProject({ projectKey: `operational-${index}`, name: 'Synthetic additional report' });
        await core.assignAgent(other.id, agent.id);
        const extra = await core.createTask({ projectId: other.id, taskKey: `effect-${index}`, title: 'Fixture', status: 'ready', assignedAgentId: agent.id, idempotencyKey: `operational-task-${index}` });
        const item = { projectId: other.id, taskId: extra.id, taskKey: extra.taskKey, agentId: agent.id };
        expected.push(item);
        await store.enqueue(item, 3, { kind: publisher.kind, targetId: publisher.targetId });
        assert.equal(await new Coordinator(store, core, { publisher }).runOnce({ projectId: other.id, agentId: agent.id, workerId: randomUUID() }, async () => ({ title: `Synthetic report ${index}`, content: `Completed fixture ${index}` })), 'completed');
    }
    await store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId: agent.id }, 3, { kind: publisher.kind, targetId: publisher.targetId });
    const faultCore = new Proxy(core, { get(t, k) { if (k === 'remember')
            return async () => { throw new Error('Synthetic post-receipt interruption'); }; const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; } });
    let calls = 0;
    const coordinator = new Coordinator(store, faultCore, { publisher });
    assert.equal(await coordinator.runOnce({ projectId: project.id, agentId: agent.id, workerId: randomUUID() }, async () => { calls++; return { title: 'Synthetic report', content: 'Effect must match retained receipt' }; }), 'failed');
    assert.equal(calls, 1);
    const saved = (await state.query('SELECT * FROM forge_coordinator.jobs WHERE task_id=$1', [task.id])).rows[0];
    assert.ok(saved.effect_receipt);
    assert.equal(saved.state, 'queued');
    assert.equal((await core.listMemories({ projectId: project.id, taskId: task.id })).items.length, 0);
    const lease = await gate.close(10000);
    await core.close();
    core = undefined;
    await store.close();
    store = undefined;
    dbEvidence.phase = 'seal';
    seal = await sealCoherentDatabases({ connectionString: String(cu), dataDirectory: c.dir + '/data', databases: ['core', 'state'], writerRoles: ['forge_runtime', 'operational_state', 'operational_migration'], backupRole: 'operational_backup', maintenance: lease });
    const cutoff = new Date().toISOString();
    cutTick = performance.now();
    dbEvidence.sqlDenials = [];
    for (const [db, schema, table] of [[admin, 'forge', 'tasks'], [state, 'forge_coordinator', 'jobs']])
        for (const sql of [`DELETE FROM ${schema}.${table} WHERE false`, `CREATE TABLE ${schema}.late_backup(id int)`]) {
            await db.query('BEGIN');
            try {
                await db.query('SET LOCAL ROLE operational_backup');
                await assert.rejects(db.query(sql), e => { dbEvidence.sqlDenials.push(e.code); return e.code === '42501'; });
            }
            finally {
                await db.query('ROLLBACK');
            }
        }
    const originals = root + '/capturer/originals';
    await mkdir(originals);
    const sourceSnapshot = await snapshot(admin, state);
    const rows = JSON.parse(JSON.stringify(await reportRows(state)));
    const identity = { fixtureVersion: 2, expected, rows, inventory: inventory(rows), sourceSnapshot, proof: captureReportTarget(reports), systemIdentifier: c.id, cutoff };
    const tasks = (await admin.query('SELECT id,project_id,assigned_agent_id,task_key FROM forge.tasks ORDER BY id')).rows;
    assert.deepEqual(tasks.map(row => ({ taskId: row.id, projectId: row.project_id, agentId: row.assigned_agent_id, taskKey: row.task_key })), [...expected].sort((a, b) => a.taskId.localeCompare(b.taskId)));
    await checkCoreRows(admin, identity, false);
    const payload = await captureReports(reports, identity);
    await writeFile(originals + '/identity.json', JSON.stringify(identity), { flag: 'wx' });
    await writeFile(originals + '/reports.json', JSON.stringify(payload), { flag: 'wx' });
    const files = { core: originals + '/core.dump', coordinator: originals + '/state.dump', identity: originals + '/identity.json', report: originals + '/reports.json' };
    dbEvidence.cutData = sourceSnapshot;
    dbEvidence.reports = reportEvidence(identity, payload);
    dbEvidence.reportsExpected = 3;
    dbEvidence.reportsCaptured = 3;
    dbEvidence.sourceRoleContract = true;
    dbEvidence.receiptCommittedBeforeCoreMemory = true;
    dbEvidence.phase = 'dump';
    for (const [url, destination] of [[cu, files.core], [su, files.coordinator]]) {
        await captureCoherentPostgresArchive({ connectionString: String(url), role: 'operational_backup', postgresBin: bin, destination });
        dbEvidence.exits.push({ tool: 'pg_dump.exe', code: 0 });
    }
    return { files, maintenance: seal, cutoff };
}
export async function finishCapture() { await seal.resume(); await admin.query("INSERT INTO forge.projects(project_key,name) VALUES ('post-cutoff','Excluded marker')"); dbEvidence.postCutoffMarkerCreated = true; await seal.close(); seal = undefined; await admin.end(); admin = undefined; await state.end(); state = undefined; delete process.env.FORGE_OPERATIONAL_GATE_ROOT; await stop(); dbEvidence.simulatedRpoMs = Math.round(performance.now() - cutTick); await rm(reports, { recursive: true }); await assert.rejects(stat(reports), { code: 'ENOENT' }); dbEvidence.reportRemoved = true; }
export async function readRestoreIdentity(files) {
    const identity = JSON.parse(await readFile(files.identity, 'utf8'));
    // Check every receipt/name before accessing even the aggregate report path.
    validatedReceipts(identity);
    assert.match(identity.systemIdentifier, /^[0-9]{1,20}$/);
    assert.equal(new Date(identity.cutoff).toISOString(), identity.cutoff);
    const payload = JSON.parse(await readFile(files.report, 'utf8'));
    validateReports(identity, payload);
    assert.deepEqual(Object.keys(identity.sourceSnapshot).sort(), ['projects', 'memories', 'executions', 'tasks', 'embedding_profiles', 'embeddings', 'jobs'].sort());
    for (const [table, count] of Object.entries({ projects: 3, tasks: 3, executions: 3, jobs: 3, memories: 3, embeddings: 1, embedding_profiles: 1 })) {
        assert.equal(identity.sourceSnapshot[table].count, count);
        assert.match(identity.sourceSnapshot[table].sha256, /^[a-f0-9]{64}$/);
    }
    return identity;
}
function reportEvidence(identity, payload) {
    return identity.inventory.map(row => ({ reportHash: row.receipt.sha256, receiptHash: hash(JSON.stringify(row.receipt)), bytes: payload.reports.find(file => file.filename === row.receipt.filename).bytes, state: row.state }));
}
async function checkCoreRows(db, identity, reconciled) {
    for (const row of identity.inventory) {
        const tasks = (await db.query('SELECT * FROM forge.tasks WHERE id=$1', [row.taskId])).rows;
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].project_id, row.projectId);
        assert.equal(tasks[0].assigned_agent_id, row.agentId);
        assert.equal(tasks[0].task_key, row.taskKey);
        const executions = (await db.query('SELECT * FROM forge.executions WHERE task_id=$1', [row.taskId])).rows;
        assert.equal(executions.length, 1);
        assert.equal(executions[0].project_id, row.projectId);
        assert.equal(executions[0].agent_id, row.agentId);
        assert.equal(executions[0].execution_key, `coordinator:v1:${row.projectId}:${row.taskId}`);
        assert.equal(executions[0].policy_version, 'external-coordinator-v1');
        assert.equal(executions[0].metadata.coordinatorJobId, identity.rows.find(job => job.task_id === row.taskId).id);
        assert.equal(executions[0].status, reconciled || row.state === 'completed' ? 'succeeded' : 'running');
        assert.equal(tasks[0].status, reconciled || row.state === 'completed' ? 'done' : 'in_progress');
        const memories = (await db.query('SELECT * FROM forge.memories WHERE task_id=$1', [row.taskId])).rows;
        assert.equal(memories.length, reconciled || row.state === 'completed' ? 1 : 0);
        for (const memory of memories) {
            assert.equal(memory.project_id, row.projectId);
            assert.equal(memory.created_by_agent_id, row.agentId);
            assert.equal(memory.memory_type, 'execution_summary');
            const provenance = (await db.query('SELECT source_kind,source_ref FROM forge.memory_provenance WHERE memory_id=$1', [memory.id])).rows;
            assert.deepEqual(provenance, [{ source_kind: 'execution', source_ref: executions[0].id }]);
        }
    }
}
export async function restore(files) {
    dbEvidence.phase = 'validate-restored-report';
    const identity = await readRestoreIdentity(files);
    const payload = JSON.parse(await readFile(files.report, 'utf8'));
    dbEvidence.phase = 'authenticated-target-init';
    const c = await cluster('target');
    assert.notEqual(c.id, identity.systemIdentifier);
    dbEvidence.distinctTarget = true;
    admin = await client(c.url);
    await admin.query('CREATE ROLE forge_runtime LOGIN');
    await admin.query('CREATE ROLE operational_state LOGIN');
    await admin.query('CREATE DATABASE core TEMPLATE template0');
    await admin.query('CREATE DATABASE state TEMPLATE template0');
    const cu = new URL('/core', c.url), su = new URL('/state', c.url);
    dbEvidence.phase = 'restore-both';
    for (const [url, archive] of [[cu, files.core], [su, files.coordinator]]) {
        const conn = safeConnection(String(url));
        await run(bin + '/pg_restore.exe', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--dbname', conn.connectionArgument, archive], conn.environment);
    }
    const restoredCore = await client(cu), restoredState = await client(su);
    try {
        const actual = await snapshot(restoredCore, restoredState);
        assert.deepEqual(actual, identity.sourceSnapshot);
        dbEvidence.cutData = actual;
        dbEvidence.exactCutData = true;
        assert.equal((await restoredCore.query('SELECT embedding::text value FROM forge.embeddings')).rows[0].value, '[1,0,0]');
        dbEvidence.vectorRestored = true;
        assert.deepEqual(JSON.parse(JSON.stringify(await reportRows(restoredState))), identity.rows);
        await checkCoreRows(restoredCore, identity, false);
    }
    finally {
        await restoredCore.end();
        await restoredState.end();
    }
    const rp = randomUUID(), sp = randomUUID();
    await configure(cu, rp);
    state = await client(su);
    await state.query(`ALTER ROLE operational_state PASSWORD '${sp}'`);
    await state.query('GRANT USAGE ON SCHEMA forge_coordinator TO operational_state');
    await state.query('GRANT SELECT,INSERT,UPDATE ON forge_coordinator.jobs TO operational_state');
    const runtime = new URL(cu);
    runtime.username = 'forge_runtime';
    runtime.password = rp;
    await roleTest(runtime);
    const stateRuntime = new URL(su);
    stateRuntime.username = 'operational_state';
    stateRuntime.password = sp;
    const limited = await client(stateRuntime);
    const powers = (await limited.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.ok(Object.values(powers).every(x => x === false));
    await limited.query('BEGIN');
    try {
        await assert.rejects(limited.query('DELETE FROM forge_coordinator.jobs WHERE false'), e => e.code === '42501');
    }
    finally {
        await limited.query('ROLLBACK');
        await limited.end();
    }
    dbEvidence.targetRoleContracts = true;
    core = ForgePersistenceGateway.connect({ connectionString: String(runtime) });
    store = new PostgresJobStore(String(stateRuntime));
    await assert.rejects(core.getProjectByKey('post-cutoff'));
    await mkdir(reports);
    for (const report of validatedReceipts(identity)) {
        await writeFile(path.join(reports, report.receipt.filename), report.bytes, { flag: 'wx' });
    }
    const fileIdentities = await verifyReportFiles(reports, identity, payload);
    const proof = captureReportTarget(reports);
    assert.equal(proof.canonicalPath, identity.proof.canonicalPath);
    dbEvidence.sameCanonicalReportPath = true;
    const verifier = new RestoredReportVerifier(reports, identity.proof);
    let replay = 0;
    dbEvidence.phase = 'reconcile';
    dbEvidence.probes = [];
    const completedBefore = (await state.query("SELECT * FROM forge_coordinator.jobs WHERE state='completed' ORDER BY id")).rows;
    for (const expected of identity.inventory) {
        const coordinator = new Coordinator(store, core, { publisher: verifier, recovery: { taskId: expected.taskId, receipt: expected.receipt } });
        const worker = { projectId: expected.projectId, agentId: expected.agentId, workerId: randomUUID() };
        const forbidden = async () => { replay++; throw new Error('Forbidden replay'); };
        const first = await coordinator.runOnce(worker, forbidden);
        assert.equal(first, expected.state === 'completed' ? 'idle' : 'completed');
        assert.equal(await coordinator.runOnce(worker, forbidden), 'idle');
        const row = await store.recoveryCheckpoint(expected.projectId, expected.taskId);
        assert.deepEqual(row.effectReceipt, expected.receipt);
        assert.deepEqual(row.artifact, expected.artifact);
        assert.equal(row.attempts, expected.attempts + (expected.state === 'completed' ? 0 : 1));
        assert.equal((await core.getTaskByKey(expected.projectId, expected.taskKey)).status, 'done');
        dbEvidence.probes.push({ reportHash: expected.receipt.sha256, before: expected.state, first, replay: 'idle', after: 'completed', attempts: row.attempts });
    }
    assert.deepEqual((await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [completedBefore.map(row => row.id)])).rows, completedBefore);
    assert.deepEqual(inventory(await reportRows(state)), identity.inventory.map(row => ({ ...row, state: 'completed', attempts: row.attempts + (row.state === 'completed' ? 0 : 1) })));
    const finalCore = await client(cu);
    try { await checkCoreRows(finalCore, identity, true); } finally { await finalCore.end(); }
    assert.deepEqual(await verifyReportFiles(reports, identity, payload), fileIdentities);
    assert.equal(replay, 0);
    dbEvidence.reconciliation = 1;
    dbEvidence.handlerReplay = 0;
    dbEvidence.providerReplay = 0;
    dbEvidence.providerConfigured = false;
    dbEvidence.replacementReportIdentityVerified = true;
    dbEvidence.executions = 3;
    dbEvidence.taskMemories = 3;
    dbEvidence.taskDone = true;
    dbEvidence.reports = reportEvidence(identity, payload);
    dbEvidence.reportsRestored = 3;
    dbEvidence.exactRowsReceiptsAndBytes = true;
    dbEvidence.completedNoopAndReplay = true;
    dbEvidence.reportFilesNotRewritten = true;
    dbEvidence.postCutoffAbsent = true;
}
export async function cleanup() { delete process.env.FORGE_OPERATIONAL_GATE_ROOT; for (const x of [core, store])
    if (x)
        await x.close(); for (const x of [seal, admin, state])
    if (x)
        await (x.close ? x.close() : x.end()); await stop(); }
