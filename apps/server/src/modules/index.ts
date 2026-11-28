import type { ServerModule } from './types.js'
import { authModule } from './auth/index.js'
import { adminModule } from './admin/index.js'
import { libraryModule } from './library/index.js'
import { artworkModule } from './artwork/index.js'
import { catalogModule } from './catalog/index.js'
import { streamingModule } from './streaming/index.js'
import { loudnessModule } from './loudness/index.js'
import { userdataModule } from './userdata/index.js'
import { sessionsModule } from './sessions/index.js'
import { metadataModule } from './metadata/index.js'
import { matchingModule } from './matching/index.js'
import { enrichmentModule } from './enrichment/index.js'
import { organizeModule } from './organize/index.js'
import { subsonicModule } from './subsonic/index.js'
import { searchModule } from './search/index.js'
import { integrationsModule } from './integrations/index.js'
import { importsModule } from './imports/index.js'
import { acquisitionModule } from './acquisition/index.js'
import { scrobbleModule } from './scrobble/index.js'
import { radioModule } from './radio/index.js'
import { sonicModule } from './sonic/index.js'
import { catalogIndexModule } from './catalog-index/index.js'
import { shareModule } from './share/index.js'

/** Every module, in registration order. A module only edits files inside its own folder. */
export const modules: ServerModule[] = [
  authModule,
  adminModule,
  libraryModule,
  artworkModule,
  catalogModule,
  streamingModule,
  loudnessModule,
  sonicModule,
  userdataModule,
  sessionsModule,
  metadataModule,
  matchingModule,
  enrichmentModule,
  organizeModule,
  subsonicModule,
  searchModule,
  importsModule,
  acquisitionModule,
  scrobbleModule,
  integrationsModule,
  radioModule,
  catalogIndexModule,
  shareModule,
]
