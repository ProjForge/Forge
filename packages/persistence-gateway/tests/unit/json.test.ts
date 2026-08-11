import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalize, hashJson, stableStringify } from '../../src/domain/json.js'

test('canonical JSON is stable across object key order', () => {
  const left = { z: 3, nested: { b: true, a: 'value' }, a: 1 }
  const right = { a: 1, nested: { a: 'value', b: true }, z: 3 }

  assert.equal(stableStringify(left), stableStringify(right))
  assert.equal(hashJson(left), hashJson(right))
})

test('canonical JSON omits undefined object fields and normalizes arrays and dates', () => {
  assert.deepEqual(canonicalize({
    omitted: undefined,
    array: [1, undefined, 3],
    date: new Date('2026-08-08T12:00:00.000Z'),
  }), {
    array: [1, null, 3],
    date: '2026-08-08T12:00:00.000Z',
  })
})

test('canonical JSON rejects unsupported or non-finite values', () => {
  assert.throws(() => canonicalize(Number.NaN), /finite/i)
  assert.throws(() => canonicalize(Symbol('invalid')), /unsupported/i)
})
