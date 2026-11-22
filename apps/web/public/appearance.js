// Applies the saved appearance before the app loads, so a reload never flashes the wrong
// colors. src/lib/appearance.ts writes this value and takes over once it runs.
(function () {
  var saved = {}
  try {
    saved = JSON.parse(localStorage.getItem('squirmy.appearance') || '{}') || {}
  } catch {
    // Without storage, or with a value that cannot be read, the app starts in the system's appearance.
  }
  var dark = saved.mode === 'dark' || (saved.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  // The default theme's backgrounds, as in index.css; another theme's are in its saved stylesheet.
  var background = dark ? '#1d1929' : '#fbf9ff'
  if (typeof saved.css === 'string' && saved.css) {
    var style = document.createElement('style')
    style.id = 'squirmy-color-theme'
    style.textContent = saved.css
    document.head.appendChild(style)
    var own = (dark ? /:root\.dark\{[^}]*--background:(#[0-9a-f]+)/ : /:root:not\(\.dark\)\{[^}]*--background:(#[0-9a-f]+)/).exec(saved.css)
    if (own) background = own[1]
  }
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', background)
})()
