import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')

// Run the shipped script with deferred HTTP responses and a minimal DOM.
// These checks exercise ordering without real project data or browser dependencies.
class Element {
  children = []
  listeners = new Map()
  dataset = {}
  value = ''
  disabled = false
  checked = false
  classList = { toggle() {}, add() {}, remove() {} }
  set textContent(value) { this.text = value; this.children = [] }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join('') }
  append(...children) { this.children.push(...children) }
  prepend(...children) { this.children.unshift(...children) }
  replaceChildren(...children) { this.text = ''; this.children = children }
  add(child) { this.append(child) }
  addEventListener(type, listener) { this.listeners.set(type, listener) }
  setAttribute() {}
  removeAttribute() {}
  querySelectorAll() { return [] }
  showModal() { this.open = true }
  close() { this.open = false }
}

function workspace() {
  const nodes = new Map()
  const requests = []
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element())
    return nodes.get(selector)
  }
  const context = {
    document: { querySelector: node, querySelectorAll: () => [], createElement: () => new Element(), documentElement: new Element() },
    Option: function (text, value) { return { textContent: text, value } },
    setInterval() {},
    fetch: (url, options = {}) => new Promise((resolve) => {
      requests.push({ url, options, reply: (result, ok = true) => resolve({ ok, json: async () => ok ? { result } : { error: { message: result } } }) })
    }),
  }
  runInNewContext(source, context, { filename: 'app.js' })
  return {
    node, requests,
    select: (project) => context.selectProject(project),
    search: () => node('#search-form').listeners.get('submit')({ preventDefault() {} }),
    inspect: (id) => context.inspectContinuation({ id }),
  }
}

const alpha = { id: 'alpha', name: 'Alpha', projectKey: 'alpha' }
const beta = { id: 'beta', name: 'Beta', projectKey: 'beta' }
const catalog = (title) => ({
  agents: [], tasks: [], executions: [], contextPackages: [], decisions: [],
  memories: [{ title, updatedAt: '2026-11-06T12:00:00Z' }],
})
const result = (title) => [{ title, sourceKind: 'memory', score: 0.8 }]
const request = (app, url) => app.requests.findLast((entry) => entry.url === url)

test('a late catalog cannot replace the selected project, including A to B to A', async () => {
  const app = workspace()
  const old = app.select(alpha)
  const oldRequest = request(app, '/api/projects/alpha/catalog')
  const middle = app.select(beta)
  const latest = app.select(alpha)
  request(app, '/api/projects/alpha/catalog').reply(catalog('Latest Alpha'))
  await latest
  oldRequest.reply(catalog('Old Alpha'))
  request(app, '/api/projects/beta/catalog').reply('Old Beta error', false)
  await Promise.all([old, middle])
  assert.match(app.node('#memories').textContent, /Latest Alpha/)
  assert.doesNotMatch(app.node('#memories').textContent, /Old Alpha/)
  assert.equal(app.node('#workspace-message').textContent, '')
})

test('changing project clears results and ignores late search success or failure', async () => {
  for (const ok of [true, false]) {
    const app = workspace()
    const loading = app.select(alpha)
    request(app, '/api/projects/alpha/catalog').reply(catalog('Alpha'))
    await loading
    app.node('#query').value = 'earlier query'
    const searching = app.search()
    app.node('#results').append(Object.assign(new Element(), { textContent: 'Previous results' }))
    const next = app.select(beta)
    assert.equal(app.node('#results').textContent, '')
    request(app, '/api/projects/beta/catalog').reply(catalog('Beta'))
    await next
    request(app, '/api/search').reply(ok ? result('Alpha result') : 'Alpha provider error', ok)
    await searching
    assert.equal(app.node('#results').textContent, '')
    assert.equal(app.node('#search-message').textContent, '')
    assert.equal(app.node('#search-button').disabled, false)
  }
})

test('only the latest search owns results, labels and the busy button', async () => {
  const app = workspace()
  void app.select(alpha)
  app.node('#query').value = 'old'
  const old = app.search()
  const oldRequest = request(app, '/api/search')
  app.node('#query').value = 'new'
  app.node('#rerank').checked = true
  const latest = app.search()
  oldRequest.reply(result('Old result'))
  await old
  assert.equal(app.node('#search-button').disabled, true)
  assert.equal(app.node('#results').textContent, '')
  app.node('#rerank').checked = false
  request(app, '/api/search').reply(result('Latest result'))
  await latest
  assert.match(app.node('#results').textContent, /Latest result/)
  assert.match(app.node('#search-message').textContent, /precisión local/)
  assert.equal(app.node('#search-button').disabled, false)
})

test('failed catalog clears stale counts and offers a retry', async () => {
  const app = workspace()
  const initial = app.select(alpha)
  request(app, '/api/projects/alpha/catalog').reply(catalog('Alpha'))
  await initial
  const next = app.select(beta)
  assert.equal(app.node('#memory-count').textContent, '…')
  request(app, '/api/projects/beta/catalog').reply('Catalog unavailable', false)
  await next
  assert.doesNotMatch(app.node('#memories').textContent, /Alpha|Cargando/)
  assert.equal(app.node('#memory-count').textContent, '—')
  assert.equal(app.node('#metric-knowledge').textContent, '—')
  assert.equal(app.node('#next-step-action').dataset.nextAction, 'retry')
  assert.match(app.node('#workspace-message').textContent, /Catalog unavailable/)
})

test('late continuation responses cannot repopulate a dialog after a project switch', async () => {
  for (const ok of [true, false]) {
    const app = workspace()
    void app.select(alpha)
    const inspecting = app.inspect('old-context')
    void app.select(beta)
    request(app, '/api/projects/alpha/context-packages/old-context').reply(ok ? {
      task: { title: 'Old context' }, memories: [], decisions: [], staleSources: [], packageHash: 'old',
    } : 'Old context error', ok)
    await inspecting
    assert.equal(app.node('#context-dialog').open, false)
    assert.equal(app.node('#context-detail').textContent, '')
  }
})

test('the latest continuation inspection wins within the same project', async () => {
  const app = workspace()
  void app.select(alpha)
  const old = app.inspect('old')
  const latest = app.inspect('latest')
  request(app, '/api/projects/alpha/context-packages/latest').reply({
    task: { title: 'Latest continuation' }, memories: [], decisions: [], staleSources: [], packageHash: 'latest',
  })
  await latest
  request(app, '/api/projects/alpha/context-packages/old').reply('Old failure', false)
  await old
  assert.match(app.node('#context-detail').textContent, /Latest continuation/)
  assert.doesNotMatch(app.node('#context-detail').textContent, /Old failure/)
  assert.equal(app.node('#context-dialog').open, true)
})
