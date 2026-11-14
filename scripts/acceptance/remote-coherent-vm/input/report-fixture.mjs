// Fixture-only collection; the production four-component envelope stays v1.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { reportIdentity } from './packages/coordinator/dist/index.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const sorted = rows => [...rows].sort((a, b) => a.taskId.localeCompare(b.taskId))
const scope = row => ({ taskId: row.task_id, projectId: row.project_id, agentId: row.agent_id, taskKey: row.task_key })
export async function reportRows(db) {
  return (await db.query("SELECT * FROM forge_coordinator.jobs WHERE effect_kind='immutable-report-v1' AND effect_receipt IS NOT NULL ORDER BY task_id")).rows
}
export function inventory(rows) {
  return sorted(rows.map(row => ({ ...scope(row), state: row.state, attempts: row.attempts,
    artifact: row.artifact, receipt: row.effect_receipt, targetId: row.effect_target })))
}
export function validatedReceipts(identity) {
  assert.equal(identity.fixtureVersion, 2, 'Historical singleton unsupported; pair kit with capture generation')
  assert.equal(identity.inventory.length, 3)
  assert.equal(identity.rows.length, 3)
  assert.equal(identity.expected.length, 3)
  for (const row of identity.rows) {
    assert.match(row.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.equal(row.effect_kind, 'immutable-report-v1')
  }
  assert.equal(new Set(identity.rows.map(row => row.id)).size, 3)
  for (const row of identity.expected) {
    for (const key of ['projectId', 'taskId', 'agentId']) assert.match(row[key], /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    assert.equal(typeof row.taskKey, 'string')
  }
  assert.equal(new Set(identity.expected.map(row => row.taskId)).size, 3)
  assert.ok(new Set(identity.expected.map(row => `${row.projectId}:${row.agentId}`)).size >= 2)
  assert.deepEqual(sorted(identity.inventory.map(({ taskId, projectId, agentId, taskKey }) => ({ taskId, projectId, agentId, taskKey }))), sorted(identity.expected))
  assert.deepEqual(inventory(identity.rows), identity.inventory)
  assert.equal(identity.inventory.filter(row => row.state === 'completed').length, 2)
  assert.equal(identity.inventory.filter(row => row.state === 'queued').length, 1)
  assert.ok(identity.inventory.every(row => row.attempts === 1))
  const proof = identity.proof
  assert.equal(proof.version, 2)
  assert.equal(proof.canonicalPath.toLowerCase(), path.resolve('C:/ForgeFixture/report-parent/reports').toLowerCase())
  for (const id of [proof.dev, proof.ino]) {
    assert.match(id, /^(0|[1-9][0-9]{0,19})$/)
    assert.ok(BigInt(id) <= 18446744073709551615n)
  }
  const canonicalPath = process.platform === 'win32' ? proof.canonicalPath.toLowerCase() : proof.canonicalPath
  const dev = BigInt(proof.dev), ino = BigInt(proof.ino)
  const targetId = hash(dev <= BigInt(Number.MAX_SAFE_INTEGER) && ino <= BigInt(Number.MAX_SAFE_INTEGER)
    ? `${canonicalPath}:${dev}:${ino}` : `report-target-v2:${JSON.stringify([canonicalPath, proof.dev, proof.ino])}`)
  const canonical = identity.inventory.map(row => {
    assert.equal(row.targetId, targetId)
    const reconstructed = reportIdentity(`coordinator:v1:${row.projectId}:${row.taskId}:report`, row.artifact, targetId)
    assert.deepEqual(row.receipt, reconstructed.receipt)
    return reconstructed
  })
  assert.equal(new Set(canonical.map(report => report.receipt.filename)).size, 3)
  return canonical
}
export function validateReports(identity, payload) {
  const canonical = validatedReceipts(identity)
  assert.equal(payload.fixtureVersion, 2)
  assert.equal(payload.reports.length, 3)
  assert.deepEqual(payload.reports.map(row => row.filename).sort(), canonical.map(row => row.receipt.filename).sort())
  for (const report of canonical) {
    const file = payload.reports.find(file => file.filename === report.receipt.filename)
    assert.equal(file.base64, report.bytes.toString('base64'))
    assert.equal(file.bytes, report.bytes.length)
    assert.equal(file.sha256, report.receipt.sha256)
  }
  return canonical
}
export async function verifyReportFiles(root, identity, payload) {
  const canonical = validateReports(identity, payload)
  const directory = await lstat(root)
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink())
  assert.deepEqual((await readdir(root)).sort(), canonical.map(row => row.receipt.filename).sort())
  const identities = []
  for (const report of canonical) {
    const location = path.join(root, report.receipt.filename)
    const info = await lstat(location, { bigint: true })
    assert.ok(info.isFile() && !info.isSymbolicLink())
    assert.equal(info.size, BigInt(report.bytes.length))
    assert.deepEqual(await readFile(location), report.bytes)
    identities.push({ filename: report.receipt.filename, dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs })
  }
  return identities
}
export async function captureReports(root, identity) {
  // Validate the whole inventory before inspecting even the directory.
  const canonical = validatedReceipts(identity)
  const payload = { fixtureVersion: 2, reports: canonical.map(({ receipt, bytes }) => ({
    filename: receipt.filename, bytes: bytes.length, sha256: receipt.sha256, base64: bytes.toString('base64'),
  })) }
  await verifyReportFiles(root, identity, payload)
  return payload
}
