// The client half, loaded exactly the way the host serves it: a lazy-CJS
// factory registered through `window.__ModuleLoader__.load`. `react` is
// stubbed with the two members the bundle uses (createElement + useState), so
// the test needs no dependency and no DOM.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(here, '..', 'client.js')

const stubReact = {
  createElement(type, props, children) {
    const merged = { ...(props ?? {}) }
    if (children !== undefined) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
}

function loadClient() {
  let descriptor
  globalThis.window = { __ModuleLoader__: { load: (mod) => { descriptor = mod } } }
  globalThis.self = globalThis.window
  // eslint-disable-next-line no-new-func
  new Function('window', 'self', readFileSync(BUNDLE, 'utf8'))(globalThis.window, globalThis.self)
  assert.equal(descriptor?.id, 'dsh-av-preview', 'bundle must register under the package name')
  return descriptor.factory(() => stubReact)
}

/** Collect a rendered tree's descendants. */
function flatten(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object') {
    out.push(node)
    flatten(node.props?.children, out)
  }
  return out
}

describe('client bundle', () => {
  it('exports the cordis inject list and apply', () => {
    const mod = loadClient()
    assert.deepEqual(mod.inject, ['betterSidebar'])
    assert.equal(typeof mod.apply, 'function')
  })

  it('registers exactly one viewer, under a non-clashing id', () => {
    const mod = loadClient()
    const registered = []
    mod.apply({
      effect: (cb) => { cb() },
      betterSidebar: { registerFileViewer: (d) => { registered.push(d); return () => {} } },
    })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].id, 'media')
    assert.equal(registered[0].fetchStrategy, 'none')
    assert.equal(typeof registered[0].component, 'function')
  })

  it('claims both container families', () => {
    const mod = loadClient()
    const [viewer] = capture(mod)
    for (const ext of ['mp4', 'webm', 'mov', 'mkv', 'mp3', 'flac', 'opus']) {
      assert.ok(viewer.exts.includes(ext), `missing ${ext}`)
    }
    assert.ok(!viewer.exts.includes('txt'))
  })

  it('renders a <video> on the /media route for a video file', () => {
    const [viewer] = capture(loadClient())
    const tree = viewer.component({ scope: { sessionId: 's', cwd: '/work' }, path: '/work/clip.mp4' })
    const video = flatten(tree).find((n) => n.type === 'video')
    assert.ok(video, 'no <video> in the tree')
    assert.equal(video.props.controls, true)
    assert.equal(video.props.preload, 'metadata')
    assert.match(String(video.props.src), /^\/media\?/)
    assert.match(String(video.props.src), /path=%2Fwork%2Fclip\.mp4/)
    // A token, not a literal: a skin restyles the letterbox with the panel.
    assert.match(String(video.props.style.background), /var\(--dsw-/)
  })

  it('renders an <audio> for an audio file', () => {
    const [viewer] = capture(loadClient())
    const tree = viewer.component({ scope: { sessionId: 's', cwd: '/work' }, path: '/work/voice.mp3' })
    assert.ok(flatten(tree).some((n) => n.type === 'audio'))
    assert.ok(!flatten(tree).some((n) => n.type === 'video'))
  })

  it('keeps the sidebar download link in the pane', () => {
    const [viewer] = capture(loadClient())
    const tree = viewer.component({ scope: { sessionId: 's', cwd: '/work' }, path: '/work/clip.mp4' })
    const link = flatten(tree).find((n) => n.type === 'a')
    assert.ok(link, 'no download link')
    assert.match(String(link.props.href), /^\/sidebar\/file\?/)
    assert.match(String(link.props.href), /download=1/)
  })

  it('carries a visible failure notice instead of a silent black box', () => {
    const [viewer] = capture(loadClient())
    // onError flips the component's own state; the notice text is part of the
    // bundle, so assert it is shipped rather than driving a re-render here.
    const source = readFileSync(BUNDLE, 'utf8')
    assert.match(source, /无法播放这个文件/)
    assert.equal(typeof viewer.component, 'function')
  })
})

function capture(mod) {
  const registered = []
  mod.apply({
    effect: (cb) => { cb() },
    betterSidebar: { registerFileViewer: (d) => { registered.push(d); return () => {} } },
  })
  return registered
}
