// Checks every #anchor link in the built documentation site against the headings it
// points at. VitePress fails the build on links to missing pages but not on missing
// anchors, which break silently when a heading is renamed.
//
//   npm run docs:build && node scripts/check-doc-anchors.mjs
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dist = path.resolve(process.argv[2] ?? 'docs/.vitepress/dist')

/** Built pages by their clean URL: `/server/quick-start`, `/` for the home page. */
const pages = new Map()
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html') || entry.name === '404.html') continue
  const file = path.join(entry.parentPath, entry.name)
  const url = `/${path.relative(dist, file).split(path.sep).join('/')}`.replace(/\.html$/, '').replace(/(^|\/)index$/, '$1')
  pages.set(url === '' ? '/' : url, readFileSync(file, 'utf8'))
}

const problems = []
let checked = 0
for (const [page, html] of pages) {
  // Only the page body: the sidebar and the outline are generated and always right.
  const start = html.indexOf('class="vp-doc')
  const body = start < 0 ? html : html.slice(start)
  for (const [, href] of body.matchAll(/href="([^"]+)"/g)) {
    if (/^[a-z]+:/i.test(href) || !href.includes('#')) continue
    const [target, hash] = href.split('#')
    if (!hash) continue
    const resolved = target ? path.posix.resolve(path.posix.dirname(`${page}x`), target).replace(/\.html$/, '') : page
    const html2 = pages.get(resolved) ?? pages.get(resolved.replace(/\/$/, '') || '/')
    checked += 1
    if (!html2) problems.push(`${page}: ${href} points at a page that does not exist`)
    else if (!html2.includes(`id="${decodeURIComponent(hash)}"`)) problems.push(`${page}: ${href} points at a heading that does not exist`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`${checked} anchor links in ${pages.size} pages are fine.`)
