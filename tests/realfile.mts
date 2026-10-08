// Integration probe: wrapper + a real 12MB session log decoded by the real frame decoder.
// Proves: first read pays full cost, cached repeat is ~free, and a file change invalidates.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanZstdFrames, createZstdFrameDecoder } from '/home/administrator/deepseek-harness/packages/session/session-persistence-jsonl/src/zstd.ts'
import { apply } from '../lib/index.js'

// The session store is live; discover the largest log at run time instead of
// pinning an id that rotates.
const SESSIONS_ROOT = '/home/administrator/agent-workspace/.dsh/sessions'
function largestSessionLog(): string {
  let best = { size: -1, path: '' }
  for (const project of readdirSync(SESSIONS_ROOT)) {
    let sessions
    try { sessions = readdirSync(join(SESSIONS_ROOT, project)) } catch { continue }
    for (const session of sessions) {
      const candidate = join(SESSIONS_ROOT, project, session, 'session.jsonl.zstd')
      try {
        const size = statSync(candidate).size
        if (size > best.size) best = { size, path: candidate }
      } catch { /* no log in this dir */ }
    }
  }
  if (best.path === '') throw new Error('no session.jsonl.zstd found')
  return best.path
}
const SOURCE = largestSessionLog()
console.log(`source: ${SOURCE} (${(statSync(SOURCE).size / 1e6).toFixed(1)} MB)`)

const dir = mkdtempSync(join(tmpdir(), 'readcache-real-'))
const path = join(dir, 'session.jsonl.zstd')
copyFileSync(SOURCE, path)

const meta = { id: 's1', cwd: dir, createdAt: 1 }
const calls = { inspect: 0 }
const service = {
  get inspectCalls() { return calls.inspect },
  locate: () => ({ kind: 'jsonl', path }),
  async list() { return [{ ...meta }] },
  async inspect() {
    calls.inspect += 1
    const { readFileSync } = await import('node:fs')
    const buf = readFileSync(path)
    const { frames } = scanZstdFrames(buf)
    const decoder = createZstdFrameDecoder()
    const parts: Buffer[] = []
    for (const plaintext of decoder.decode(buf, frames)) parts.push(Buffer.from(plaintext))
    const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
    const events = lines.map((l) => JSON.parse(l))
    return { meta, events }
  },
}
const ctx = {
  inject: (names: string[], cb: (deps: Record<string, unknown>) => void) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
  effect: (fn: () => () => void) => fn(),
  logger: { info: (msg: string) => console.log(msg) },
}

apply(ctx, {})

const t0 = performance.now()
const first: any = await service.inspect('s1')
const t1 = performance.now()
const second: any = await service.inspect('s1')
const t2 = performance.now()

assert.equal(calls.inspect, 1, 'repeat open must not re-read the file')
assert.equal(first, second, 'cached view is the same frozen inspection object')
assert.ok(first.events.length > 0, `parsed ${first.events.length} events (real decode)`)
console.log(`first open:  ${(t1 - t0).toFixed(0)} ms (${first.events.length} events, real decode)`)
console.log(`cached open: ${(t2 - t1).toFixed(1)} ms, original called ${calls.inspect}x`)
assert.ok(t1 - t0 > 100, 'sanity: real parse should take measurable time')
assert.ok(t2 - t1 < 20, 'cached path should be sub-20ms')

// Append a real second frame: mimics a concurrent writer and must invalidate.
const { zstdCompressSync } = await import('node:zlib')
appendFileSync(path, zstdCompressSync(Buffer.concat([Buffer.from(JSON.stringify({ seq: 999999, type: 'x' })), Buffer.from('\n', 'utf8')]) ))
const t3 = performance.now()
const third: any = await service.inspect('s1')
const t4 = performance.now()
assert.equal(calls.inspect, 2, 'file change must invalidate the cache entry')
assert.equal(third.events.at(-1).seq, 999999, 're-read sees the appended event')
console.log(`after change: ${(t4 - t3).toFixed(0)} ms, re-read ${calls.inspect}x`)
console.log('ALL PASS')
