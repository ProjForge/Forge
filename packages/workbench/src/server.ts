import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ForgeWorkbenchService } from './service.js'

const jsonLimit = 64 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const publicFiles = new Set([
  '/index.html', '/app.js', '/styles.css', '/workspace.css', '/brand.css',
  '/brand/forge-favicon.svg', '/brand/forge-favicon-256.png', '/brand/forge-mark-color.svg',
])

function contentType(file: string): string {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    default: return 'application/octet-stream'
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > jsonLimit) throw new TypeError('Request body exceeds 64 KiB')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('JSON body must be an object')
  return parsed as Record<string, unknown>
}

function text(input: Record<string, unknown>, key: string, max: number, optional = false): string | undefined {
  const value = input[key]
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${key} must be a non-empty string`)
  const normalized = value.trim()
  if (normalized.length > max) throw new TypeError(`${key} exceeds ${max} characters`)
  return normalized
}

function projectId(value: string | undefined): string {
  if (!value || !uuid.test(value)) throw new TypeError('projectId must be a UUID')
  return value
}

function knownError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof SyntaxError || error instanceof TypeError) {
    return { status: 400, code: 'INVALID_REQUEST', message: error.message }
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' || error.code === 'OPTIMISTIC_LOCK_FAILED' ? 409 : 502
    return { status, code: error.code, message: error.message }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Workbench request failed' }
}

function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost')
      && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === port
      && parsed.protocol === 'http:'
  } catch { return false }
}

async function staticFile(response: ServerResponse, publicDir: string, pathname: string): Promise<void> {
  const file = pathname === '/' ? '/index.html' : pathname
  if (!publicFiles.has(file)) { json(response, 404, { error: { code: 'NOT_FOUND', message: 'Resource not found' } }); return }
  const path = join(publicDir, file.slice(1))
  await stat(path)
  securityHeaders(response)
  response.statusCode = 200
  response.setHeader('content-type', contentType(path))
  createReadStream(path).pipe(response)
}

export interface WorkbenchServerOptions {
  publicDir: string
  token?: string
}

export function createWorkbenchServer(service: ForgeWorkbenchService, options: WorkbenchServerOptions): Server {
  const token = options.token ?? randomBytes(32).toString('base64url')
  let listeningPort = 0
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith('/api/')) { await staticFile(response, options.publicDir, url.pathname); return }
      if (!originAllowed(request, listeningPort)) { json(response, 403, { error: { code: 'ORIGIN_REJECTED', message: 'Origin is not allowed' } }); return }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') { json(response, 200, { token }); return }
      if (request.headers['x-forge-token'] !== token) { json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Workbench token' } }); return }

      if (request.method === 'GET' && url.pathname === '/api/status') { json(response, 200, { result: await service.status() }); return }
      if (request.method === 'GET' && url.pathname === '/api/projects') { json(response, 200, { result: await service.projects() }); return }
      const catalogMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/catalog$/)
      if (request.method === 'GET' && catalogMatch) { json(response, 200, { result: await service.catalog(projectId(catalogMatch[1])) }); return }

      if (request.method === 'POST' && url.pathname === '/api/projects') {
        const input = await body(request)
        json(response, 201, { result: await service.registerProject({
          projectKey: text(input, 'projectKey', 200)!, name: text(input, 'name', 500)!,
          ...(text(input, 'description', 4_000, true) ? { description: text(input, 'description', 4_000, true)! } : {}),
        }) })
        return
      }

      const memoryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/memories$/)
      if (request.method === 'POST' && memoryMatch) {
        const input = await body(request)
        json(response, 201, { result: await service.remember({
          projectId: projectId(memoryMatch[1]), memoryType: 'observation',
          epistemicState: 'observed', trustLevel: 'internal', importance: 'normal',
          ...(text(input, 'title', 500, true) ? { title: text(input, 'title', 500, true)! } : {}),
          content: text(input, 'content', 32_000)!, idempotencyKey: text(input, 'idempotencyKey', 500)!,
        }) })
        return
      }

      const decisionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/decisions$/)
      if (request.method === 'POST' && decisionMatch) {
        const input = await body(request)
        json(response, 201, { result: await service.saveDecision({
          projectId: projectId(decisionMatch[1]), decisionKey: text(input, 'decisionKey', 200)!,
          title: text(input, 'title', 500)!, decisionText: text(input, 'decisionText', 32_000)!,
          ...(text(input, 'rationale', 32_000, true) ? { rationale: text(input, 'rationale', 32_000, true)! } : {}),
          status: 'accepted', idempotencyKey: text(input, 'idempotencyKey', 500)!,
        }) })
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/search') {
        const input = await body(request)
        const kinds = input.sourceKinds === undefined ? ['memory', 'decision'] : input.sourceKinds
        if (!Array.isArray(kinds) || kinds.some((kind) => kind !== 'memory' && kind !== 'decision')) throw new TypeError('sourceKinds contains an unsupported value')
        json(response, 200, { result: await service.search({
          projectId: projectId(text(input, 'projectId', 100)), query: text(input, 'query', 32_000)!,
          sourceKinds: kinds, limit: 10, ...(input.rerank === true ? { rerank: true } : {}),
        }) })
        return
      }
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Resource not found' } })
    } catch (error) {
      const mapped = knownError(error)
      if (mapped.status === 500) console.error('FORGE Workbench request failed:', error)
      json(response, mapped.status, { error: { code: mapped.code, message: mapped.message } })
    }
  })
  server.on('listening', () => {
    const address = server.address()
    if (address && typeof address === 'object') listeningPort = address.port
  })
  return server
}
