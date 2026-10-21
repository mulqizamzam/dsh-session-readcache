#!/usr/bin/env node
// Measures what a wave of disposes costs when each one fires one host
// stat(id) call, and how much of that reaches the disk device. Expected
// output shape: a wall clock and a device counter block per wave size, two
// reference workloads, and a saturation test that runs the reference read
// while a wave runs.
//
// The host dispose listener does not await its listeners
// (packages/core/session/src/index.ts:403), so N disposes in a wave start N
// independent stat() calls. This script measures that wave, not the plugin:
// it calls the host persistence service directly and never mounts the
// readcache plugin.
//
// Point it at another machine with two flags:
//   --host <path>   the deepseek-harness checkout   (default DEFAULT_HOST)
//   --root <path>   the jsonl session store root     (default DEFAULT_ROOT)
//
// This script only READS the session store. It never imports the readcache
// plugin, and DSH_HOME is deleted before any host module is imported, so the
// plugin's snapshot file (list-snapshot.db) is never opened, read or written.
// It never writes to the session store either.
//
// The host work being measured lives in
// <host>/packages/session/session-persistence-jsonl/lib/index.js:
//   stat()                    :2593
//   historicalCorpusRevision():3127   (enumerates and stats every log)
//   list()                    :2626
//
// The device counters come from /proc/diskstats for the device that backs the
// store, and that device is found by asking the filesystem, not hardcoded.
import { performance } from 'node:perf_hooks'
import { readdir, readFile, open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// The host derives its default snapshot path from DSH_HOME. Dropping the
// variable before the first dynamic import means no module can resolve that
// path, so the live snapshot file stays untouched.
delete process.env.DSH_HOME

const DEFAULT_HOST = '/home/administrator/deepseek-harness'
const DEFAULT_ROOT = '/home/administrator/agent-workspace/.dsh/sessions'

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const HOST = resolve(flag('host', DEFAULT_HOST))
const ROOT = resolve(flag('root', DEFAULT_ROOT))

const { Context } = await import(`${HOST}/vendor/cordis/lib/index.js`)
const JsonlSessionPersistence = (await import(`${HOST}/packages/session/session-persistence-jsonl/lib/index.js`)).default

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a')
const ms = (n) => `${f3(n)} ms`
const mib = (n) => `${f3(n / 1024 / 1024)} MiB`

// The device that backs the session store, read from the filesystem itself.
const storeStat = await stat(ROOT)
const device = { major: (storeStat.dev >> 8) & 0xff, minor: storeStat.dev & 0xff }

// Per device counters: sectors_read and sectors_written are 512 byte units.
async function deviceCounters() {
  try {
    const raw = await readFile('/proc/diskstats', 'utf8')
    for (const line of raw.split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10) continue
      if (Number(fields[0]) === device.major && Number(fields[1]) === device.minor) {
        return {
          sectorsRead: Number(fields[5]),
          sectorsWritten: Number(fields[9]),
          readsCompleted: Number(fields[3]),
          writesCompleted: Number(fields[7]),
        }
      }
    }
  } catch {
    // no counters on this platform
  }
  return undefined
}

function delta(before, after) {
  if (before === undefined || after === undefined) return undefined
  return {
    readBytes: (after.sectorsRead - before.sectorsRead) * 512,
    writeBytes: (after.sectorsWritten - before.sectorsWritten) * 512,
    readOps: after.readsCompleted - before.readsCompleted,
    writeOps: after.writesCompleted - before.writesCompleted,
  }
}

function deviceLine(d) {
  if (d === undefined) return '    device counters: unavailable on this platform'
  return `    device: read ${mib(d.readBytes)} in ${d.readOps} reads, write ${mib(d.writeBytes)} in ${d.writeOps} writes`
}

// Classify every session dir by the physical generation its log filename
// encodes (packages/session/session-format/src/filename.js:22 reads
// session.jsonl as generation 0 and session.vN.jsonl as generation N).
const projectDirs = (await readdir(ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

const byGeneration = new Map()
const logFiles = []
for (const project of projectDirs) {
  const sessions = await readdir(join(ROOT, project), { withFileTypes: true }).catch(() => [])
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const logs = (await readdir(join(ROOT, project, session.name), { withFileTypes: true }).catch(() => []))
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl.zstd'))
    if (logs.length === 0) continue
    const generations = logs.map((f) => (f.name === 'session.jsonl.zstd' ? 0 : Number(f.name.match(/\.v(\d+)\.jsonl\.zstd$/)?.[1] ?? -1)))
    const selected = Math.max(...generations)
    if (!byGeneration.has(selected)) byGeneration.set(selected, [])
    byGeneration.get(selected).push(session.name)
    for (const f of logs) logFiles.push(join(ROOT, project, session.name, f.name))
  }
}

const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root: ROOT })
const svc = ctx.sessionPersistence

console.log('')
console.log('='.repeat(78))
console.log('a wave of disposes, each firing one stat()')
console.log('='.repeat(78))
console.log(`store           : ${ROOT}`)
console.log(`backing device  : major ${device.major} minor ${device.minor}`)
console.log('  source: the device number comes from asking the filesystem about the store path')
console.log('device counters : /proc/diskstats, sectors multiplied by 512 bytes')
console.log(`sessions        : ${[...byGeneration.values()].reduce((a, b) => a + b.length, 0)}`)
console.log('  source: counted from the store path above, one readdir per project dir and per session dir')
for (const [generation, ids] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
  console.log(`  generation ${generation}: ${String(ids.length).padStart(5)} sessions`)
}
console.log('  source: the log file name carries the physical generation, read by packages/session/session-format/src/filename.js:22')
console.log('')

for (const generation of [...byGeneration.keys()].sort()) {
  const ids = byGeneration.get(generation)
  for (const wave of [1, 5, 10]) {
    const sample = ids.slice(0, wave)
    const before = await deviceCounters()
    const t0 = performance.now()
    await Promise.all(sample.map((id) => svc.stat(id)))
    const wall = performance.now() - t0
    const d = delta(before, await deviceCounters())
    console.log(`  generation ${generation}, ${String(wave).padStart(2)} disposes in one wave`)
    console.log(`    wall ${ms(wall)}   ${f3(wall / wave)} ms per dispose, the calls run concurrently`)
    console.log('    source: host lib/index.js:2593 stat(), one call per disposed id')
    console.log(deviceLine(d))
  }
  const sample = ids.slice(0, 5)
  const before = await deviceCounters()
  const t0 = performance.now()
  for (const id of sample) await svc.stat(id)
  const wall = performance.now() - t0
  const d = delta(before, await deviceCounters())
  console.log(`  generation ${generation},  5 disposes one after another`)
  console.log(`    wall ${ms(wall)}   ${f3(wall / 5)} ms per dispose, each call awaited before the next`)
  console.log('    source: host lib/index.js:2593 stat(), one call per disposed id')
  console.log(deviceLine(d))
  console.log('')
}

// Reference: what the same device does under a host list() scan, and under a
// plain data read. The dispose wave has to be compared against both.
{
  const before = await deviceCounters()
  const t0 = performance.now()
  const rows = await svc.list()
  const wall = performance.now() - t0
  const d = delta(before, await deviceCounters())
  console.log('  reference: one host list() scan')
  console.log(`    wall ${ms(wall)}   ${rows.length} rows`)
  console.log('    source: host lib/index.js:2626 list(), the scan the plugin replaces')
  console.log(deviceLine(d))
  console.log('')
}

const readBytes = async (limit) => {
  let bytes = 0
  for (const path of logFiles) {
    if (bytes >= limit) break
    const handle = await open(path, 'r')
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      bytes += bytesRead
    }
    await handle.close()
  }
  return bytes
}

{
  // Warm the page cache for the log content first. The dispose wave is
  // metadata only, so it never brings log content into the cache. The
  // sensitive question is whether the wave slows work that is already
  // cached, so the baseline has to be the cache warm path. A cold baseline
  // would measure the disk fetch instead and make the ratio meaningless.
  await readBytes(64 * 1024 * 1024)
  const before = await deviceCounters()
  const t0 = performance.now()
  const bytes = await readBytes(64 * 1024 * 1024)
  const wall = performance.now() - t0
  const d = delta(before, await deviceCounters())
  console.log('  reference: reading 64 MiB of real log content, page cache already warm')
  console.log(`    wall ${ms(wall)}   ${mib(bytes)} read from ${logFiles.length} log files`)
  console.log('    source: a plain sequential read of the store log files, the control for the saturation test')
  console.log(deviceLine(d))
  const baselineWall = wall

  // The saturation test: the same control read, but this time a wave of ten
  // generation 0 disposes runs at the same time. If the wave saturated the
  // disk, the control read would slow down.
  const waveIds = (byGeneration.get(0) ?? []).slice(0, 10)
  if (waveIds.length === 10) {
    const waveBefore = await deviceCounters()
    const t1 = performance.now()
    const readPromise = readBytes(64 * 1024 * 1024)
    const wavePromise = Promise.all(waveIds.map((id) => svc.stat(id)))
    const [readWall, waveWall] = await Promise.all([
      readPromise.then(() => performance.now() - t1),
      wavePromise.then(() => performance.now() - t1),
    ])
    const d = delta(waveBefore, await deviceCounters())
    console.log('')
    console.log('  saturation test: the same control read, while ten generation 0 disposes run')
    console.log('    source: host lib/index.js:2593 stat(), ten concurrent calls, measured against the same read')
    console.log('    note: both reads are page cache warm, so the ratio is what the wave costs other work, not disk fetch time')
    console.log(`    control read on its own      : wall ${ms(baselineWall)}`)
    console.log(`    control read during the wave : wall ${ms(readWall)}   (${f3(readWall / baselineWall)} times the baseline)`)
    console.log(`    the wave itself              : wall ${ms(waveWall)}`)
    console.log(deviceLine(d))
  }
}

await ctx.fiber.dispose()
console.log('')
process.exit(0)
