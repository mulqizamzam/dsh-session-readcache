// Test-only driver for tests/runtime-smoke.mjs: inside a REAL booted host it
// waits until session-readcache has wrapped the persistence service, then
// calls list() twice. Two real calls through the real wrapper are what the
// smoke asserts on (misses=1, hits=1); without a client connection this is the
// only way to drive the real path. Never shipped: it lives in the smoke's
// isolated profile, not in the live web profile.
export const name = 'readcache-driver'
export const inject = ['sessionPersistence']
export const provide = []

export function apply(ctx) {
  process.stderr.write('[readcache-driver] apply entered\n')
  try {
    ctx.inject(['sessionPersistence'], async ({ sessionPersistence }) => {
      process.stderr.write('[readcache-driver] inject fired\n')
      const deadline = Date.now() + 30_000
      while (sessionPersistence.__readcacheApplied !== true && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (sessionPersistence.__readcacheApplied !== true) {
        process.stderr.write('[readcache-driver] timeout waiting for the wrapper\n')
        return
      }
      try {
        const first = await sessionPersistence.list()
        await new Promise((r) => setTimeout(r, 200))
        // The real host callers pass an options bag ({signal}), never a bare
        // signal (session-query listPersisted, ACP sessionList). Driving the
        // second call through that bag is what keeps the memo contract honest:
        // a live-signal caller must be SERVED, not made to rescan.
        const second = await sessionPersistence.list({ signal: new AbortController().signal })
        process.stderr.write(`[readcache-driver] done applied=true calls=2 first=${first.length} second=${second.length}\n`)
      } catch (error) {
        process.stderr.write(`[readcache-driver] list threw: ${error?.message ?? error}\n`)
      }
    })
  } catch (error) {
    process.stderr.write(`[readcache-driver] inject registration threw: ${error?.message ?? error}\n`)
  }
}
