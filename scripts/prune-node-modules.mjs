// Deletes every installed package the given workspace cannot reach through its
// production dependencies.
//
//   node scripts/prune-node-modules.mjs apps/server
//
// npm installs a workspace's dependencies together with packages that other workspaces
// hoisted to the root (the whole React Native toolchain, in this repository). The Docker
// image only runs the server, so the image build removes the rest.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs'
import path from 'node:path'

const workspace = process.argv[2]
if (!workspace) {
  console.error('Usage: prune-node-modules.mjs <workspace directory>')
  process.exit(1)
}

/** Node's own lookup: the nearest node_modules folder, walking up from `from`. */
function resolve(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name)
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
    if (path.dirname(directory) === directory) return null
  }
}

const keep = new Set()

function visit(directory) {
  if (keep.has(directory)) return
  keep.add(directory)
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])
  // A required peer is part of the package's runtime; an optional one is the consumer's choice.
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (!manifest.peerDependenciesMeta?.[peer]?.optional) names.add(peer)
  }
  for (const name of names) {
    const found = resolve(directory, name)
    if (found) visit(found)
  }
}

visit(realpathSync(workspace))

let removed = 0

function prune(packageDirectory) {
  // Workspace packages are symlinks into the repository; they are not installed copies.
  if (lstatSync(packageDirectory).isSymbolicLink()) return
  if (!keep.has(realpathSync(packageDirectory))) {
    rmSync(packageDirectory, { recursive: true, force: true })
    removed += 1
    return
  }
  const nested = path.join(packageDirectory, 'node_modules')
  if (existsSync(nested)) sweep(nested)
}

function sweep(modules) {
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue
    const full = path.join(modules, entry)
    if (!entry.startsWith('@')) {
      prune(full)
      continue
    }
    for (const scoped of readdirSync(full)) prune(path.join(full, scoped))
    if (readdirSync(full).length === 0) rmdirSync(full)
  }
}

sweep('node_modules')
console.info(`Kept ${keep.size} packages, removed ${removed}`)
