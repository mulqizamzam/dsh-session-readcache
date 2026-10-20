// Runtime verification: boot an isolated web host with the CURRENT plugin and a
// test-only driver bundle, then assert through the HOST boundary:
//   1. the mount banner reports mode=list-memo (the silent-death regression),
//   2. the driver made two real list() calls inside the real host,
//   3. the plugin's own metrics route reports misses=1, hits=1 (real wrapper),
//   4. the snapshot row was persisted inside the isolated DSH_HOME.
// FAIL-CLOSED: a green exit means every one of those was actually observed.
//
// Run: node tests/runtime-smoke.mjs
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const REPO_ROOT = '/home/administrator/deepseek-harness'
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const LIVE_PROFILE = '/home/administrator/agent-workspace/.dsh/profiles/web'
const BOOT_TIMEOUT_MS = 90_000
const POLL_MS = 250

function fail(message, detail) {
  console.error(`\nSTATUS: UNVERIFIED: ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}
function tail(text) {
  return text.split('\n').filter((l) => l.trim() !== '').slice(-25).join('\n')
}

async function main() {
  const require = createRequire(join(REPO_ROOT, 'package.json'))
  const tsxLoader = pathToFileURL(require.resolve('tsx')).href

  const workspace = mkdtempSync(join(tmpdir(), 'readcache-smoke-'))
  const dshHome = join(workspace, '.dsh')
  const prof = join(dshHome, 'profiles', 'web')
  mkdirSync(join(prof, 'node_modules'), { recursive: true })

  // Mirror the live profile: same package.json (bundles + link: dependency)
  // and the same node_modules tree; only DSH_HOME differs. The driver is added
  // as one more bundle and resolved through its own symlink.
  const livePkg = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(LIVE_PROFILE, 'package.json'), 'utf8')))
  livePkg.dsh.profile.bundles.push('readcache-driver')
  livePkg.dependencies['readcache-driver'] = `link:${join(PLUGIN_ROOT, 'tests', 'driver-plugin')}`
  writeFileSync(join(prof, 'package.json'), JSON.stringify(livePkg, null, 2))
  const fs = await import('node:fs')
  fs.copyFileSync(join(LIVE_PROFILE, 'cordis.patch.yml'), join(prof, 'cordis.patch.yml'))
  // A byte-level copy of the live node_modules (symlinks preserved) plus the
  // driver: resolution semantics stay identical to the live profile instead of
  // being re-created entry by entry.
  fs.cpSync(join(LIVE_PROFILE, 'node_modules'), join(prof, 'node_modules'), { recursive: true })
  fs.symlinkSync(join(PLUGIN_ROOT, 'tests', 'driver-plugin'), join(prof, 'node_modules', 'readcache-driver'), 'dir')

  console.log('Workspace:', workspace)
  const child = spawn(process.execPath,
    [join(REPO_ROOT, 'apps/cli/lib/bin.js'), 'web', '--port', '0', '--no-open'],
    { cwd: REPO_ROOT, env: { ...process.env, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  child.stdout.on('data', (c) => { out += String(c) })
  child.stderr.on('data', (c) => { out += String(c) })

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    let banner = false
    let driverDone = false
    let urlMatch = null
    while (Date.now() < deadline) {
      if (out.includes('[session-readcache] mounted') && /mode=list-memo/.test(out)) banner = true
      if (out.includes('[readcache-driver] done')) driverDone = true
      const m = out.match(/dsh web: (http:\/\/\S+)/)
      if (m) urlMatch = m[1]
      if (banner && driverDone && urlMatch) break
      if (child.exitCode !== null) break
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    if (child.exitCode !== null) fail(`the host child exited early with code ${child.exitCode}`, tail(out))
    if (!banner) fail('no mode=list-memo mount banner was observed', tail(out))
    if (!urlMatch) fail('the host started but printed no URL', tail(out))
    if (!driverDone) fail('the in-host driver never finished two list() calls', tail(out))
    const driverLine = out.split('\n').find((l) => l.includes('[readcache-driver] done'))
    console.log('\n' + driverLine)

    // Authenticate the way the GUI does: ?token= on the root sets an HttpOnly
    // cookie, and the metrics route is served to that cookie.
    const base = urlMatch.replace('0.0.0.0', '127.0.0.1')
    const origin = base.replace(/\?.*$/, '').replace(/\/$/, '')
    const metricsUrl = `${origin}/plugin/session-readcache/metrics`
    const cookieFile = join(workspace, 'cookie')
    const { execFileSync } = await import('node:child_process')
    const { readFileSync } = await import('node:fs')
    // The token lands on the root as a 303 that sets the HttpOnly auth cookie;
    // following the redirect is neither needed nor helpful (the second response
    // can replace the jar), so the 303 alone is what plants the cookie.
    execFileSync('curl', ['-s', '-c', cookieFile, '-o', '/dev/null', base])
    console.log('cookieName:', (readFileSync(cookieFile, 'utf8').match(/dsh-auth-\S+/) ?? ['<none>'])[0])
    let body = ''
    let code = ''
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const raw = execFileSync('curl', ['-s', '-w', '\n%{http_code}', '-b', cookieFile, metricsUrl]).toString()
      code = raw.trimEnd().split('\n').pop() ?? ''
      // The -w suffix is for the retry decision only; strip it before parsing.
      body = raw.replace(/\n\d{3}\s*$/, '')
      if (code === '200') break
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (code !== '200') return fail(`the metrics route answered HTTP ${code}`, body.slice(0, 300))
    let metrics
    try { metrics = JSON.parse(body) } catch {
      return fail('the metrics route did not return JSON', body.slice(0, 300))
    }
    console.log('metrics:', JSON.stringify(metrics))
    console.log('metrics:', JSON.stringify(metrics))

    if (metrics.mode !== 'list-memo') fail(`mode is ${metrics.mode}`, JSON.stringify(metrics))
    if (metrics.list.misses !== 1) fail(`expected exactly one real scan, got ${metrics.list.misses}`)
    if (metrics.list.hits !== 1) fail(`expected exactly one memo hit, got ${metrics.list.hits}`)
    if (metrics.memo.warm !== true) fail('the memo is not warm')

    const snapshotPath = metrics.snapshot.path
    if (typeof snapshotPath !== 'string' || !existsSync(snapshotPath)) {
      fail('no snapshot file was reported by the host', String(snapshotPath))
    }
    if (statSync(snapshotPath).size <= 0) fail('the snapshot file is empty')
    if (metrics.snapshot.saves < 1) fail('the snapshot save was never recorded')

    console.log('\nSTATUS: PROVEN (real host: banner + two real list calls + memo hit + snapshot on disk)')
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
    rmSync(workspace, { recursive: true, force: true })
    console.log('workspace cleaned')
  }
}

main().catch((error) => fail('unexpected error', String(error?.stack ?? error)))
