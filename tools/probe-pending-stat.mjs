#!/usr/bin/env node
// Shows what stat(id) answers for a session that was created but never
// written, and when. Expected output shape: a table of orderings with the
// answer for each, one contrast row for the delete path, and the cost of a
// disk truth check on a real store.
//
// The host answers stat() from its in-memory tracker first
// (session-persistence-jsonl/lib/index.js:2597) and does not touch the disk
// for a tracked session. A created-but-unwritten session stays tracked until
// its write handle closes and it never materialized (:427 and :431), and the
// host closes that handle in its own dispose listener without awaiting it.
// The plugin's dispose listener asks after that, so the tracker still holds
// the entry and the answer is "present".
//
// Point it at another machine with two flags:
//   --host <path>   the deepseek-harness checkout   (default DEFAULT_HOST)
//   --root <path>   the jsonl session store root     (default DEFAULT_ROOT)
//
// This script only READS the session store. It never imports the readcache
// plugin, and DSH_HOME is deleted before any host module is imported, so the
// plugin's snapshot file (list-snapshot.db) is never opened, read or written.
// It never writes to the session store either. The throwaway store it builds
// for the pending session lives under the system temp dir and is removed
// when the run ends.
//
// The host work being measured lives in
// <host>/packages/session/session-persistence-jsonl/lib/index.js:
//   stat()          :2593   reads the tracker before the disk
//   release()       :427    drops the tracker entry on close
//   forgetSession() :2703   reached by delete() at :2685
//   findLog()       :3473   the walk a disk truth check would cost
import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

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

const show = (label, value) => {
  console.log(`  ${label.padEnd(46)} ${value === undefined ? 'undefined  (not tracked, no artifact)' : 'snapshot   (the host still names it)'}`)
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-pending-probe-'))
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root: scratch })
const svc = ctx.sessionPersistence

console.log('')
console.log('='.repeat(78))
console.log('what stat() answers for a session that was created but never written')
console.log('='.repeat(78))
console.log(`host checkout   : ${HOST}`)
console.log(`throwaway store : ${scratch}`)
console.log(`real store      : ${ROOT}`)
console.log('  source: host lib/index.js:2593 stat(), one call per row below')
console.log('')

const id = 'probe-pending-session-1'
const handle = await svc.create({ version: 4, id, createdAt: 1, cwd: '/w', isSeeded: false, delegationDepth: 0 })

show('while the write handle is open', await svc.stat(id))

// the host's dispose listener starts the close and does not await it, then
// the plugin's dispose listener asks stat()
const closing = handle.close()
show('right after the close was started', await svc.stat(id))

await closing
show('after the close finished', await svc.stat(id))

// The same thing through the host's own event, with the plugin's listener
// registered after the backend's, which is the order the host runs them in:
// the backend registers its dispose listener when it loads, the plugin
// registers its own later, and the host calls them in registration order
// (packages/core/session/src/index.ts:403).
const secondId = 'probe-pending-session-2'
const secondHandle = await svc.create({ version: 4, id: secondId, createdAt: 2, cwd: '/w', isSeeded: false, delegationDepth: 0 })
let answered
ctx.on('session/disposed', () => {
  answered = svc.stat(secondId)
})
ctx.emit('session/disposed', { id: secondId })
console.log('')
console.log('  through the host event, the plugin listener registered after the backend one:')
show('what the plugin sees', await answered)
await secondHandle.close()

// The delete path, for contrast. The host's delete() calls forgetSession
// (lib/index.js:2685), which drops the tracker entry, and only then is the
// question worth asking again. That is the one path where the answer to
// stat() is undefined.
const thirdId = 'probe-pending-session-3'
const thirdHandle = await svc.create({ version: 4, id: thirdId, createdAt: 3, cwd: '/w', isSeeded: false, delegationDepth: 0 })
show('a third session, still tracked', await svc.stat(thirdId))
svc.forgetSession(thirdId)
show('the same session after forgetSession', await svc.stat(thirdId))
await thirdHandle.close()

console.log('')
console.log('  host source: lib/index.js:2597 reads the tracker before the disk,')
console.log('               lib/index.js:427 and :431 drop the tracker entry on close when nothing was written,')
console.log('               lib/index.js:2703 forgetSession(), reached by delete() at :2685')
console.log('')

// What a host side disk truth check would cost: the walk that findLog() does
// when the tracker is not consulted, measured on the real store.
{
  const realCtx = new Context()
  await realCtx.plugin(JsonlSessionPersistence, { root: ROOT })
  const realSvc = realCtx.sessionPersistence
  const times = []
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now()
    await realSvc.findLog(`0199ffff-0000-7000-8000-${String(i).padStart(12, '0')}`)
    times.push(performance.now() - t0)
  }
  const sorted = [...times].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  console.log('  cost of a disk truth check on the real store (findLog, the tracker not consulted):')
  console.log(`    min ${sorted[0].toFixed(3)} ms   median ${sorted[mid].toFixed(3)} ms   max ${sorted[sorted.length - 1].toFixed(3)} ms   n=20`)
  console.log('    source: host lib/index.js:3473 findLog(), 20 calls, ids that are not on disk')
  await realCtx.fiber.dispose()
}
console.log('')
await ctx.fiber.dispose()
await rm(scratch, { recursive: true, force: true })
process.exit(0)
