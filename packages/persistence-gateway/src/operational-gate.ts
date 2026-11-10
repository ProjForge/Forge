import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const context = new AsyncLocalStorage<{ root: string; active: boolean }>()
type State = { version: 1; phase: 'open' | 'closed'; owner: string }

/** Trusted, private shared directory; never expire or steal crashed admissions. */
export class OperationalGate {
  constructor(readonly root: string) {
    if (!path.isAbsolute(root)) throw new Error('Operational gate requires an absolute private path')
  }
  static async initialize(root: string): Promise<OperationalGate> {
    const gate = new OperationalGate(root)
    await mkdir(root) // existing/missing-parent paths deliberately reject
    await mkdir(path.join(root, 'active'))
    await writeFile(path.join(root, 'state.json'), JSON.stringify({ version: 1, phase: 'open', owner: randomUUID() }), { flag: 'wx', mode: 0o600 })
    return gate
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.root, 'mutex')
    const until = Date.now() + 2_000
    for (;;) {
      try { await mkdir(lock); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= until) throw new Error('Operational gate unavailable')
        await delay(10)
      }
    }
    try { return await operation() } finally { await rm(lock, { recursive: true }) }
  }
  private async state(): Promise<State> {
    const state = JSON.parse(await readFile(path.join(this.root, 'state.json'), 'utf8')) as State
    if (state.version !== 1 || !['open', 'closed'].includes(state.phase) || !/^[a-f0-9-]{36}$/.test(state.owner)) throw new Error('Invalid operational gate')
    return state
  }
  private async save(state: State): Promise<void> {
    const temporary = path.join(this.root, `state-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    await rename(temporary, path.join(this.root, 'state.json'))
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    const inherited = context.getStore()
    if (inherited?.root === this.root && inherited.active) return operation()
    const ticket = path.join(this.root, 'active', randomUUID())
    await this.locked(async () => {
      if ((await this.state()).phase !== 'open') throw new Error('Operational gate closed')
      await writeFile(ticket, '', { flag: 'wx', mode: 0o600 })
    })
    const admission = { root: this.root, active: true }
    try { return await context.run(admission, operation) }
    finally { admission.active = false; await rm(ticket) }
  }
  async close(timeoutMs = 30_000): Promise<{ assertHeld(): Promise<void>; resume(): Promise<void> }> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Invalid drain deadline')
    const owner = randomUUID()
    await this.locked(async () => {
      if ((await this.state()).phase !== 'open') throw new Error('Operational gate already closed')
      await this.save({ version: 1, phase: 'closed', owner })
    })
    const assertHeld = async () => {
      const state = await this.state()
      if (state.phase !== 'closed' || state.owner !== owner || (await readdir(path.join(this.root, 'active'))).length) throw new Error('Operational gate not owned and drained')
    }
    const until = Date.now() + timeoutMs
    while ((await readdir(path.join(this.root, 'active'))).length) {
      if (Date.now() >= until) throw new Error('Operational drain timeout; gate remains closed')
      await delay(10)
    }
    await assertHeld()
    return { assertHeld, resume: () => this.locked(async () => {
      await assertHeld()
      await this.save({ version: 1, phase: 'open', owner: randomUUID() })
    }) }
  }
}

/** Opt-in for an isolated topology; unset preserves existing deployments. */
export function withOperationalAdmission<T>(operation: () => Promise<T>): Promise<T> {
  const root = process.env.FORGE_OPERATIONAL_GATE_ROOT
  return root === undefined ? operation() : new OperationalGate(root).run(operation)
}

/** Wrap public async ports once, rather than each HTTP/MCP route. */
export function operationalPort<T extends object>(target: T): T {
  return new Proxy(target, { get(object, key) {
    const value: unknown = Reflect.get(object, key)
    if (typeof value !== 'function') return value
    if (key === 'close') return value.bind(object)
    return (...args: unknown[]) => withOperationalAdmission(() => value.apply(object, args))
  } })
}
