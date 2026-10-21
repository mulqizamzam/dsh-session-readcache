// PROBE: does the snapshot write land on the caller's response path?
//
// lib/index.js calls saveSnapshot(...), whose body starts with a JSON
// stringify of the whole list, before it returns the scan result. The code
// comment and README 5.2 both claim the write happens "off the response
// path", i.e. after the caller's reply has been delivered.
//
// The probe records the ORDER of three events instead of timestamps:
//   scan-resolved  the host's scan produced its result
//   stringify      the plugin serialized the list for the snapshot
//   caller-resumed the caller's await returned
//
// If "stringify" lands between the other two, the caller waited for it.
//
// Usage: node artifacts/perf/probe-snapshot-response-path.mjs [libPath]
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

const LIB = process.argv[2] ?? new URL('../lib/index.js', import.meta.url).pathname
const { apply } = await import(LIB)

// HERMETIC: without this the plugin resolves the DEFAULT snapshot path from
// DSH_HOME, so the script would read and write the live host's snapshot file.
delete process.env.DSH_HOME

const N = 4016
const realStringify = JSON.stringify

function buildSnapshots(tag) {
  return Array.from({ length: N }, (_, i) => ({
    header: {
      version: 4,
      id: `0199b1f2-0000-7000-8000-${String(i).padStart(12, '0')}`,
      createdAt: 1757000000000 + i,
      cwd: `${tag}-${i % 37}`,
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'default',
    },
    revision: `1757000000000:${i}:${i}`,
    sizeBytes: 4096 + (i % 9000),
  }))
}

async function measure(withSnapshot) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-probe-'))
  const path = withSnapshot ? join(dir, 'list-snapshot.db') : undefined
  const tag = `tag${Math.round(performance.now() * 1000)}`
  const snapshots = buildSnapshots(tag)
  const events = []
  let stringifyMs = 0
  JSON.stringify = function patched(value, ...rest) {
    const t = performance.now()
    const out = realStringify.call(JSON, value, ...rest)
    if (Array.isArray(value) && value.length === N && value[0]?.header?.cwd === `${tag}-0` && !events.includes('stringify')) {
      events.push('stringify')
      stringifyMs = performance.now() - t
    }
    return out
  }
  const service = {
    async list() {
      await new Promise((r) => setTimeout(r, 5))   // stand in for the scan
      events.push('scan-resolved')
      return snapshots.map((s) => ({ ...s, header: { ...s.header } }))
    },
  }
  const ctx = {
    inject: (names, cb) => cb({ sessionPersistence: service, sessions: { get: () => undefined } }),
    effect: (fn) => fn(),
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: () => () => {} },
  }
  apply(ctx, { snapshotPath: path })

  const before = performance.now()
  await service.list()
  events.push('caller-resumed')
  const after = performance.now()
  // Keep the patch installed long enough to catch a deferred write.
  await new Promise((r) => setTimeout(r, 100))
  JSON.stringify = realStringify
  rmSync(dir, { recursive: true, force: true })
  return { events, stringifyMs, onPath: after - before }
}

// One warm-up run for the JIT, then the measurement.
await measure(true)
const result = await measure(process.argv[3] !== 'off')

console.log(`corpus: ${N} session snapshots`)
console.log(`event order: ${result.events.join(' -> ')}`)
console.log(`serialization cost: ${result.stringifyMs.toFixed(3)} ms`)
console.log(`caller's total wait: ${result.onPath.toFixed(3)} ms`)
const onPath = result.events.indexOf('stringify') > -1 &&
  result.events.indexOf('stringify') < result.events.indexOf('caller-resumed')
console.log(`=> the caller waited for the serialization: ${onPath}`)
