#!/usr/bin/env node
/** Offline check: the bundle registers one viewer and renders the right element. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
const ok = (label, cond, detail = '') => {
  if (!cond) failures.push(label)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`)
}

const stubReact = {
  createElement(type, props, children) {
    const merged = { ...(props ?? {}) }
    if (children !== undefined) merged.children = children
    return { type, props: merged }
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
}

let descriptor
globalThis.window = { __ModuleLoader__: { load: (m) => { descriptor = m } } }
globalThis.self = globalThis.window
new Function('window', readFileSync(join(HERE, 'client.js'), 'utf8'))(globalThis.window)
ok('bundle registers as dsh-media-viewer', descriptor?.id === 'dsh-media-viewer', String(descriptor?.id))

const mod = descriptor.factory(() => stubReact)
ok('exports inject + apply', Array.isArray(mod.inject) && typeof mod.apply === 'function')

const registered = []
mod.apply({ effect: (cb) => cb(), betterSidebar: { registerFileViewer: (d) => { registered.push(d); return () => {} } } })
const v = registered[0]
ok('registers exactly one viewer', registered.length === 1, String(registered.length))
ok('viewer id', v?.id === 'dsh-media-viewer:media', String(v?.id))
ok('priority 50 (outranks the patch viewer)', v?.priority === 50, String(v?.priority))
ok('mediaUrl strategy', v?.fetchStrategy === 'mediaUrl', String(v?.fetchStrategy))
for (const ext of ['mp4', 'webm', 'mov', 'mkv', 'mp3', 'flac', 'wav']) {
  ok(`claims ${ext}`, v?.exts?.includes(ext))
}

function flatten(node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'object') { out.push(node); flatten(node.props?.children, out) }
  return out
}

const mediaUrl = '/sidebar/file?sessionId=s&path=%2Fw%2Fclip.mp4'
const video = v.component({ scope: { sessionId: 's', cwd: '/w' }, path: '/w/clip.mp4', mediaUrl })
const videoEl = flatten(video).find((n) => n.type === 'video')
ok('renders <video> for mp4', Boolean(videoEl))
ok('video has controls', videoEl?.props?.controls === true)
const link = flatten(video).find((n) => n.type === 'a')
ok('download link derives from mediaUrl', String(link?.props?.href) === mediaUrl + '&download=1', String(link?.props?.href))

const audioTree = v.component({ scope: { sessionId: 's', cwd: '/w' }, path: '/w/voice.mp3', mediaUrl: '/sidebar/file?x=1' })
ok('renders <audio> for mp3', flatten(audioTree).some((n) => n.type === 'audio'))
ok('no <video> for mp3', !flatten(audioTree).some((n) => n.type === 'video'))

const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
ok('exports["./client"] resolves', pkg.exports?.['./client'] !== undefined && readFileSync(join(HERE, 'client.js')).length > 0)
ok('bundle patch names the package', readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8').includes(`'${pkg.name}'`))

console.log(`\n${failures.length === 0 ? 'OK' : 'FAILED'} — ${failures.length === 0 ? 'bundle verified' : failures.join('; ')}`)
process.exit(failures.length === 0 ? 0 : 1)
