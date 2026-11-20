/// <reference types="vitest/config" />
import { createReadStream, statSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// SQUIRMY_API_URL points the proxy at another server, e.g. a scratch one for end-to-end runs.
const api = process.env.SQUIRMY_API_URL ?? 'http://127.0.0.1:4747'

/** Serves the test tones from scripts/dev-audio.mjs at /dev-audio/, with Range so seeking works. */
function devAudio(): Plugin {
  const folder = new URL('./.dev-audio/', import.meta.url).pathname
  return {
    name: 'squirmy-dev-audio',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dev-audio', (request, response, next) => {
        const name = decodeURIComponent((request.url ?? '').split('?')[0].slice(1))
        if (!/^[\w-]+\.flac$/.test(name)) return next()
        let size: number
        try {
          size = statSync(folder + name).size
        } catch {
          response.statusCode = 404
          return response.end()
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
        const start = range ? Number(range[1]) : 0
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        response.setHeader('Content-Type', 'audio/flac')
        response.setHeader('Accept-Ranges', 'bytes')
        response.setHeader('Content-Length', end - start + 1)
        if (range) {
          response.statusCode = 206
          response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        }
        createReadStream(folder + name, { start, end }).pipe(response)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devAudio()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  build: {
    rolldownOptions: {
      output: {
        // Libraries change less often than the app, so they get chunks of their own that stay cached.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/ },
            { name: 'schemas', test: /node_modules[\\/]zod[\\/]|packages[\\/]contracts[\\/]/ },
            { name: 'ui', test: /node_modules[\\/](radix-ui|@radix-ui|@floating-ui|@tanstack|lucide-react|socket\.io-client|engine\.io-client|socket\.io-parser)[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': api,
      '/rest': api,
      '/socket.io': { target: api, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
