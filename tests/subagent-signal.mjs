// Integration test: the subagent inspect(id, signal) paths —
// packages/subagent/subagent/src/list-children.ts:382 and
// continuation.ts:954 — call with an AbortSignal, so they are never folded
// by the in-flight coalescer (by design: lib/index.js:59-65). This file is
// the execution evidence missing from SECURITY-AUDIT.md §4.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

function makeFake({ inspectDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'readcache-sig-'))
  const calls = { inspect: 0, list: 0 }
  const paths = {}
  for (const id of ['c1', 'c2', 'c3']) {
    paths[id] = join(dir, id)
    writeFileSync(paths[id], 'x')
  }
  const service = {
    get inspectCalls() { return calls.inspect },
    get listCalls() { return calls.list },
    locate: (meta) => ({ kind: 'fake', path: paths[meta.id] }),
    async inspect(id, signal) {
      if (signal?.aborted) throw new Error('aborted before read')
      if (inspectDelayMs) await new Promise((r) => setTimeout(r, inspectDelayMs))
      if (signal?.aborted) throw new Error('aborted mid-flight')
      calls.inspect += 1
      if (paths[id] === undefined) throw new Error(`not found: ${id}`)
      return { meta: { id, cwd: dir, createdAt: 1 }, events: [{ seq: 1, type: 'x' }] }
    },
    async list() { calls.list += 1; return ['c1', 'c2', 'c3'].map((id) => ({ id, cwd: dir, createdAt: 1 })) },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: () => () => {} },
  }
  return { ctx, service, paths, dir }
}

const tests = []
function test(label, fn) { tests.push([label, fn]) }

test('signal: 5 concurrent signalled calls are NOT folded (each does own read)', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => service.inspect('c1', new AbortController().signal)),
  )
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'all fulfilled')
  assert.equal(service.inspectCalls, 5, 'signalled callers never coalesce (by design)')
})

test('signal: unsignalled concurrent calls DO fold into one read', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => service.inspect('c2')),
  )
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'all fulfilled')
  assert.equal(service.inspectCalls, 1, 'unsignalled callers coalesce (BUG-1/BUG-2 fix)')
})

test('signal: signalled reads still benefit from the cache', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const first = await service.inspect('c1', new AbortController().signal)
  const second = await service.inspect('c1', new AbortController().signal)
  assert.equal(service.inspectCalls, 1, 'second signalled call hit stat-validated cache')
  assert.equal(first, second, 'same frozen object returned')
})

test('signal: abort before read rejects without poisoning the cache', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => service.inspect('c1', ac.signal), /aborted/)
  assert.equal(service.inspectCalls, 0, 'aborted call never reached the original')
  const ok = await service.inspect('c1')
  assert.equal(service.inspectCalls, 1, 'cache path still healthy after abort')
  assert.ok(ok.events.length > 0)
})

test('signal: abort mid-flight rejects that caller only', async () => {
  const { ctx, service } = makeFake({ inspectDelayMs: 40 })
  apply(ctx, {})
  const ac = new AbortController()
  const pending = assert.rejects(() => service.inspect('c3', ac.signal), /aborted/)
  setTimeout(() => ac.abort(), 10)
  await pending
  const after = await service.inspect('c3')
  assert.ok(after.events.length > 0, 'later read unaffected by earlier abort')
})

test('signal: an ALREADY-aborted signal is rejected even when the entry is cached', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('c1')                       // warm the cache
  assert.equal(service.inspectCalls, 1, 'entry is resident')
  const ac = new AbortController()
  ac.abort()
  // The host rejects this at the first statement of inspect(); the hit branch is
  // the one path that would otherwise return without delegating to it.
  await assert.rejects(() => service.inspect('c1', ac.signal), /aborted/)
  assert.equal(service.inspectCalls, 1, 'the aborted caller never reached the original')
  const ok = await service.inspect('c1')
  assert.equal(ok.events.length, 1, 'the entry survives an aborted caller')
})

test('signal: an abort landing on the cache-hit path rejects that caller', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  await service.inspect('c1')                       // warm the cache
  const ac = new AbortController()
  const pending = service.inspect('c1', ac.signal)  // signalled => never coalesced, parks on the stat
  ac.abort()
  await assert.rejects(() => pending, /aborted/)
  assert.equal(service.inspectCalls, 1, 'no extra read was performed')
  const ok = await service.inspect('c1')
  assert.equal(ok.events.length, 1, 'cache still healthy after a mid-read abort')
})

test('signal: a caller that is already dead pays no directory scan', async () => {
  const { ctx, service } = makeFake()
  apply(ctx, {})
  const ac = new AbortController()
  ac.abort()
  // The miss path resolves a log path through list() before it delegates, so
  // without a check at the top of inspectRead this still-scanned work happens
  // for a caller that was already cancelled on entry.
  await assert.rejects(() => service.inspect('c2', ac.signal), /aborted/)
  assert.equal(service.inspectCalls, 0, 'original never invoked')
  assert.equal(service.listCalls, 0, 'no directory scan for an already-dead caller')
})

let failed = 0
for (const [label, fn] of tests) {
  try { await fn(); console.log(`PASS ${label}`) }
  catch (error) { failed += 1; console.error(`FAIL ${label}\n  ${error.stack ?? error.message}`) }
}
console.log(failed === 0 ? `ALL ${tests.length} PASS` : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
