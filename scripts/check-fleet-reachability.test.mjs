// Run: node --test scripts/check-fleet-reachability.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slotOf, isAdjacentSlot } from './check-fleet-reachability.mjs'

const T = (hhmm, sec = 0) => `2026-11-13T${hhmm}:${String(sec).padStart(2, '0')}.000Z`

test('slotOf uses the round timestamp itself (same round -> same slot)', () => {
  assert.equal(slotOf({ at: T('10:07', 11) }), T('10:07', 11))
  assert.equal(slotOf({ at: T('10:07', 11) }), slotOf({ at: T('10:07', 11) }))
})

test('rounds 50 min apart are adjacent regardless of 30-min boundaries', () => {
  // 10:07 -> 10:57 straddles two 30-min buckets; 10:57 -> 11:47 straddles two as well.
  assert.ok(isAdjacentSlot(T('10:07'), T('10:57')))
  assert.ok(isAdjacentSlot(T('10:57'), T('11:47')))
  assert.ok(isAdjacentSlot(T('11:47'), T('12:37')))
})

test('jitter within 1.5x cadence is still adjacent', () => {
  assert.ok(isAdjacentSlot(T('10:07'), T('11:20'))) // 73 min
})

test('a skipped round (~100 min) is NOT adjacent', () => {
  assert.ok(!isAdjacentSlot(T('10:07'), T('11:47')))
})

test('near-duplicate rounds and same slot are NOT adjacent', () => {
  assert.ok(!isAdjacentSlot(T('10:07'), T('10:07')))
  assert.ok(!isAdjacentSlot(T('10:07'), T('10:12')))
})

test('missing/invalid input is never adjacent', () => {
  assert.ok(!isAdjacentSlot(null, T('10:07')))
  assert.ok(!isAdjacentSlot('garbage', T('10:07')))
})
