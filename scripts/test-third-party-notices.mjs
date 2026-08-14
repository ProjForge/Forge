import assert from 'node:assert/strict'
import test from 'node:test'
import { generateWorkbenchNotices } from './generate-third-party-notices.mjs'

test('Workbench third-party notices are deterministic and production-only', async () => {
  const first = await generateWorkbenchNotices()
  const second = await generateWorkbenchNotices()

  assert.equal(first, second)
  assert.match(first, /FORGE Workbench — Third-Party Notices/)
  assert.match(first, /@modelcontextprotocol\/sdk /)
  assert.match(first, /\npg /)
  assert.doesNotMatch(first, /\ntypescript /)
  assert.doesNotMatch(first, /\nesbuild /)
  assert.doesNotMatch(first, /\n@yao-pkg\/pkg /)
})
