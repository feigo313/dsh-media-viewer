// One route, driven over a real node:http server — the properties under test
// are wire properties (status, headers, byte windows), not function returns.
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply, parseRange, resolveTarget, mediaTypeForPath } from '../index.js'

const roots = []
const servers = []

/** A temp workspace used as the session cwd. */
function workspace(label) {
  const root = mkdtempSync(join(tmpdir(), `media-${label}-`))
  roots.push(root)
  return root
}

/**
 * Mount the plugin against a stub cordis context and expose the route over a
 * real port. `reject` flips the connection fence to model a refused request.
 */
async function serve(cwd, options = {}) {
  const routes = []
  const ctx = {
    effect: (cb) => { const d = cb(); return typeof d === 'function' ? d : () => {} },
    connection: {
      requestRejection: () => {
        if (options.throwInFence === true) throw new Error('fence exploded')
        return options.reject === true ? { status: 403 } : undefined
      },
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    sessions: { get: () => (cwd === undefined ? undefined : { header: { cwd } }) },
  }
  apply(ctx)
  const route = routes.find((r) => r.path === '/media')
  const server = createServer((req, res) => {
    if (options.raw === true) {
      void route.handler(req, res)
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname === '/media') void route.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  servers.push(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, route }
}

/** The /media URL for one path/target. */
function mediaUrl(origin, target, extra = {}) {
  const params = new URLSearchParams({ sessionId: 's', path: target, ...extra })
  return `${origin}/media?${params.toString()}`
}

after(() => {
  for (const server of servers) server.closeAllConnections?.()
  for (const server of servers) server.close()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('resolveTarget', () => {
  // Paths are built with node:path so the assertions hold on both dialects.
  const cwdFor = () => join(tmpdir(), 'work', 'project')

  it('joins a relative target under the session cwd', () => {
    const cwd = cwdFor()
    assert.equal(resolveTarget(cwd, 'clip.mp4'), join(cwd, 'clip.mp4'))
    assert.equal(resolveTarget(cwd, join('sub', 'clip.mp4')), join(cwd, 'sub', 'clip.mp4'))
  })

  it('keeps an absolute target absolute — even outside the cwd', () => {
    // The sidebar's own file route carries no containment policy; refusing
    // these files is the black-screen bug this project exists to fix.
    const outside = join(tmpdir(), 'other', 'clip.mp4')
    assert.equal(resolveTarget(cwdFor(), outside), outside)
  })

  it('collapses .. lexically and refuses an empty target', () => {
    const cwd = cwdFor()
    const resolved = resolveTarget(cwd, join('..', 'sibling', 'clip.mp4'))
    assert.equal(resolved, join(resolve(cwd, '..'), 'sibling', 'clip.mp4'))
    assert.ok(!resolved.includes('..'), resolved)
    assert.throws(() => resolveTarget(cwd, ''), /path is required/)
  })
})

describe('parseRange', () => {
  it('parses the single-range spellings a browser sends', () => {
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 })
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 })
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
    assert.deepEqual(parseRange('bytes=90-999', 100), { start: 90, end: 99 })
  })

  it('separates "no range" from "past EOF"', () => {
    assert.equal(parseRange(undefined, 100), null)
    assert.equal(parseRange('items=0-1', 100), null)
    assert.equal(parseRange('bytes=0-1,4-5', 100), null)
    assert.equal(parseRange('bytes=9-2', 100), null)
    assert.deepEqual(parseRange('bytes=100-', 100), { unsatisfiable: true })
    assert.deepEqual(parseRange('bytes=-0', 100), { unsatisfiable: true })
    assert.deepEqual(parseRange('bytes=0-', 0), { unsatisfiable: true })
  })
})

describe('mediaTypeForPath', () => {
  it('names both container families', () => {
    assert.equal(mediaTypeForPath('/w/clip.MP4'), 'video/mp4')
    assert.equal(mediaTypeForPath('/w/clip.mkv'), 'video/x-matroska')
    assert.equal(mediaTypeForPath('/w/voice.mp3'), 'audio/mpeg')
    assert.equal(mediaTypeForPath('/w/voice.flac'), 'audio/flac')
    assert.equal(mediaTypeForPath('/w/notes.txt'), 'application/octet-stream')
  })
})

describe('/media route', () => {
  it('streams the whole file with accept-ranges', async () => {
    const cwd = workspace('full')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('content-length'), '10')
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('content-range'), null)
    assert.equal(await response.text(), '0123456789')
  })

  it('answers 206 with exactly the requested window', async () => {
    const cwd = workspace('range')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), { headers: { range: 'bytes=2-5' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(response.headers.get('content-length'), '4')
    assert.equal(await response.text(), '2345')
  })

  it('counts a suffix range back from EOF', async () => {
    const cwd = workspace('suffix')
    writeFileSync(join(cwd, 'clip.webm'), '0123456789')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, 'clip.webm', { cwd }), { headers: { range: 'bytes=-3' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 7-9/10')
    assert.equal(await response.text(), '789')
  })

  it('answers 416 when the window starts past EOF', async () => {
    const cwd = workspace('416')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), { headers: { range: 'bytes=20-' } })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), 'bytes */10')
    assert.equal(await response.text(), '')
  })

  it('serves HEAD without a body', async () => {
    const cwd = workspace('head')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), '10')
    assert.equal(await response.text(), '')
  })

  it('resolves a relative target against the session cwd (the chat-card path)', async () => {
    const cwd = workspace('relative')
    writeFileSync(join(cwd, 'talk.mp3'), 'abcdefghij')
    const { origin } = await serve(cwd)

    // No client-side cwd hint: the session record must supply it.
    const response = await fetch(mediaUrl(origin, 'talk.mp3'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'audio/mpeg')
    assert.equal(await response.text(), 'abcdefghij')
  })

  it('serves an absolute path outside the session cwd (used to be a 403 black screen)', async () => {
    const cwd = workspace('inside')
    const outside = workspace('outside')
    const target = join(outside, 'deliver.mp4')
    writeFileSync(target, 'zyxwvu')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, target, { cwd }))
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'zyxwvu')
  })

  it('answers a JSON envelope for a missing file and a directory', async () => {
    const cwd = workspace('errors')
    mkdirSync(join(cwd, 'folder.mp4'))
    const { origin } = await serve(cwd)

    const missing = await fetch(mediaUrl(origin, 'nope.mp4', { cwd }))
    assert.equal(missing.status, 404)
    const missingBody = await missing.json()
    assert.equal(missingBody.error.code, 'fs-error')
    // The body must not echo the resolved path: a caller that only sent a
    // relative name would otherwise learn the workspace root.
    assert.ok(!JSON.stringify(missingBody).includes(cwd), JSON.stringify(missingBody))

    const directory = await fetch(mediaUrl(origin, 'folder.mp4', { cwd }))
    assert.equal(directory.status, 400)
    assert.match((await directory.json()).error.message, /not a regular file/)
  })

  it('serves an empty media file as a zero-length 200 (416 for a Range)', async () => {
    const cwd = workspace('empty')
    writeFileSync(join(cwd, 'empty.mp4'), '')
    const { origin } = await serve(cwd)

    const whole = await fetch(mediaUrl(origin, 'empty.mp4', { cwd }))
    assert.equal(whole.status, 200)
    assert.equal(whole.headers.get('content-length'), '0')
    assert.equal(await whole.text(), '')

    const ranged = await fetch(mediaUrl(origin, 'empty.mp4', { cwd }), { headers: { range: 'bytes=0-' } })
    assert.equal(ranged.status, 416)
    assert.equal(ranged.headers.get('content-range'), 'bytes */0')
  })

  it('refuses a non-media extension with 415 (this is not a local file reader)', async () => {
    const cwd = workspace('allowlist')
    writeFileSync(join(cwd, 'id_rsa.txt'), 'PRIVATE')
    writeFileSync(join(cwd, 'notes.md'), '# hi')
    const { origin } = await serve(cwd)

    for (const target of ['id_rsa.txt', 'notes.md']) {
      const response = await fetch(mediaUrl(origin, target, { cwd }))
      assert.equal(response.status, 415, target)
      assert.equal((await response.json()).error.code, 'unsupported-media')
    }
    // An NTFS alternate data stream keeps the extension unparseable → 415.
    writeFileSync(join(cwd, 'clip.mp4'), 'media-bytes')
    const ads = await fetch(mediaUrl(origin, 'clip.mp4:hidden', { cwd }))
    assert.equal(ads.status, 415)
  })

  it('publishes an ETag and honours If-Range', async () => {
    const cwd = workspace('etag')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    const first = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }))
    const etag = first.headers.get('etag')
    assert.ok(etag, 'no ETag')
    // If-Range requires a STRONG validator (RFC 9110 §13.1.5) — no W/ prefix.
    assert.match(etag, /^"/)

    const matching = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), {
      headers: { range: 'bytes=2-5', 'if-range': etag },
    })
    assert.equal(matching.status, 206)

    // A stale validator means "the file changed, send it all".
    const stale = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), {
      headers: { range: 'bytes=2-5', 'if-range': 'W/"stale"' },
    })
    assert.equal(stale.status, 200)
    assert.equal(await stale.text(), '0123456789')
  })

  it('ignores Range spellings the grammar does not cover', async () => {
    const cwd = workspace('strict-range')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    for (const range of ['bytes=+2-3', 'bytes=0x2-3', 'bytes=1e1-']) {
      const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), { headers: { range } })
      assert.equal(response.status, 200, range)
    }
    // `bytes=-0` names no bytes: unsatisfiable, not "the whole file".
    const zero = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), { headers: { range: 'bytes=-0' } })
    assert.equal(zero.status, 416)
  })

  it('refuses a Windows network/device namespace path', { skip: process.platform !== 'win32' ? 'win32-only path shape' : false }, async () => {
    const cwd = workspace('unc')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    for (const target of ['\\\\?\\C:\\Windows\\win.ini', '\\\\.\\C:\\Windows\\win.ini', '\\\\127.0.0.1\\c$\\Windows\\win.ini']) {
      const response = await fetch(mediaUrl(origin, target, { cwd }))
      assert.equal(response.status, 400, target)
      assert.match((await response.json()).error.message, /network and device paths/)
    }
  })

  it('answers 404 when the session is unknown and no cwd hint was sent', async () => {
    const { origin } = await serve(undefined)
    const response = await fetch(mediaUrl(origin, 'clip.mp4'))
    assert.equal(response.status, 404)
    assert.equal((await response.json()).error.code, 'unknown-session')
  })

  it('refuses a request the connection fence rejects', async () => {
    const cwd = workspace('fence')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd, { reject: true })

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }))
    assert.equal(response.status, 403)
  })

  it('answers instead of hanging when the fence itself throws', async () => {
    const cwd = workspace('fence-throw')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    // A host admission check that throws must not leave the socket unanswered
    // (that path is also an unhandled rejection, fatal under Node defaults).
    const { origin } = await serve(cwd, { throwInFence: true })

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }))
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error.code, 'internal')
  })

  it('rejects a non-GET/HEAD method with an Allow header', async () => {
    const cwd = workspace('method')
    writeFileSync(join(cwd, 'clip.mp4'), '0123456789')
    const { origin } = await serve(cwd)

    const response = await fetch(mediaUrl(origin, 'clip.mp4', { cwd }), { method: 'POST' })
    assert.equal(response.status, 405)
    // RFC 9110 §15.5.6: a 405 MUST carry the methods it does allow.
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
  })

  it('still answers the JSON envelope when the file cannot be opened', { skip: process.platform === 'win32' ? 'chmod does not deny reads on Windows' : false }, async () => {
    const cwd = workspace('unreadable')
    const target = join(cwd, 'locked.mp4')
    writeFileSync(target, '0123456789')
    // stat() still sees the file; open() is what fails. The envelope has to
    // come from before the status line commits, or the client gets a reset
    // socket and the player shows nothing.
    chmodSync(target, 0o000)
    const { origin } = await serve(cwd)
    try {
      const response = await fetch(mediaUrl(origin, 'locked.mp4', { cwd }))
      assert.equal(response.status, 500)
      assert.equal((await response.json()).error.code, 'fs-error')
    } finally {
      chmodSync(target, 0o644)
    }
  })

  it('survives a client that walks away mid-stream', async () => {
    const cwd = workspace('abort')
    writeFileSync(join(cwd, 'big.mp4'), Buffer.alloc(2 * 1024 * 1024, 7))
    const { origin } = await serve(cwd)

    const controller = new AbortController()
    const response = await fetch(mediaUrl(origin, 'big.mp4', { cwd }), { signal: controller.signal })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    // The server must remain healthy (the descriptor behind the aborted stream
    // is released by the response's close handler).
    const again = await fetch(mediaUrl(origin, 'big.mp4', { cwd }), { headers: { range: 'bytes=0-3' } })
    assert.equal(again.status, 206)
    assert.equal(await again.text(), '\u0007\u0007\u0007\u0007')
  })
})
