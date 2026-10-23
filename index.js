/**
 * dsh-av-preview — host half.
 *
 * Serves ONE prefix route, `/media`, that streams a video/audio file from disk
 * with HTTP Range support (206 Partial Content), so the side card's inline
 * `<video>` / `<audio>` can start before the whole file arrives and can be
 * scrubbed. It is the media half of what `dsh-better-sidebar` does not ship:
 * that plugin's own `/sidebar/file` route answers every non-image as
 * `application/octet-stream` and never answers 206, and a `.mp4` opened with
 * no media viewer falls through its `code` catch-all to the "download to view"
 * pane.
 *
 * Path semantics deliberately match the sidebar's own routes:
 *  - a relative target resolves under the session working directory;
 *  - `~` expands to the user's home directory;
 *  - an absolute target stays absolute — including one OUTSIDE the session
 *    working directory, because the sidebar's own file route carries no
 *    containment policy either (its `ensureWorkspacePath` is plain
 *    resolution). A preview route that refuses those files is the bug this
 *    fork started from: the player shows a black box with no explanation.
 *  - the request itself must pass the host's connection fence
 *    (`ctx.connection.requestRejection`), exactly like the `/api` gateway.
 */
import { closeSync, createReadStream, openSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

/** Plugin identity for cordis rows / client-module keying. */
export const name = 'dsh-av-preview'

/** Services required before mounting: route registry, session cwd, connection fence. */
export const inject = ['webServer', 'sessions', 'connection']

/** Content types by extension. Both container families share one route: the
 *  element picks the transport, the header only names the container. */
const MEDIA_TYPES = {
  // video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
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
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
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
 * and the result is lexically resolved (`..` collapsed, no symlink dance).
 * No containment check — see the module note.
 */
export function resolveTarget(cwd, target) {
  if (typeof target !== 'string' || target === '') {
    throw new MediaError('bad-request', 'path is required')
  }
  const expanded = target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    ? resolve(homedir(), target.slice(1).replace(/^[\\/]/, ''))
    : target
  return resolve(cwd, expanded)
}

/** The session's authoritative cwd: attached header first, then the caller hint. */
export function sessionCwdOf(ctx, sessionId, clientCwd) {
  const session = ctx.sessions?.get?.(sessionId)
  const headerCwd = session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  if (typeof clientCwd === 'string' && clientCwd !== '') return resolve(clientCwd)
  return process.cwd()
}

/**
 * Parse a single `Range: bytes=...` header against a known size.
 *
 * @returns `{ start, end }` (inclusive) for a satisfiable window, `null` when
 *  there is nothing to honour (absent, malformed, another unit, or a
 *  multi-range request — the whole file is a legal answer to any of those), or
 *  `{ unsatisfiable: true }` when the window starts past EOF (caller answers
 *  416 with `content-range: bytes *\/size`).
 */
export function parseRange(raw, size) {
  if (raw === undefined) return null
  const match = /^bytes=(.*)$/i.exec(raw.trim())
  if (match === null) return null
  // Multi-range would need a multipart body; browsers never send it for media,
  // and answering with the whole file is explicitly allowed.
  if (match[1].includes(',')) return null
  const spec = match[1].trim()
  if (spec === '') return null
  if (size === 0) return { unsatisfiable: true }
  if (spec.startsWith('-')) {
    const suffix = Number(spec.slice(1))
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isSafeInteger(start) || start < 0) return null
  if (!Number.isSafeInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  if (start > end) return null
  return { start, end: Math.min(end, size - 1) }
}

/** Content type for one path (octet-stream when the extension is unknown). */
export function mediaTypeForPath(path) {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
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
function serveFile(req, res, path, size, type) {
  const baseHeaders = {
    'content-type': type,
    'accept-ranges': 'bytes',
    // A preview must never be served from a stale cache: the file is often the
    // output the agent just wrote.
    'cache-control': 'no-store',
  }
  const range = parseRange(header(req.headers, 'range'), size)
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
  // failing after `writeHead` can only reset the socket — the client sees
  // ECONNRESET and the pane has nothing to show.
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw new MediaError('fs-error', `cannot read "${path}": ${error?.code ?? error?.message ?? 'error'}`, 500)
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
  const stream = createReadStream(path, { fd, start, end })
  stream.on('error', () => res.destroy())
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
        const info = await stat(path).catch((error) => {
          throw new MediaError('fs-error', `cannot read "${path}": ${error?.code ?? error?.message ?? 'error'}`, 404)
        })
        if (!info.isFile()) throw new MediaError('fs-error', `"${path}" is not a file`, 400)
        if (info.size === 0) throw new MediaError('fs-error', `"${path}" is empty`, 400)
        serveFile(req, res, path, info.size, mediaTypeForPath(path))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-av-preview: /media range route')
}
