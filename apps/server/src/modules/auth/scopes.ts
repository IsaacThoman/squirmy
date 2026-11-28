import { API_PREFIX, type ApiTokenScope } from '@squirmy/contracts'
import type { FastifyRequest } from 'fastify'

const libraryReads = new Set([
  '/home', '/search/library', '/search/catalog', '/library/items', '/library/albums', '/library/artists',
  '/library/tracks', '/library/genres', '/collection/albums', '/collection/artists', '/collection/tracks',
  '/artists/:id', '/artists/:id/releases', '/albums/:id', '/tracks/:id', '/tracks/:id/lyrics',
  '/me/likes/:type', '/me/history', '/playlists', '/playlists/:id', '/playlists/folders', '/playlists/:id/export',
])

const playlistReads = new Set([
  '/playlists', '/playlists/:id', '/playlists/folders', '/playlists/:id/export',
  '/playlists/:id/collaborators', '/playlists/:id/people',
])

const playlistWrites = new Set([
  'POST /playlists', 'PATCH /playlists/:id', 'DELETE /playlists/:id', 'POST /playlists/:id/items',
  'POST /playlists/:id/items/move', 'DELETE /playlists/:id/items/:itemId', 'POST /playlists/:id/items/dedupe',
  'POST /playlists/folders', 'DELETE /playlists/folders/:id', 'POST /playlists/import',
  'POST /playlists/:id/cover', 'DELETE /playlists/:id/cover',
  'PUT /playlists/:id/collaborators/:userId', 'DELETE /playlists/:id/collaborators/:userId',
])

/** Match the registered route template so path encodings and query parameters cannot change authorization. */
export function allowedApiToken(request: FastifyRequest, scopes: readonly ApiTokenScope[]): boolean {
  const route = request.routeOptions.url?.slice(API_PREFIX.length) ?? ''
  const method = request.method === 'HEAD' ? 'GET' : request.method
  if (route.startsWith('/admin/')) return scopes.includes('admin')
  if (route === '/tracks/:id/playback' || route === '/me/session' || route === '/me/devices') {
    return method === 'GET' && scopes.includes('playback:control')
  }
  if (route === '/me/session/command') return method === 'POST' && scopes.includes('playback:control')
  if (playlistWrites.has(`${method} ${route}`) || (method === 'GET' && playlistReads.has(route) && scopes.includes('playlists:manage'))) {
    return scopes.includes('playlists:manage')
  }
  return scopes.includes('library:read') && ((method === 'GET' && libraryReads.has(route)) || (method === 'POST' && route === '/tracks/summaries'))
}
