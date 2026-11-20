import { queryKeys } from '@squirmy/contracts'
import { useQuery } from '@tanstack/react-query'
import { useApi } from './services'

/** The server's error codes for a library folder path; forms show them on the folder field. */
export const rootPathErrors = {
  relative_path: 'path',
  not_a_directory: 'path',
  path_not_found: 'path',
  permission_denied: 'path',
  duplicate_root: 'path',
  nested_root: 'path',
}

/** Lists a directory on the server for the folder picker; its home directory without a path. */
export function useFolderListing(path: string | undefined, enabled = true) {
  const api = useApi()
  return useQuery({
    queryKey: [...queryKeys.admin(), 'fs', path ?? null],
    queryFn: () => api.admin.directories({ path }),
    enabled,
    retry: false,
    meta: { silent: true },
  })
}
