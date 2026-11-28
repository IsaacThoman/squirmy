import { defineConfig } from 'vitepress'

const repository = 'https://github.com/IsaacThoman/squirmy'
// GitHub Pages serves a project site under /<repository>/; the deploy workflow sets this.
const base = process.env.DOCS_BASE ?? '/'

const sidebar = [
  {
    text: 'Run a server',
    items: [
      { text: 'Quick start', link: '/server/quick-start' },
      { text: 'Configuration', link: '/server/configuration' },
      { text: 'Reverse proxies and HTTPS', link: '/server/reverse-proxy' },
      { text: 'Deploying on Coolify', link: '/server/coolify' },
      { text: 'Backup, restore and moving', link: '/server/backup' },
      { text: 'Troubleshooting', link: '/server/troubleshooting' },
    ],
  },
  {
    text: 'Your music',
    items: [
      { text: 'Your library', link: '/server/library' },
      { text: 'Organizing files', link: '/server/organizing' },
      { text: 'Adding music', link: '/server/adding-music' },
      { text: 'Metadata and privacy', link: '/server/metadata-and-privacy' },
      { text: 'Playback', link: '/server/playback' },
      { text: 'Sonic analysis', link: '/server/sonic-analysis' },
    ],
  },
  {
    text: 'People and apps',
    items: [
      { text: 'Users and access', link: '/server/users' },
      { text: 'Signing in and security', link: '/server/authentication' },
      { text: 'Subsonic clients', link: '/server/subsonic' },
      { text: 'Scrobbling', link: '/server/scrobbling' },
      { text: 'Share links', link: '/server/sharing' },
      { text: 'Integrations', link: '/server/integrations' },
      { text: 'Acquisition providers', link: '/server/acquisition' },
    ],
  },
  {
    text: 'Using Squirmy',
    items: [
      { text: 'The web app', link: '/use/web' },
      { text: 'The iOS app', link: '/use/ios' },
      { text: 'The Apple TV app', link: '/use/apple-tv' },
      { text: 'A Squirmy speaker', link: '/server/speaker' },
      { text: 'Keyboard shortcuts', link: '/use/keyboard-shortcuts' },
      { text: 'The wantlist', link: '/use/wantlist' },
      { text: 'Sharing music', link: '/use/sharing' },
    ],
  },
  {
    text: 'Development',
    collapsed: true,
    items: [
      { text: 'Product plan', link: '/plan' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Roadmap', link: '/roadmap' },
      { text: 'Provider protocol', link: '/provider-protocol' },
      { text: 'Local search index', link: '/local-search-index' },
      { text: 'Detached playback UI', link: '/detached-playback-ui' },
      { text: 'Audio engine', link: '/audio-engine' },
    ],
  },
]

export default defineConfig({
  lang: 'en-US',
  title: 'Squirmy',
  titleTemplate: ':title · Squirmy',
  description: 'Squirmy is a self-hosted music server with web, iOS and Apple TV apps.',
  base,
  cleanUrls: true,
  lastUpdated: true,
  // Dead links fail the build, so a broken link fails CI.
  ignoreDeadLinks: false,
  head: [
    // The same tab icon as the web app: the head on the dark background, which reads at 16 px.
    ['link', { rel: 'icon', sizes: '16x16 32x32 48x48', href: `${base}favicon.ico` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    ['meta', { name: 'theme-color', content: '#5B439E' }],
  ],
  themeConfig: {
    logo: '/squirmy-mark.png',
    siteTitle: 'Squirmy',
    nav: [
      { text: 'Quick start', link: '/server/quick-start' },
      { text: 'Configuration', link: '/server/configuration' },
      { text: 'Roadmap', link: '/roadmap' },
    ],
    sidebar,
    search: {
      provider: 'local',
    },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: {
      pattern: `${repository}/edit/dev/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    outline: { level: [2, 3] },
  },
})
