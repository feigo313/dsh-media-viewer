// Manifest contract — the class of bug that nearly shipped.
//
// 0.1.0 declared `dsh.client` without an `exports["./client"]`, and the host's
// client-modules loader THROWS on exactly that combination (see
// @deepseek-ai/dsh-client-modules: `declares dsh.client but exports no
// "./client" bundle`). Nothing in the runtime tests could see it: the host
// half and the bundle were both fine, only the packaging was wrong. These
// assertions keep the packaging honest without booting DSH.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('package manifest', () => {
  it('declares a name, a semver version and a resolvable main', () => {
    assert.match(pkg.name, /^[a-z0-9][a-z0-9._-]*$/)
    assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    assert.ok(existsSync(join(ROOT, pkg.main ?? 'index.js')), 'main must exist')
    assert.equal(pkg.type, 'module', 'the host half is ESM')
  })

  it('declares dsh.client AND exports["./client"] — the host throws otherwise', () => {
    if (pkg.dsh?.client === undefined) return
    const client = pkg.exports?.['./client']
    assert.ok(client !== undefined, 'dsh.client without exports["./client"] breaks the loader')
    const rel = typeof client === 'string' ? client : client.default
    assert.equal(typeof rel, 'string', 'exports["./client"] must be a string or {default}')
    assert.ok(existsSync(join(ROOT, rel)), `exports["./client"] target missing: ${rel}`)
    // The host entry must stay exported too, or the server half stops resolving.
    assert.ok(pkg.exports?.['.'] !== undefined, 'exports["."] must keep the host entry')
  })

  it('keeps the bundle patch present and named after the package', () => {
    const declared = pkg.dsh?.bundle?.patch
    if (declared === undefined) return
    const patch = Array.isArray(declared) ? declared[0] : declared
    const file = join(ROOT, patch)
    assert.ok(existsSync(file), `bundle patch missing: ${patch}`)
    const text = readFileSync(file, 'utf8')
    assert.match(text, new RegExp(`name:\\s*'${pkg.name}'|name:\\s*"${pkg.name}"`))
    assert.match(text, /insert:/)
  })

  it('publishes only files that exist, and ships the host + client halves', () => {
    assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0)
    for (const entry of pkg.files) {
      assert.ok(existsSync(join(ROOT, entry)), `files entry missing on disk: ${entry}`)
    }
    for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      assert.ok(pkg.files.includes(required), `${required} must ship`)
    }
    // The published tarball must not depend on a build step.
    for (const script of ['postinstall', 'prepare', 'prepublish', 'install']) {
      assert.equal(pkg.scripts?.[script], undefined, `${script} would run at install time`)
    }
    assert.equal(readdirSync(ROOT).includes('node_modules'), false, 'no dependencies to install')
  })
})

describe('client bundle shape', () => {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')

  it('registers under the package name with the official loader wrapper', () => {
    assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
    const id = /id:\s*"([^"]+)"/.exec(source)?.[1]
    assert.equal(id, pkg.name, 'the loader keys bundles by package name')
  })

  it('requires nothing but react (the shell module table)', () => {
    const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
    assert.deepEqual([...new Set(requires)], ['react'])
  })

  it('exports inject + apply and declares the sidebar service', () => {
    assert.match(source, /module\.exports = \{ inject: inject, apply: apply \}/)
    assert.match(source, /var inject = \["betterSidebar"\]/)
  })
})
