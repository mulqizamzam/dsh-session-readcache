#!/usr/bin/env node
// Measures what ONE host SessionPersistence.stat(id) call costs on a real
// jsonl session store, and prints a per-class latency table plus the
// stat-to-list ratio. Expected output shape: a corpus summary, one latency
// block per physical log generation, an unknown-id comparison, a project
// directory scaling table, and a ratio block at the end.
//
// Point it at another machine with two flags:
//   --host <path>   the deepseek-harness checkout   (default DEFAULT_HOST)
//   --root <path>   the jsonl session store root     (default DEFAULT_ROOT)
//   --sample <n>    ids per class to measure        (default 12)
//   --list-scans <n> consecutive list() scans       (default 3)
//
// This script only READS the session store. It never imports the readcache
// plugin, and DSH_HOME is deleted before any host module is imported, so the
// plugin's snapshot file (list-snapshot.db) is never opened, read or written.
// It never writes to the session store either.
//
// The host work being measured lives in
// <host>/packages/session/session-persistence-jsonl/lib/index.js:
//   stat()                   :2593
//   findLog()                :3473
//   readGenerationHeader()   :3172
//   list()                   :2626
import { performance } from 'node:perf_hooks'
import { mkdir, mkdtemp, rm, copyFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

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
const SAMPLE = Number(flag('sample', '12'))
const LIST_SCANS = Number(flag('list-scans', '3'))

const { Context } = await import(`${HOST}/vendor/cordis/lib/index.js`)
const JsonlSessionPersistence = (await import(`${HOST}/packages/session/session-persistence-jsonl/lib/index.js`)).default

// --------------------------------------------------------------------------
// reporting helpers: every printed number names the source it came from
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a')
const ms = (n) => `${f3(n)} ms`

function block(label, source, times) {
  console.log(`  ${label}`)
  console.log(`    source: ${source}`)
  console.log(`    min ${ms(Math.min(...times))}   median ${ms(median(times))}   max ${ms(Math.max(...times))}   n=${times.length}`)
}
function scalar(label, source, value) {
  console.log(`  ${label}`)
  console.log(`    source: ${source}`)
  console.log(`    ${ms(value)}`)
}

async function openBackend(root) {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root })
  return { ctx, svc: ctx.sessionPersistence }
}

// --------------------------------------------------------------------------
// corpus shape: every session dir, classified by the physical generation that
// its log filename encodes (packages/session/session-format/src/filename.js:22
// reads session.jsonl as generation 0 and session.vN.jsonl as generation N)
const projectDirs = (await readdir(ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

const byGeneration = new Map()
for (const project of projectDirs) {
  const sessions = await readdir(join(ROOT, project), { withFileTypes: true }).catch(() => [])
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const logs = (await readdir(join(ROOT, project, session.name), { withFileTypes: true }).catch(() => []))
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl.zstd'))
      .map((f) => f.name)
    if (logs.length === 0) continue
    const generations = logs.map((name) => (name === 'session.jsonl.zstd' ? 0 : Number(name.match(/\.v(\d+)\.jsonl\.zstd$/)?.[1] ?? -1)))
    const selected = Math.max(...generations)
    if (!byGeneration.has(selected)) byGeneration.set(selected, [])
    byGeneration.get(selected).push(session.name)
  }
}
const totalSessions = [...byGeneration.values()].reduce((a, b) => a + b.length, 0)

console.log('')
console.log('='.repeat(78))
console.log('cost of one host stat(id) on a real jsonl session store')
console.log('='.repeat(78))
console.log(`host checkout : ${HOST}`)
console.log(`session store : ${ROOT}`)
console.log(`node         : ${process.version}`)
console.log(`host source  : ${HOST}/packages/session/session-persistence-jsonl/lib/index.js`)
console.log(`project dirs : ${projectDirs.length}`)
console.log(`sessions     : ${totalSessions}`)
console.log('  source: counted from the store path above, one readdir per project dir and per session dir')
for (const [generation, dirs] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
  const file = generation === 0 ? 'session.jsonl.zstd' : `session.v${generation}.jsonl.zstd`
  console.log(`  generation ${generation}: ${String(dirs.length).padStart(5)} sessions   log file ${file}`)
}
console.log('  source: the log file name carries the physical generation, read by packages/session/session-format/src/filename.js:22')

// --------------------------------------------------------------------------
// one full list() scan, the cost the stat() calls are measured against
const { ctx: listCtx, svc: listSvc } = await openBackend(ROOT)
const listTimes = []
let listRows = []
console.log('  source: host lib/index.js:2626 list(), one full scan of the store per line')
for (let i = 0; i < LIST_SCANS; i += 1) {
  const t0 = performance.now()
  listRows = await listSvc.list()
  listTimes.push(performance.now() - t0)
  console.log(`list() scan ${i + 1}: ${ms(listTimes[i])}   ${listRows.length} rows`)
}
const listMedian = median(listTimes)
await listCtx.fiber.dispose()

// --------------------------------------------------------------------------
// stat() per call, one instance, instrumented so the corpus hash call count
// is visible next to the latency it explains
const { ctx, svc } = await openBackend(ROOT)
const originalHash = svc.historicalCorpusRevision.bind(svc)
let hashCalls = 0
svc.historicalCorpusRevision = async (signal) => {
  hashCalls += 1
  return originalHash(signal)
}

console.log('')
console.log('stat() per call, by the physical generation of the session log')
const classes = {}
for (const [generation, dirs] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
  const sample = dirs.slice(0, SAMPLE)
  const times = []
  const callsBefore = hashCalls
  for (const id of sample) {
    const t0 = performance.now()
    await svc.stat(id)
    times.push(performance.now() - t0)
  }
  classes[generation] = { times, ids: sample }
  block(
    `known id, generation ${generation}`,
    `host lib/index.js:2593 stat(), ${sample.length} ids, corpus ${totalSessions} logs`,
    times,
  )
  console.log(`    historicalCorpusRevision() calls: ${hashCalls - callsBefore}   (host lib/index.js:3127, reached from :2611)`)
}

// --------------------------------------------------------------------------
// unknown id against known id, interleaved so neither gets a colder cache
console.log('')
console.log('unknown id against known id, interleaved')
for (const generation of [4, 0]) {
  const ids = classes[generation]?.ids
  if (ids === undefined || ids.length === 0) continue
  const rounds = generation === 4 ? 20 : 6
  const known = []
  const unknown = []
  for (let i = 0; i < rounds; i += 1) {
    let t0 = performance.now()
    await svc.stat(ids[i % ids.length])
    known.push(performance.now() - t0)
    t0 = performance.now()
    await svc.stat(randomUUID())
    unknown.push(performance.now() - t0)
  }
  console.log(`  against a known id of generation ${generation}, ${rounds} interleaved rounds`)
  console.log(`    source: host lib/index.js:2593 stat(); known id from a generation ${generation} session, unknown id is a fresh random UUID`)
  console.log(`    known   min ${ms(Math.min(...known))}   median ${ms(median(known))}   max ${ms(Math.max(...known))}`)
  console.log(`    unknown min ${ms(Math.min(...unknown))}   median ${ms(median(unknown))}   max ${ms(Math.max(...unknown))}`)
  console.log(`    unknown divided by known, median: ${f3(median(unknown) / median(known))}`)
}

// --------------------------------------------------------------------------
// where the time goes
console.log('')
console.log('where the time goes')
const cheapIds = classes[4]?.ids ?? []
if (cheapIds.length > 0) {
  const findLogTimes = []
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now()
    await svc.findLog(cheapIds[0])
    findLogTimes.push(performance.now() - t0)
  }
  const selected = await svc.findLog(cheapIds[0])
  const headerTimes = []
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now()
    await svc.readGenerationHeader(selected, cheapIds[0], undefined)
    headerTimes.push(performance.now() - t0)
  }
  block('findLog()', `host lib/index.js:3473, walks ${projectDirs.length} project dirs, 20 calls`, findLogTimes)
  block('readGenerationHeader()', 'host lib/index.js:3172, one zstd frame plus JSON.parse, 20 calls', headerTimes)
}
{
  const t0 = performance.now()
  await originalHash(undefined)
  scalar(
    'historicalCorpusRevision()',
    `host lib/index.js:3127, enumerates and stats all ${totalSessions} generation logs`,
    performance.now() - t0,
  )
}

// --------------------------------------------------------------------------
// scaling with the number of project directories, on a synthetic root that
// holds one real generation 4 log so the corpus hash stays negligible
console.log('')
console.log('scaling with the number of project directories')
console.log('  source: synthetic roots under the system temp dir, each holding one real generation 4 log, 25 calls per class')
const sourceLog = await findGeneration4Log(ROOT, projectDirs)
if (sourceLog === undefined) {
  console.log('  skipped: no generation 4 log found in the store')
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-stat-cost-'))
  const table = []
  try {
    for (const count of [1, 2, 4, 8, 16, 32, 64, 128]) {
      const root = join(scratch, `root-${count}`)
      await mkdir(root, { recursive: true })
      for (let i = 0; i < count - 1; i += 1) {
        await mkdir(join(root, `filler-${String(i).padStart(4, '0')}`), { recursive: true })
      }
      await mkdir(join(root, sourceLog.project, sourceLog.id), { recursive: true })
      await copyFile(sourceLog.path, join(root, sourceLog.project, sourceLog.id, 'session.v4.jsonl.zstd'))

      const { ctx: scaleCtx, svc: scaleSvc } = await openBackend(root)
      const warm = await scaleSvc.stat(sourceLog.id)
      await scaleCtx.fiber.dispose()
      if (warm === undefined) {
        console.log(`  ${count} project dirs: skipped, the copied session did not resolve`)
        continue
      }
      const known = []
      const unknown = []
      for (let i = 0; i < 25; i += 1) {
        let t0 = performance.now()
        await scaleSvc.stat(sourceLog.id)
        known.push(performance.now() - t0)
        t0 = performance.now()
        await scaleSvc.stat(randomUUID())
        unknown.push(performance.now() - t0)
      }
      await scaleCtx.fiber.dispose()
      table.push({ count, known: median(known), unknown: median(unknown) })
      console.log(
        `  project dirs ${String(count).padStart(3)}: stat(known) median ${ms(median(known)).padStart(10)}   stat(unknown) median ${ms(median(unknown)).padStart(10)}`,
      )
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  if (table.length >= 2) {
    const first = table[0]
    const last = table[table.length - 1]
    const steps = last.count - first.count
    console.log('')
    console.log('  source: the slope between the first and the last row of the table above, per added project dir')
    console.log(`  marginal per project dir, known id:   ${f3((last.known - first.known) / steps)} ms/dir`)
    console.log(`  marginal per project dir, unknown id: ${f3((last.unknown - first.unknown) / steps)} ms/dir`)
  }
}

await ctx.fiber.dispose()

// --------------------------------------------------------------------------
// the ratio
console.log('')
console.log('='.repeat(78))
console.log('the ratio')
console.log('='.repeat(78))
const statGeneration4 = median(classes[4]?.times ?? [])
const statGeneration0 = median(classes[0]?.times ?? [])
console.log('  source: the stat() medians measured above against the list() median measured above')
console.log(`  one stat() on a generation 4 id : ${ms(statGeneration4)}`)
console.log(`  one stat() on a generation 0 id : ${ms(statGeneration0)}`)
console.log(`  one list() scan                 : ${ms(listMedian)}   median of ${LIST_SCANS} scans`)
if (statGeneration4 > 0) console.log(`  stat to list, generation 4 : 1 : ${(listMedian / statGeneration4).toFixed(1)}`)
if (statGeneration0 > 0) console.log(`  stat to list, generation 0 : 1 : ${(listMedian / statGeneration0).toFixed(1)}`)
console.log('')
process.exit(0)

// --------------------------------------------------------------------------
// helpers that need the host or the store, declared last so the flow above
// reads top to bottom
async function findGeneration4Log(root, projects) {
  for (const project of projects) {
    const sessions = await readdir(join(root, project), { withFileTypes: true }).catch(() => [])
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const logs = await readdir(join(root, project, session.name), { withFileTypes: true }).catch(() => [])
      if (logs.some((f) => f.isFile() && f.name === 'session.v4.jsonl.zstd')) {
        return {
          project,
          id: session.name,
          path: join(root, project, session.name, 'session.v4.jsonl.zstd'),
        }
      }
    }
  }
  return undefined
}
