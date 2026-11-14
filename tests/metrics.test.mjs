import { test } from 'node:test'
import assert from 'node:assert/strict'
import { perCoreUsage } from '../src/metrics.mjs'

test('per-core usage uses sample deltas instead of cumulative boot totals', () => {
  const prev = [
    { idle: 100, total: 200 },
    { idle: 50, total: 100 }
  ]
  const cur = [
    { idle: 150, total: 300 },   // 100 ticks passed, 50 idle -> 50%
    { idle: 50, total: 200 }     // 100 ticks passed, 0 idle -> 100%
  ]
  assert.deepEqual(perCoreUsage(cur, prev), [50, 100])
})

test('per-core usage is zero before the first comparison and clamps bad deltas', () => {
  const cur = [{ idle: 1, total: 2 }]
  assert.deepEqual(perCoreUsage(cur, null), [0])
  assert.deepEqual(perCoreUsage([{ idle: 0, total: 0 }], [{ idle: 5, total: 5 }]), [0])
})
