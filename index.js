/**
 * dsh-av-preview — host half.
 *
 * Serves ONE prefix route, `/media`, that streams a video/audio file from disk
 * with HTTP Range support (206 Partial Content), so the side card's inline
 * `<video>` / `<audio>` can start before the whole file arrives and can be
 * scrubbed. It is the media half that `dsh-better-sidebar` does not ship: its
 * own `/sidebar/file` route answers every non-image as
 * `application/octet-stream`, never answers 206, and a `.mp4` opened with no
 * media viewer falls through its `code` catch-all to the "download to view"
 * pane.
 *
 * Security posture, in the order the checks run:
 *  1. `ctx.connection.requestRejection(req)` — the host's own admission
 *     (loopback/trusted Host + signed session cookie + not cross-site).
 *  2. GET / HEAD only.
 *  3. A MEDIA extension allowlist: this route serves media files, never a
 *     general-purpose local file read. Unknown extensions answer 415.
 *  4. Path controls: control characters are refused, and on Windows network
 *     (`\\host\share`) and device (`\\?\`, `\\.\`) namespaces are refused —
 *     a UNC target would make Windows authenticate to an arbitrary host.
 *  5. Resolution is plain, like the sidebar's own file route: a relative
 *     target joins the session working directory, `~` expands to home, and an
 *     ABSOLUTE target stays absolute even outside the workspace. Refusing
 *     those is the "black box with no explanation" bug this plugin exists to
 *     fix — with the allowlist above bounding what "inside or outside" can
 *     mean.
 */
import { closeSync, createReadStream, openSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

/** Plugin identity for cordis rows / client-module keying. */
export const name = 'dsh-av-preview'

/** Services required before mounting: route registry, session cwd, connection fence. */
export const inject = ['webServer', 'sessions', 'connection']

/** Content types by extension — also the allowlist of what this route serves. */
const MEDIA_TYPES = {
  // video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.m2ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  // audio
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
}

/** Wire error type (same JSON envelope as the sidebar's routes). */
class MediaError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Read one header value, `undefined` when absent or repeated. */
function header(headers, key) {
  const value = headers?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolve a request target against the session working directory.
 *
 * Mirrors `dsh-better-sidebar`'s `resolveTarget`: `~` names the home
 * directory, a relative target joins the cwd, an absolute target stays put,
 * and the result is lexically resolved (`..` collapsed). Path SHAPE is
 * policed here; which extensions may be served is policed by the route.
 */
export function resolveTarget(cwd, target) {
  if (typeof target !== 'string' || target === '') {
    throw new MediaError('bad-request', 'path is required')
  }
  const expanded = target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    ? resolve(homedir(), target.slice(1).replace(/^[\\/]/, ''))
    : target
  // NUL and friends cannot appear in a real path; they only exist in attempts
  // to confuse a downstream layer.
  if (/[\u0000-\u001f]/.test(expanded)) {
    throw new MediaError('bad-request', 'path contains control characters')
  }
  // `\\host\share`, `\\?\C:\…` and `\\.\…` are network/device namespaces, not
  // files: a UNC target would make Windows authenticate to an arbitrary host.
  if (process.platform === 'win32' && /^[\\/]{2}/.test(expanded)) {
    throw new MediaError('bad-request', 'network and device paths are not allowed')
  }
  return resolve(cwd, expanded)
}

/** The session's authoritative cwd: attached header first, then the caller hint. */
export function sessionCwdOf(ctx, sessionId, clientCwd) {
  const session = ctx.sessions?.get?.(sessionId)
  if (session === undefined) {
    // A made-up sessionId is not a directory request: without a real session
    // there is no "the workspace" for a relative target to mean anything.
    if (typeof clientCwd !== 'string' || clientCwd === '') {
      throw new MediaError('unknown-session', 'unknown session', 404)
    }
    return resolve(clientCwd)
  }
  const headerCwd = session.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  if (typeof clientCwd === 'string' && clientCwd !== '') return resolve(clientCwd)
  return process.cwd()
}

/**
 * Parse a single `Range: bytes=…` header against a known size.
 *
 * The grammar is strict (`bytes=` with decimal digits only): a client that
 * sends `bytes=+2-3` or `bytes=1e1-` gets the whole file, which the spec
 * allows for any Range a server does not honour.
 *
 * @returns `{ start, end }` (inclusive) for a satisfiable window, `null` when
 *  there is nothing to honour (absent, malformed, another unit, or a
 *  multi-range request), or `{ unsatisfiable: true }` when the window cannot
 *  be satisfied (caller answers 416 with `content-range: bytes *\/size`).
 */
export function parseRange(raw, size) {
  if (raw === undefined) return null
  const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/i.exec(raw.trim())
  if (match === null) return null
  const [, startText, endText, suffixText] = match
  if (size === 0) return { unsatisfiable: true }
  if (suffixText !== undefined) {
    const suffix = Number(suffixText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true }
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start)) return null
  const end = endText === undefined || endText === '' ? size - 1 : Number(endText)
  if (!Number.isSafeInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  if (start > end) return null
  return { start, end: Math.min(end, size - 1) }
}

/** Content type for one path (`application/octet-stream` when unclaimed). */
export function mediaTypeForPath(path) {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Whether this extension is one the route is willing to serve. */
export function isMediaPath(path) {
  return Object.hasOwn(MEDIA_TYPES, extname(path).toLowerCase())
}

function writeError(res, error) {
  const status = error instanceof MediaError ? error.status : 500
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = Buffer.from(JSON.stringify({
    ok: false,
    error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) },
  }))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
  res.end(body)
}

/** Stream one file window (or the whole file) into the response. */
function serveFile(req, res, path, size, type, etag) {
  const baseHeaders = {
    'content-type': type,
    'accept-ranges': 'bytes',
    // A preview must never be served from a stale cache: the file is often the
    // output the agent just wrote or is rewriting right now.
    'cache-control': 'no-store',
    etag,
  }
  // `If-Range` with a different validator means "the file changed, send it all".
  const ifRange = header(req.headers, 'if-range')
  const range = ifRange === undefined || ifRange === etag
    ? parseRange(header(req.headers, 'range'), size)
    : null

  if (size === 0) {
    // A zero-byte representation is 200 with an empty body; any Range on it is
    // unsatisfiable. (createReadStream would refuse start=0, end=-1.)
    if (range === null) {
      res.writeHead(200, { ...baseHeaders, 'content-length': '0' })
    } else {
      res.writeHead(416, { ...baseHeaders, 'content-range': 'bytes */0' })
    }
    res.end()
    return
  }

  if (range !== null && range.unsatisfiable === true) {
    res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  const start = range === null ? 0 : range.start
  const end = range === null ? size - 1 : range.end
  // Open BEFORE the status line commits. `stat` can see a file that cannot be
  // opened (held with an exclusive share on Windows, ACL changed, deleted in
  // between); failing here still produces the plugin's JSON envelope, while
  // failing after `writeHead` can only reset the socket.
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw new MediaError('fs-error', `cannot read file (${error?.code ?? 'error'})`, 500)
  }
  const headers = {
    ...baseHeaders,
    'content-length': String(end - start + 1),
  }
  if (range !== null) headers['content-range'] = `bytes ${start}-${end}/${size}`
  res.writeHead(range === null ? 200 : 206, headers)
  if (req.method === 'HEAD') {
    closeSync(fd)
    res.end()
    return
  }
  const expected = end - start + 1
  const stream = createReadStream(path, { fd, start, end })
  let sent = 0
  stream.on('data', (chunk) => { sent += chunk.length })
  stream.on('error', () => res.destroy())
  // The file shrank after the `stat` (an agent rewrote its own output): the
  // stream ends short of the promised length, and a keep-alive client would
  // wait for bytes that will never come. Drop the connection instead.
  stream.on('end', () => { if (sent !== expected) res.destroy() })
  // A client that walks away (scrub, tab close, seek) unbalances the pipe; the
  // descriptor would then wait for a GC that never runs on it.
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

/** Mount the `/media` route. */
export function apply(ctx) {
  // The connection service owns deployment trust and authentication; never
  // re-derive a trust list here (the removed `webRuntime` trap).
  const fence = (req) => ctx.connection.requestRejection(req) === undefined

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/media',
    handler: async (req, res) => {
      // The fence call sits INSIDE the try: a host admission check that throws
      // must still produce an answer, not an unanswered socket plus an
      // unhandled rejection (fatal under Node's default policy).
      try {
        if (!fence(req)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (sessionId === null || raw === null) {
          throw new MediaError('bad-request', 'sessionId and path are required')
        }
        const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const path = resolveTarget(cwd, raw)
        const type = MEDIA_TYPES[extname(path).toLowerCase()]
        if (type === undefined) {
          // This route is a media previewer, not a local file reader: the
          // allowlist is what keeps "any absolute path" from meaning "any file".
          throw new MediaError('unsupported-media', 'not a media file', 415)
        }
        const info = await stat(path).catch((error) => {
          // The message never carries the resolved path: a caller that only
          // sent `sessionId` + a relative name would otherwise learn the
          // workspace root from the error body.
          ctx.logger?.warn?.(`dsh-av-preview: ${path}: ${error?.code ?? error?.message}`)
          throw new MediaError('fs-error', `cannot read file (${error?.code ?? 'error'})`, 404)
        })
        if (!info.isFile()) throw new MediaError('fs-error', 'not a regular file', 400)
        const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
        serveFile(req, res, path, info.size, type, etag)
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-av-preview: /media range route')
}
