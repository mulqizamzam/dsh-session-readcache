// Live impact measurement against the running host: drives session.history
// over the real RPC path for a small fixed set of cold sessions and reads
// the plugin's own counters before/after each pass.
const BASE = 'http://127.0.0.1:13080'
let n = 0
async function rpc(method, payload = {}) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `m-${Date.now()}-${n++}`, method, payload }),
  })
  const body = await res.json()
  if (!body.result?.ok) throw new Error(`${method}: ${body.result?.error?.message ?? JSON.stringify(body).slice(0, 300)}`)
  return body.result.value
}
async function metrics() {
  const res = await fetch(`${BASE}/plugin/session-readcache/metrics`)
  if (res.status !== 200) throw new Error(`metrics HTTP ${res.status}`)
  return res.json()
}
const t = (label, v) => console.log(`${label.padEnd(36)} ${v}`)

// Small fixed sample: 3 known large + 3 known small logs (mixed size).
const SAMPLE = [
  'session-5c686e94-bfbc-4aaa-a864-9e9f6e1bfd06', // 7.8 MB
  'session-75c564f9-3730-401f-852a-822ffe536101', // 7.5 MB
  'session-adbd6b66-e17c-4e42-9032-7fea2d72ba0b', // 6.6 MB
  'session-10d0e7bb-3779-46a4-aa01-cf8ee39aebb4', // small
  'ecf49168-8cc1-43fe-b185-5c610b455aa0',         // small
  'cda2696e-f57f-49e3-82a4-19d6df72af93',          // small
]

const before = await metrics()
t('inspect.misses before', before.inspect.misses)
t('inspect.hits before', before.inspect.hits)
t('cache.entries before', before.cache.entries)

// Warm pass.
const t0 = performance.now()
for (const id of SAMPLE) await rpc('session.history', { sessionId: id })
const warmMs = performance.now() - t0
const mid = await metrics()
t('inspect.misses after warm', mid.inspect.misses)
t('inspect.hits after warm', mid.inspect.hits)
t('cache.entries after warm', mid.cache.entries)
t(`warm pass wall time (ms)`, warmMs.toFixed(0))

// Hot pass.
const t1 = performance.now()
for (const id of SAMPLE) await rpc('session.history', { sessionId: id })
const hotMs = performance.now() - t1
const after = await metrics()
t('inspect.misses after hot', after.inspect.misses)
t('inspect.hits after hot', after.inspect.hits)
t(`hot pass wall time (ms)`, hotMs.toFixed(0))

console.log('\n--- full metrics dump ---')
console.log(JSON.stringify({ before, mid, after, warmMs: warmMs.toFixed(0), hotMs: hotMs.toFixed(0), sample: SAMPLE.length }, null, 2))
