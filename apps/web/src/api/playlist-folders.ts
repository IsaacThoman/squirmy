import { queryKeys } from '@squirmy/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useApi } from './services'

export function usePlaylistFolders() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.playlistFolders(), queryFn: () => api.userdata.playlistFolders(), retry: false })
}

export function useMovePlaylistToFolder() {
  const api = useApi()
  const cache = useQueryClient()
  return useCallback(async (playlistId: string, folderId: string | null) => {
    await api.userdata.updatePlaylist(playlistId, { folderId })
    await Promise.all([
      cache.invalidateQueries({ queryKey: queryKeys.playlists() }),
      cache.invalidateQueries({ queryKey: queryKeys.libraryItems() }),
    ])
  }, [api, cache])
}
