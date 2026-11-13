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

import { advanceState, migrateState } from './check-fleet-reachability.mjs'

const cand = (key = 'azure|vultr|scl') => ({ key, failed: 5, observed: 5, others: {} })
const fresh = () => ({ version: 2, lastSlot: null, events: {} })

test('two consecutive 50-min rounds confirm; same round re-run does not double count', () => {
  const st = fresh()
  let r = advanceState(st, [cand()], T('10:07'))
  assert.deepEqual(r.confirmed, [])
  r = advanceState(st, [cand()], T('10:07')) // re-run of the same round
  assert.equal(r.isNewSlot, false)
  assert.equal(st.events['azure|vultr|scl'].candidateStreak, 1)
  r = advanceState(st, [cand()], T('10:57'))
  assert.deepEqual(r.confirmed, ['azure|vultr|scl'])
})

test('a skipped round resets the candidate streak', () => {
  const st = fresh()
  advanceState(st, [cand()], T('10:07'))
  const r = advanceState(st, [cand()], T('11:47')) // ~100 min later
  assert.deepEqual(r.confirmed, [])
  assert.equal(st.events['azure|vultr|scl'].candidateStreak, 1)
})

test('confirmed event recovers after 2 consecutive clear rounds', () => {
  const st = fresh()
  advanceState(st, [cand()], T('10:07'))
  advanceState(st, [cand()], T('10:57'))
  advanceState(st, [], T('11:47'))
  const r = advanceState(st, [], T('12:37'))
  assert.deepEqual(r.recovered, ['azure|vultr|scl'])
})

test('clear, missed round, clear does NOT recover', () => {
  const st = fresh()
  advanceState(st, [cand()], T('10:07'))
  advanceState(st, [cand()], T('10:57'))
  advanceState(st, [], T('11:47')) // clear #1 (adjacent)
  const r = advanceState(st, [], T('13:27')) // gap ~100 min: inconclusive
  assert.deepEqual(r.recovered, [])
  assert.ok(st.events['azure|vultr|scl'])
  assert.equal(st.events['azure|vultr|scl'].recoveryStreak, 0)
})

test('migration: old floored-bucket state cannot falsely confirm on a re-processed round', () => {
  // v1 state: lastSlot is a 30-min floored boundary; event has a 1-round streak
  // stored against that boundary. The same round (real ts 10:27) is then seen
  // 27 min after the boundary, which would look "adjacent" without migration.
  const old = {
    version: 1,
    lastSlot: T('10:00'),
    events: { 'azure|vultr|scl': { firstSlot: T('10:00'), candidateStreak: 1, recoveryStreak: 0, confirmed: false, lastSlot: T('10:00'), last: {} } },
  }
  const st = migrateState(old)
  assert.equal(st.version, 2)
  assert.equal(st.lastSlot, null)
  const r = advanceState(st, [cand()], T('10:27'))
  assert.deepEqual(r.confirmed, [])
  assert.equal(st.events['azure|vultr|scl'].candidateStreak, 1)
})

test('migration keeps a confirmed event active and requires fresh clear rounds', () => {
  const st = migrateState({
    version: 1,
    lastSlot: T('10:00'),
    events: { 'azure|vultr|scl': { firstSlot: T('09:00'), candidateStreak: 3, recoveryStreak: 1, confirmed: true, lastSlot: T('10:00'), last: {} } },
  })
  let r = advanceState(st, [], T('10:27')) // first post-migration round: not adjacent
  assert.deepEqual(r.recovered, [])
  r = advanceState(st, [], T('11:17'))
  assert.deepEqual(r.recovered, [])
  r = advanceState(st, [], T('12:07'))
  assert.deepEqual(r.recovered, ['azure|vultr|scl'])
})

test('migrateState tolerates null / corrupt input', () => {
  assert.deepEqual(migrateState(null), { version: 2, lastSlot: null, events: {} })
  assert.equal(migrateState({}).version, 2)
})
