// Fixture-only aggregate; production's four-component v1 envelope is unchanged.
import assert from 'node:assert/strict'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { reportIdentity } from '../../packages/coordinator/dist/index.js'

const sorted = rows => [...rows].sort((a, b) => a.taskId.localeCompare(b.taskId))
const scope = row => ({ taskId: row.task_id, projectId: row.project_id, agentId: row.agent_id, taskKey: row.task_key })
export async function reportRows(db) {
  return (await db.query("SELECT * FROM forge_coordinator.jobs WHERE effect_kind='immutable-report-v1' AND effect_receipt IS NOT NULL ORDER BY task_id")).rows
}
export function inventory(rows) {
  return sorted(rows.map(row => ({ ...scope(row), state: row.state, attempts: row.attempts,
    artifact: row.artifact, receipt: row.effect_receipt, targetId: row.effect_target })))
}
function validatedReceipts(identity) {
  try {
    const reports = identity.inventory.map(row => {
      const key = `coordinator:v1:${row.projectId}:${row.taskId}:report`
      const reconstructed = reportIdentity(key, row.artifact, row.targetId)
      assert.deepEqual(row.receipt, reconstructed.receipt)
      assert.match(reconstructed.receipt.filename, /^[a-f0-9]{64}\.report\.md$/)
      return reconstructed
    })
    assert.equal(new Set(reports.map(report => report.receipt.filename)).size, reports.length)
    return reports
  } catch {
    throw new Error('REPORT_RECEIPT_CONTRACT_INVALID')
  }
}
export function validateReports(identity, payload) {
  const canonical = validatedReceipts(identity)
  assert.equal(identity.fixtureVersion, 1)
  assert.equal(payload.fixtureVersion, 1)
  assert.deepEqual(inventory(identity.rows), identity.inventory)
  assert.ok(identity.expected.length >= 3)
  assert.equal(new Set(identity.expected.map(row => row.taskId)).size, identity.expected.length)
  assert.ok(new Set(identity.expected.map(row => `${row.projectId}:${row.agentId}`)).size >= 2)
  assert.deepEqual(sorted(identity.inventory.map(({ taskId, projectId, agentId, taskKey }) => ({ taskId, projectId, agentId, taskKey }))), sorted(identity.expected))
  assert.ok(identity.inventory.some(row => row.state === 'completed'))
  assert.ok(identity.inventory.some(row => row.state === 'queued'))
  assert.deepEqual(payload.reports.map(row => row.filename).sort(), identity.inventory.map(row => row.receipt.filename).sort())
  assert.equal(new Set(payload.reports.map(row => row.filename)).size, payload.reports.length)
  for (const [index, row] of identity.inventory.entries()) {
    assert.ok(['completed', 'queued'].includes(row.state))
    const reconstructed = canonical[index]
    const file = payload.reports.find(file => file.filename === row.receipt.filename)
    assert.equal(file.base64, reconstructed.bytes.toString('base64'))
    assert.equal(file.bytes, reconstructed.bytes.length)
    assert.equal(file.sha256, row.receipt.sha256)
  }
}
export async function verifyReportFiles(root, identity, payload) {
  validateReports(identity, payload)
  const directory = await lstat(root)
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink())
  assert.deepEqual((await readdir(root)).sort(), payload.reports.map(row => row.filename).sort())
  for (const file of payload.reports) {
    const location = path.join(root, file.filename)
    const info = await lstat(location)
    assert.ok(info.isFile() && !info.isSymbolicLink())
    assert.equal(info.size, file.bytes)
    assert.deepEqual(await readFile(location), Buffer.from(file.base64, 'base64'))
  }
}
export async function captureReports(root, identity) {
  const canonical = validatedReceipts(identity)
  const directory = await lstat(root)
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink())
  const reports = []
  for (const { receipt } of canonical) {
    const info = await lstat(path.join(root, receipt.filename))
    assert.ok(info.isFile() && !info.isSymbolicLink())
    const bytes = await readFile(path.join(root, receipt.filename))
    reports.push({ filename: receipt.filename, bytes: bytes.length, sha256: receipt.sha256, base64: bytes.toString('base64') })
  }
  const payload = { fixtureVersion: 1, reports }
  await verifyReportFiles(root, identity, payload)
  return payload
}
