/**
 * dsh-media-viewer — host half.
 *
 * Deliberately empty. The whole feature lives in the CLIENT half: it registers
 * a file viewer with the sidebar through `ctx.betterSidebar.registerFileViewer`
 * and plays whatever `/sidebar/file` returns. No route, no session lookup, no
 * `webRuntime` — so a sidebar or host upgrade cannot strand this package.
 */
export const name = 'dsh-media-viewer'

/** No host services needed: the plugin only talks to the browser. */
export const inject = []

export function apply() {}
