import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, truncate, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWrappedCoherentKey, readWrappedCoherentKey } from '../../packages/resilience/dist/coherent-custody.js'
import { createCoherentGeneration, withVerifiedCoherentGeneration } from '../../packages/resilience/dist/coherent.js'
import { writeTransferManifest, verifyTransferManifest } from './remote-coherent-transfer.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.version, 'v22.23.4')
assert.deepEqual(process.argv.slice(2), ['--exercise-partial-restore'])
const repo = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
assert.equal(await realpath(process.cwd()), repo)
const kit = new URL('./remote-coherent-vm/input/', import.meta.url)
const root = await realpath(await mkdtemp(path.join(repo, '.coherent-partial-')))
const temporary = path.join(root, 'temp')
const replica = path.join(root, 'exchange')
const bin = 'C:/Program Files/PostgreSQL/18/bin'
const runId = randomUUID()
const evidence = { runId, root, node: process.version, postgresBin: bin }
const hash = value => createHash('sha256').update(value).digest('hex')
const fileHash = async file => hash(await readFile(file))
const missing = file => assert.rejects(stat(file), { code: 'ENOENT' })

// Observe committed state after failure through the module's disposable admin
// connection parameters. No launcher or production module is modified.
const observe = `
export async function inspectPartialTarget() {
    const { host, port, user, password } = admin.connectionParameters;
    assert.equal(host, '127.0.0.1');
    assert.equal(port, active.p);
    const result = {};
    for (const [database, query] of [
        ['core', 'SELECT count(*)::integer AS projects FROM forge.projects'],
        ['state', "SELECT to_regnamespace('forge_coordinator') IS NULL AS empty"],
    ]) {
        const db = new pg.Client({ host, port, user, password, database, connectionTimeoutMillis: 5000 });
        await db.connect();
        try { Object.assign(result, (await db.query(query)).rows[0]); }
        finally { await db.end(); }
    }
    return result;
}
import { realpath } from 'node:fs/promises';
let cleanupResult;
export function cleanupHarness(injectCloseFailure = false) {
    return cleanupResult ??= clean(injectCloseFailure);
}
async function clean(injectCloseFailure) {
    if (active) {
        assert.equal(await realpath(root), path.normalize(root));
        const dir = path.normalize(active.dir);
        assert.ok([path.join(root, 'capturer', 'source'), path.join(root, 'private', 'target')].includes(dir));
        assert.equal(await realpath(dir), dir);
        assert.equal(await realpath(path.join(dir, 'data')), path.join(dir, 'data'));
    }
    if (injectCloseFailure) {
        assert.ok(active && admin);
        const end = admin.end.bind(admin);
        admin.end = async () => {
            await end();
            throw Object.assign(new Error('Injected close failure'), { code: 'HARNESS_CLOSE_FAILURE' });
        };
    }
    try {
        await cleanup();
    } catch (error) {
        dbEvidence.cleanupFailure = sanitizedFailure(error);
        if (active) await stop();
        dbEvidence.cleanupRecovered = true;
    }
    assert.equal(active, undefined);
}
`

function sanitizedFailure(error) {
  return {
    code: typeof error?.code === 'number' || /^[A-Z0-9_]{1,32}$/.test(error?.code ?? '') ? error.code : undefined,
    tool: /^(?:postgres|initdb|pg_ctl|pg_dump|pg_restore|node)\.exe$/.test(error?.tool ?? '') ? error.tool : undefined,
    diagnosticHash: /^[a-f0-9]{64}$/.test(error?.diagnosticHash ?? '') ? error.diagnosticHash : undefined,
  }
}

async function stage(name) {
  const bytes = await readFile(new URL(name, kit))
  evidence.moduleHashes ??= {}
  evidence.moduleHashes[name] = hash(bytes)
  let source = bytes.toString('utf8').replaceAll("'./packages/", "'" + pathToFileURL(path.join(repo, 'packages') + path.sep).href)
  if (name === 'database.mjs') {
    for (const [literal, value] of [['C:/ForgeFixture', root.replaceAll('\\', '/')], ['C:/ForgeFixtureInput/postgres/bin', bin]]) {
      const needle = "'" + literal + "'"
      assert.equal(source.split(needle).length, 2)
      source = source.replace(needle, JSON.stringify(value))
    }
    source += observe + sanitizedFailure.toString() + "\n"
  } else {
    const needle = "'C:/ForgeFixture/report-parent/reports'"
    assert.equal(source.split(needle).length, 2)
    source = source.replace(needle, JSON.stringify(path.join(root, 'report-parent', 'reports')))
  }
  await writeFile(path.join(root, name), source, { flag: 'wx' })
}

let current, key
try {
  for (const directory of ['capturer', 'private', 'report-parent', 'exchange', 'temp']) {
    await mkdir(path.join(root, directory))
  }
  process.env.TEMP = temporary
  process.env.TMP = temporary
  await stage('database.mjs')
  await stage('report-fixture.mjs')
  const load = attempt => import(pathToFileURL(path.join(root, 'database.mjs')).href + '?' + attempt)

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const recipientSha256 = hash(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))
  const wrapped = path.join(replica, 'wrapped.json')
  const bundles = path.join(replica, 'bundles')
  current = await load('capture')
  key = await createWrappedCoherentKey(wrapped, runId, publicKey)
  const source = await current.capture()
  const { generation } = await createCoherentGeneration({
    root: bundles, key, maintenance: source.maintenance,
    capture: async () => ({ cutoff: source.cutoff, files: source.files }),
  })
  key.key.fill(0)
  key = undefined
  await current.finishCapture()
  await rm(path.join(root, 'capturer', 'originals'), { recursive: true })
  await missing(path.join(root, 'capturer', 'originals'))
  evidence.capture = current.dbEvidence
  current = undefined
  evidence.pin = await writeTransferManifest(replica, { runId, generation, recipientSha256 })
  const pin = { runId, recipientSha256, manifestSha256: evidence.pin.manifestSha256 }
  const bundle = { generation, directory: path.join(bundles, generation) }
  key = await readWrappedCoherentKey(wrapped, runId, privateKey)

  for (const fault of [true, false]) {
    await missing(path.join(root, 'private', 'target'))
    await missing(path.join(root, 'report-parent', 'reports'))
    assert.deepEqual(await verifyTransferManifest(replica, pin), evidence.pin)
    current = await load(fault ? 'partial' : 'retry')
    await withVerifiedCoherentGeneration({ ...bundle, key }, async files => {
      assert.equal(Object.keys(files).length, 4)
      const archiveHash = await fileHash(files.coordinator)
      if (!fault) {
        assert.equal(archiveHash, evidence.coordinatorArchiveSha256)
        await current.restore(files)
        return
      }
      evidence.coordinatorArchiveSha256 = archiveHash
      const damaged = path.join(root, 'private', 'fault-only.dump')
      await copyFile(files.coordinator, damaged, constants.COPYFILE_EXCL)
      try {
        const { size } = await stat(damaged)
        await truncate(damaged, Math.floor(size / 2))
        evidence.faultArchiveBytes = { original: size, truncated: (await stat(damaged)).size }
        evidence.faultArchiveSha256 = await fileHash(damaged)
        assert.notEqual(evidence.faultArchiveSha256, archiveHash)
        await assert.rejects(current.restore({ ...files, coordinator: damaged }), error => {
          assert.equal(error.tool, 'pg_restore.exe')
          assert.equal(error.code, 1)
          assert.match(error.diagnosticHash, /^[a-f0-9]{64}$/)
          evidence.expectedFailure = { phase: current.dbEvidence.phase, tool: error.tool, code: error.code, diagnosticHash: error.diagnosticHash }
          return true
        })
        assert.equal(await fileHash(files.coordinator), archiveHash)
        assert.equal(current.dbEvidence.phase, 'restore-both')
        assert.deepEqual(current.dbEvidence.exits.filter(exit => exit.tool === 'pg_restore.exe').map(exit => exit.code), [0, 1])
        for (const field of ['probes', 'reconciliation', 'handlerReplay', 'reportsRestored']) {
          assert.equal(current.dbEvidence[field], undefined)
        }
        await missing(path.join(root, 'report-parent', 'reports'))
        evidence.partialTarget = await current.inspectPartialTarget()
        assert.deepEqual(evidence.partialTarget, { projects: 3, empty: true })
      } finally {
        await rm(damaged, { force: true })
      }
    })
    assert.deepEqual(await readdir(temporary), [])
    await current.cleanupHarness(fault)
    if (fault) {
      await current.cleanupHarness()
      assert.equal(current.dbEvidence.cleanupFailure?.code, 'HARNESS_CLOSE_FAILURE')
      assert.equal(current.dbEvidence.cleanupRecovered, true)
      assert.deepEqual(current.dbEvidence.exits.filter(exit => exit.tool === 'pg_ctl.exe').map(exit => exit.code), [0, 0])
    } else {
      assert.equal(current.dbEvidence.cleanupFailure, undefined)
    }
    await missing(path.join(root, 'private', 'target'))
    assert.equal(current.dbEvidence.clusterStoppedAndRemoved, true)
    evidence[fault ? 'failedAttempt' : 'retry'] = current.dbEvidence
    current = undefined
  }

  assert.deepEqual(await verifyTransferManifest(replica, pin), evidence.pin)
  const { capture, failedAttempt, retry } = evidence
  assert.equal(new Set([capture, failedAttempt, retry].map(attempt => attempt.preflight.systemIdentifierHash)).size, 3)
  assert.deepEqual(retry.exits.filter(exit => exit.tool === 'pg_restore.exe').map(exit => exit.code), [0, 0])
  assert.deepEqual(retry.cutData, capture.cutData)
  assert.deepEqual(retry.reports, capture.reports)
  assert.equal(retry.exactRowsReceiptsAndBytes, true)
  assert.equal(retry.targetRoleContracts, true)
  assert.equal(retry.reconciliation, 1)
  assert.equal(retry.handlerReplay, 0)
  assert.equal(retry.providerReplay, 0)
  evidence.passed = true
} catch (error) {
  evidence.failure = { ...sanitizedFailure(error), database: current?.dbEvidence }
  // Stack frames locate an unexpected failure without dumping command or connection arguments.
  console.error(error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6).join('\n'))
  process.exitCode = 1
} finally {
  key?.key.fill(0)
  try {
    if (current) await current.cleanupHarness()
    const resolved = await realpath(root)
    assert.equal(resolved, root)
    assert.equal(path.dirname(resolved), repo)
    assert.match(path.basename(resolved), /^\.coherent-partial-[a-zA-Z0-9]+$/)
    await rm(resolved, { recursive: true })
    await missing(resolved)
    evidence.scratchRemoved = true
  } catch (error) {
    evidence.cleanupIncomplete = { ...sanitizedFailure(error), database: current?.dbEvidence }
    evidence.scratchRemoved = false
    evidence.passed = false
    process.exitCode = 1
  } finally {
    await new Promise(resolve => process.stdout.write(JSON.stringify(evidence) + '\n', resolve))
    if (evidence.cleanupIncomplete) process.exit(1)
  }
}
