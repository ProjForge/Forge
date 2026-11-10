import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { OperationalGate } from '../../src/operational-gate.js'

test('close rejects late admission and drains an external effect through its receipt; explicit resume only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-gate-'))
  try {
    const gate = await OperationalGate.initialize(path.join(root, 'gate'))
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let effect = false; let receipt = false
    const job = gate.run(async () => {
      effect = true
      await pending
      await gate.run(async () => { receipt = true })
    })
    while (!effect) await delay(5)
    let drained = false
    const sealing = gate.close().then(lease => { drained = true; return lease })
    while (JSON.parse(await readFile(path.join(gate.root, 'state.json'), 'utf8')).phase !== 'closed') await delay(5)
    await assert.rejects(gate.run(async () => { throw new Error('must not run') }), /closed/)
    assert.equal(drained, false); assert.equal(receipt, false)
    release(); await job
    const lease = await sealing
    assert.equal(receipt, true)
    await lease.assertHeld()
    await lease.resume()
    await gate.run(async () => {})
    await assert.rejects(lease.assertHeld())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('actual process death leaves an admission requiring operator reconciliation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-gate-crash-'))
  const gate = await OperationalGate.initialize(path.join(root, 'gate'))
  const moduleUrl = new URL('../../src/operational-gate.js', import.meta.url).href
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { OperationalGate } from ${JSON.stringify(moduleUrl)}; await new OperationalGate(process.argv[1]).run(async () => { process.stdout.write('admitted'); await new Promise(() => { setInterval(() => {}, 1000) }) })`, gate.root], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout!.once('data', () => resolve())
      child.once('exit', () => reject(new Error('Child exited before admission')))
    })
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill(); await exited
    await assert.rejects(gate.close(20), /timeout/)
    await assert.rejects(new OperationalGate(gate.root).run(async () => {}), /closed/)
    assert.equal((await readdir(path.join(gate.root, 'active'))).length, 1)
  } finally { child.kill(); await rm(root, { recursive: true, force: true }) }
})

test('timeout, orphaned admission, missing state and ownership loss fail closed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-gate-'))
  try {
    const gate = await OperationalGate.initialize(path.join(root, 'gate'))
    await writeFile(path.join(gate.root, 'active', 'crashed-process'), '')
    await assert.rejects(gate.close(20), /timeout/)
    await assert.rejects(gate.run(async () => {}), /closed/)
    assert.deepEqual(await readdir(path.join(gate.root, 'active')), ['crashed-process'])
    await assert.rejects(gate.close(), /already closed/)
    const other = await OperationalGate.initialize(path.join(root, 'other'))
    const lease = await other.close()
    await writeFile(path.join(other.root, 'state.json'), JSON.stringify({ version: 1, phase: 'closed', owner: '00000000-0000-0000-0000-000000000000' }))
    await assert.rejects(lease.assertHeld()); await assert.rejects(lease.resume())
    await rm(path.join(other.root, 'state.json'))
    await assert.rejects(other.run(async () => {}))
  } finally { await rm(root, { recursive: true, force: true }) }
})
