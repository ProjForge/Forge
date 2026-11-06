import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Task } from 'forge-persistence-gateway'
import { ImmutableReportPublisher, LocalAgentError, LocalReportAgent, PilotFailure } from '../src/index.js'

const task = { title: 'Review subtract', objective: 'function subtract(a,b){ return a+b; }' } as Task
const input = () => ({ task, signal: new AbortController().signal })
const artifact = { title: 'Review', content: 'Subtract adds instead of subtracting.' }
function completion(content: unknown = JSON.stringify(artifact), finish_reason = 'stop', tools?: unknown): Response {
  return Response.json({ choices: [{ finish_reason, message: { content, ...(tools === undefined ? {} : { tool_calls: tools }) } }] })
}
function agent(fetchImpl: typeof fetch) { return new LocalReportAgent({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', fetchImpl }) }

test('real-agent adapter sends bounded structured work and grants no tool authority', async () => {
  const configured = agent((async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:1234/v1/chat/completions')
    assert.equal(options?.redirect, 'error')
    const body = JSON.parse(String(options?.body)) as { max_tokens: number; messages: Array<{ content: string }>; tools?: unknown; response_format: { type: string } }
    assert.equal(body.max_tokens, 512)
    assert.equal(body.tools, undefined)
    assert.equal(body.response_format.type, 'json_schema')
    assert.match(body.messages[0]!.content, /untrusted data/)
    assert.doesNotMatch(String(options?.body), /FORGE_DATABASE_URL|password|coordinator_state/)
    return completion(undefined, 'stop', [])
  }) as typeof fetch)
  assert.deepEqual(await configured.run(input()), artifact)
  for (const baseUrl of ['https://example.com/v1', 'http://127.0.0.1:1234/v1?token=secret', 'http://user:secret@localhost/v1', 'file:///tmp/model']) {
    assert.throws(() => new LocalReportAgent({ baseUrl, model: 'm' }), /credential-free loopback/)
  }
})

test('invalid, truncated, tool-bearing or oversized model output cannot become a plan', async () => {
  const responses = [
    () => completion('not-json'), () => completion(JSON.stringify({ ...artifact, path: '../outside' })),
    () => completion(JSON.stringify(artifact), 'length'), () => completion(JSON.stringify(artifact), 'stop', [{ function: { name: 'shell' } }]),
    () => completion(JSON.stringify({ title: '', content: 'x' })), () => new Response('x'.repeat(160_001)),
  ]
  for (const response of responses) await assert.rejects(agent((async () => response()) as typeof fetch).run(input()), (error: unknown) => error instanceof LocalAgentError && error.code === 'AGENT_INVALID_OUTPUT')
  await assert.rejects(agent((async () => new Response('password=secret', { status: 503 })) as typeof fetch).run(input()), (error: unknown) => error instanceof LocalAgentError && error.code === 'AGENT_HTTP_ERROR' && !error.message.includes('secret'))
})

test('agent transport timeout and caller cancellation fail closed without raw errors', async () => {
  const fetchImpl = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('token=secret')), { once: true })
  })) as typeof fetch
  const configured = new LocalReportAgent({ baseUrl: 'http://127.0.0.1/v1', model: 'test', timeoutMs: 100, fetchImpl })
  await assert.rejects(configured.run(input()), (error: unknown) => error instanceof LocalAgentError && error.code === 'AGENT_TIMEOUT' && !error.message.includes('secret'))
  const stop = new AbortController()
  const pending = configured.run({ task, signal: stop.signal })
  const reason = new Error('Stopped by host')
  stop.abort(reason)
  await assert.rejects(pending, (error) => error === reason)
})

test('immutable external reports reconcile concurrent requests and unknown acknowledgements', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-effect-unit-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const publisher = new ImmutableReportPublisher(root)
  const request = { key: 'coordinator:scope:task:report', artifact, signal: new AbortController().signal }
  const receipts = await Promise.all(Array.from({ length: 8 }, () => publisher.publish(request)))
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0])
  const receipt = receipts[0]!
  assert.match(receipt.filename, /^[a-f0-9]{64}\.report\.md$/)
  assert.deepEqual(await readdir(root), [receipt.filename])
  const before = await stat(path.join(root, receipt.filename))
  const recovered = await new ImmutableReportPublisher(root).publish({ ...request, expected: receipt })
  assert.deepEqual(recovered, receipt)
  assert.equal((await stat(path.join(root, receipt.filename))).mtimeMs, before.mtimeMs)
  assert.equal((await readFile(path.join(root, receipt.filename), 'utf8')).includes(artifact.content), true)
  await assert.rejects(publisher.publish({ ...request, artifact: { ...artifact, content: 'Conflicting retry' } }), (error: unknown) => error instanceof PilotFailure && error.code === 'EFFECT_CONFLICT')
  await unlink(path.join(root, receipt.filename))
  await assert.rejects(publisher.publish({ ...request, expected: receipt }), (error: unknown) => error instanceof PilotFailure && error.code === 'EFFECT_UNCONFIRMED')
  assert.equal((await readdir(root)).length, 0, 'A confirmed but missing effect must not be silently recreated')
})

test('report target changes and linked roots cannot redirect a resumed effect', async (context) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'forge-effect-root-'))
  context.after(() => rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'target')
  await mkdir(root)
  const publisher = new ImmutableReportPublisher(root)
  await rename(root, path.join(parent, 'previous'))
  await mkdir(root)
  assert.notEqual(new ImmutableReportPublisher(root).targetId, publisher.targetId)
  await assert.rejects(publisher.publish({ key: 'key', artifact, signal: new AbortController().signal }), (error: unknown) => error instanceof PilotFailure && error.code === 'EFFECT_TARGET_CHANGED')
  const linked = path.join(parent, 'linked')
  await symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => new ImmutableReportPublisher(linked), /must not be a link/)
})
