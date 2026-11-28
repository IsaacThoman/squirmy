import { API_PREFIX, type ApiTokenScope } from '@squirmy/contracts'
import type { FastifyRequest } from 'fastify'

const libraryReads = new Set([
  '/home', '/search/library', '/search/catalog', '/library/items', '/library/albums', '/library/artists',
  '/library/tracks', '/library/genres', '/collection/albums', '/collection/artists', '/collection/tracks',
  '/artists/:id', '/artists/:id/releases', '/albums/:id', '/tracks/:id', '/tracks/:id/lyrics',
  '/me/likes/:type', '/me/history', '/playlists', '/playlists/:id',
])

const playlistWrites = new Set([
  'POST /playlists', 'PATCH /playlists/:id', 'DELETE /playlists/:id', 'POST /playlists/:id/items',
  'POST /playlists/:id/items/move', 'DELETE /playlists/:id/items/:itemId',
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
  if (playlistWrites.has(`${method} ${route}`) || (method === 'GET' && ['/playlists', '/playlists/:id'].includes(route) && scopes.includes('playlists:manage'))) {
    return scopes.includes('playlists:manage')
  }
  return scopes.includes('library:read') && ((method === 'GET' && libraryReads.has(route)) || (method === 'POST' && route === '/tracks/summaries'))
}
