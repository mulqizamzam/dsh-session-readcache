// Smoke test for dsh-session-readcache plugin — verifies it is wired
// into the live DSH web host and that the persistence APIs it caches behave
// correctly. The cache layer itself (inspect/list wrapping) is covered by the
// unit suite (tests/logic.mjs) and the real-file integration probe
// (tests/realfile.mts); this test confirms the live host is healthy with the
// plugin installed and that the public persistence RPCs it accelerates still
// resolve through the cache layer without error.
//
// Run: node smoke-test.mjs   (assumes the host is running on :13080)
import assert from 'node:assert/strict'
// TTL mirrors lib/index.js DEFAULTS.listTtlMs and cordis.patch.yml. Imported
// from the plugin's own module so the two cannot drift apart unnoticed.
import { DEFAULTS } from './lib/index.js'

const LIST_TTL_MS = DEFAULTS.listTtlMs
const LIST_MAX_STALE_MS = DEFAULTS.listMaxStaleMs

const BASE_URL = 'http://127.0.0.1:13080'
const results = []
let counter = 0

async function rpc(method, payload = {}) {
  const res = await fetch(`${BASE_URL}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `smoke-${Date.now()}-${counter++}`, method, payload })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`)
  const body = await res.json()
  if (!body.result.ok) throw new Error(`${method}: ${body.result.error.message}`)
  return body.result.value
}

function check(label, fn) {
  try { fn(); results.push(['PASS', label]); console.log(`  PASS: ${label}`) }
  catch (e) { results.push(['FAIL', label, e.message]); console.error(`  FAIL: ${label}\n    ${e.message}`) }
}

async function main() {
  console.log('=== Smoke test: dsh-session-readcache ===\n')

  console.log('1. Host boot health (boot must succeed with plugin installed)')
  const headers = await rpc('session.list', {})
  await check('session.list returns items array', () => assert.ok(Array.isArray(headers.items)))

  console.log(`2. List memo (TTL=${LIST_TTL_MS}ms, stale window=${LIST_MAX_STALE_MS}ms)`)
  const tA0 = Date.now()
  const listA = await rpc('session.list', {})
  const tA1 = Date.now()
  const listB = await rpc('session.list', {})
  const tB1 = Date.now()
  const scanMs = tA1 - tA0
  const bMs = tB1 - tA1
  // The memo stamps its entry when the scan inside A finishes, so whether B
  // was served cannot be read off a clock we do not have. What is observable
  // is cost: a served B comes back far cheaper than A, a re-scanned B does not.
  const served = bMs * 2 < scanMs
  console.log(`  first call: ${scanMs}ms, second call: ${bMs}ms -> ${served ? 'memo SERVED' : 'memo NOT served (full rescan)'}`)
  await check('rapid list() returns a correct result', () => {
    assert.ok(Array.isArray(listB.items), 'second reply must be an items array')
    assert.ok(listB.items.every((item) => typeof item.sessionId === 'string'), 'every item must carry a sessionId')
    if (served) {
      // Served from the memo means the same headers: equality is the contract.
      assert.deepStrictEqual(listA.items, listB.items, 'a memo-served reply must be identical to the one that funded it')
    }
  })
  if (!served) {
    // Say so out loud: a PASS here is not evidence the cache works, only that
    // the host answered correctly while paying for a second scan.
    console.log('  NOTE: this run proves response correctness only; the memo path was not exercised.')
  }

  console.log('3. Session creation (writes path is untouched; must still work)')
  const created = await rpc('session.create', {})
  await check('session.create returns a sessionId', () => assert.ok(created.sessionId))

  const passes = results.filter(r => r[0] === 'PASS').length
  const fails = results.filter(r => r[0] === 'FAIL').length
  console.log(`\n=== Results: ${passes} passed, ${fails} failed ===`)
  if (fails > 0) process.exit(1)
  console.log('ALL SMOKE TESTS PASSED')
}

main().catch(err => {
  console.error('FATAL:', err.message)
  process.exit(1)
})
