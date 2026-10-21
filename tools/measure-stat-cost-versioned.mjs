#!/usr/bin/env node
// Shows WHY a stat(id) call on a generation 0 session is expensive: the host
// reaches historicalCorpusRevision(), which enumerates and stats every
// generation log in the store, so the call costs the whole corpus rather than
// one file. Expected output shape: a per-generation call count, the cost of
// the corpus hash on its own, and a table where the stat() cost grows with
// the number of logs in the store while the project directory count stays at
// one.
//
// Point it at another machine with two flags:
//   --host <path>   the deepseek-harness checkout   (default DEFAULT_HOST)
//   --root <path>   the jsonl session store root     (default DEFAULT_ROOT)
//
// This script only READS the session store. It never imports the readcache
// plugin, and DSH_HOME is deleted before any host module is imported, so the
// plugin's snapshot file (list-snapshot.db) is never opened, read or written.
// It never writes to the session store either. The synthetic stores it builds
// live under the system temp dir and are removed when the run ends.
//
// The host work being measured lives in
// <host>/packages/session/session-persistence-jsonl/lib/index.js:
//   stat()                   :2593   (reaches the corpus hash at :2611)
//   historicalCorpusRevision():3127   (enumerates and stats every log)
//   findLog()                :3473   (walks the project directories)
//   readGenerationHeader()   :3172   (one zstd frame plus JSON.parse)
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

const { Context } = await import(`${HOST}/vendor/cordis/lib/index.js`)
const JsonlSessionPersistence = (await import(`${HOST}/packages/session/session-persistence-jsonl/lib/index.js`)).default

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a')
const ms = (n) => `${f3(n)} ms`

async function openBackend(root) {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root })
  return { ctx, svc: ctx.sessionPersistence }
}

// --------------------------------------------------------------------------
// classify every session dir by the physical generation its log filename
// encodes (packages/session/session-format/src/filename.js:22 reads
// session.jsonl as generation 0 and session.vN.jsonl as generation N)
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
    byGeneration.get(selected).push({ id: session.name, project, path: join(ROOT, project, session.name) })
  }
}
const totalSessions = [...byGeneration.values()].reduce((a, b) => a + b.length, 0)

console.log('')
console.log('='.repeat(78))
console.log('why stat() on a generation 0 session costs the whole corpus')
console.log('='.repeat(78))
console.log(`host checkout : ${HOST}`)
console.log(`session store : ${ROOT}`)
console.log(`project dirs  : ${projectDirs.length}`)
console.log(`sessions      : ${totalSessions}`)
console.log('  source: counted from the store path above, one readdir per project dir and per session dir')
for (const [generation, entries] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
  const file = generation === 0 ? 'session.jsonl.zstd' : `session.v${generation}.jsonl.zstd`
  console.log(`  generation ${generation}: ${String(entries.length).padStart(5)} sessions   log file ${file}`)
}
console.log('  source: the log file name carries the physical generation, read by packages/session/session-format/src/filename.js:22')

// --------------------------------------------------------------------------
// the call count, measured by wrapping the host method on the instance
const { ctx, svc } = await openBackend(ROOT)
const originalHash = svc.historicalCorpusRevision.bind(svc)
let hashCalls = 0
svc.historicalCorpusRevision = async (signal) => {
  hashCalls += 1
  return originalHash(signal)
}

console.log('')
console.log('historicalCorpusRevision() calls per stat() call')
console.log('  source: host lib/index.js:2611 decides on sourceVersion, :3127 does the work')
for (const [generation, entries] of [...byGeneration].sort((a, b) => a[0] - b[0])) {
  const sample = entries.slice(0, 10)
  const before = hashCalls
  for (const entry of sample) await svc.stat(entry.id)
  console.log(`  generation ${generation}: ${hashCalls - before} calls over ${sample.length} stat() calls`)
}
{
  const before = hashCalls
  for (let i = 0; i < 20; i += 1) await svc.stat(randomUUID())
  console.log(`  unknown id:  ${hashCalls - before} calls over 20 stat() calls`)
}

// --------------------------------------------------------------------------
// the corpus hash on its own, and the two parts of a stat() call
console.log('')
console.log('the parts of a stat() call')
{
  const t0 = performance.now()
  await originalHash(undefined)
  const elapsed = performance.now() - t0
  console.log(`  historicalCorpusRevision(): ${ms(elapsed)}`)
  console.log(`    source: host lib/index.js:3127, enumerates and stats all ${totalSessions} generation logs`)
}
{
  const cheap = (byGeneration.get(4) ?? [])[0]
  if (cheap !== undefined) {
    const findLogTimes = []
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now()
      await svc.findLog(cheap.id)
      findLogTimes.push(performance.now() - t0)
    }
    const selected = await svc.findLog(cheap.id)
    const headerTimes = []
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now()
      await svc.readGenerationHeader(selected, cheap.id, undefined)
      headerTimes.push(performance.now() - t0)
    }
    console.log(`  findLog(): ${ms(median(findLogTimes))} median of 20 calls`)
    console.log(`    source: host lib/index.js:3473, walks ${projectDirs.length} project dirs`)
    console.log(`  readGenerationHeader(): ${ms(median(headerTimes))} median of 20 calls`)
    console.log('    source: host lib/index.js:3172, one zstd frame plus JSON.parse')
  }
}
await ctx.fiber.dispose()

// --------------------------------------------------------------------------
// the proof: hold the project directory count at one and grow the number of
// logs in the store. A stat() on a generation 0 id has to hash the whole
// store, so its cost has to grow with the log count, while a stat() on an
// unknown id has to stay flat.
console.log('')
console.log('cost of stat() against the number of logs in the store')
console.log('  source: synthetic stores under the system temp dir, one project dir each, real generation 0 logs copied in')
const source = byGeneration.get(0) ?? []
if (source.length === 0) {
  console.log('  skipped: the store holds no generation 0 session')
} else {
  // one project directory that holds the most generation 0 sessions, so the
  // synthetic store can grow its log count without growing its project count
  const perProject = new Map()
  for (const entry of source) {
    if (!perProject.has(entry.project)) perProject.set(entry.project, [])
    perProject.get(entry.project).push(entry)
  }
  const sameProject = [...perProject.values()].sort((a, b) => b.length - a.length)[0]
  const project = sameProject[0].project
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-stat-versioned-'))
  try {
    for (const size of [5, 25, 50, 100, 200, 400].filter((n) => n <= sameProject.length)) {
      const root = join(scratch, `store-${size}`)
      await mkdir(join(root, project), { recursive: true })
      for (const entry of sameProject.slice(0, size)) {
        await mkdir(join(root, project, entry.id), { recursive: true })
        await copyFile(join(entry.path, 'session.jsonl.zstd'), join(root, project, entry.id, 'session.jsonl.zstd'))
      }
      const { ctx: scaleCtx, svc: scaleSvc } = await openBackend(root)
      const warm = await scaleSvc.stat(sameProject[0].id)
      await scaleCtx.fiber.dispose()
      if (warm === undefined) {
        console.log(`  logs ${String(size).padStart(3)}: skipped, the copied session did not resolve`)
        continue
      }
      const known = []
      const unknown = []
      for (let i = 0; i < 20; i += 1) {
        let t0 = performance.now()
        await scaleSvc.stat(sameProject[0].id)
        known.push(performance.now() - t0)
        t0 = performance.now()
        await scaleSvc.stat(randomUUID())
        unknown.push(performance.now() - t0)
      }
      await scaleCtx.fiber.dispose()
      console.log(
        `  logs ${String(size).padStart(3)}: stat(generation 0) median ${ms(median(known)).padStart(10)}   stat(unknown) median ${ms(median(unknown)).padStart(10)}   (20 calls per class)`,
      )
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
console.log('')
process.exit(0)
