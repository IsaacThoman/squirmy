import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AdminOnly, Bootstrap, RequireSetup, SignedInOnly, SignedOutOnly } from '@/auth/guards'
import { Page } from '@/components/layout/Page'
import { Spinner } from '@/components/ui/feedback'
import { LoginPage, RegisterPage, SetupPage } from '@/pages/account'
import {
  AlbumPage, ArtistPage, ArtistReleasesPage, CollectionPage, HomePage, LibraryPage, LibraryRedirect, LikedPage, MixPage, NotFoundPage, PlaylistPage, SearchPage, WantlistPage,
} from '@/pages/music'
import { JoinJamPage } from '@/pages/jam'
import { SettingsRoute, ShellPage } from '@/pages/shell'

// Admin, import and developer pages are separate downloads; most visits never open them.
const admin = (name: keyof typeof import('@/pages/admin')) => lazy(() => import('@/pages/admin').then(module => ({ default: module[name] })))
const AdminLayout = admin('AdminLayout')
const AdminLibraryPage = admin('AdminLibraryPage')
const AdminReviewsPage = admin('AdminReviewsPage')
const AdminDuplicatesPage = admin('AdminDuplicatesPage')
const AdminFileHealthPage = admin('AdminFileHealthPage')
const AdminOrganizePage = admin('AdminOrganizePage')
const AdminSearchIndexPage = admin('AdminSearchIndexPage')
const AdminUsersPage = admin('AdminUsersPage')
const AdminProvidersPage = admin('AdminProvidersPage')
const AdminSettingsPage = admin('AdminSettingsPage')
const AdminJobsPage = admin('AdminJobsPage')
const imports = (name: keyof typeof import('@/pages/imports')) => lazy(() => import('@/pages/imports').then(module => ({ default: module[name] })))
const ImportsPage = imports('ImportsPage')
const ImportPage = imports('ImportPage')
const uploads = (name: keyof typeof import('@/pages/uploads')) => lazy(() => import('@/pages/uploads').then(module => ({ default: module[name] })))
const ReplayPage = lazy(() => import('@/pages/replay').then(module => ({ default: module.ReplayPage })))
const ReplayTrackPage = lazy(() => import('@/pages/replay').then(module => ({ default: module.ReplayTrackPage })))
const UploadsPage = uploads('UploadsPage')
const AdminUploadsPage = uploads('AdminUploadsPage')
// The developer pages run on fixtures, which production builds leave out.
const dev = import.meta.env.DEV && {
  KitchenSinkPage: lazy(() => import('@/pages/KitchenSink').then(module => ({ default: module.KitchenSinkPage }))),
  EnginePage: lazy(() => import('@/pages/dev-engine').then(module => ({ default: module.EnginePage }))),
}

function Loading({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Page className="flex justify-center pt-24"><Spinner /></Page>}>{children}</Suspense>
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Bootstrap />}>
        <Route path="/setup" element={<SetupPage step="account" />} />
        <Route path="/setup/library" element={<SetupPage step="library" />} />
        <Route path="/setup/done" element={<SetupPage step="done" />} />
        <Route element={<RequireSetup />}>
          <Route element={<SignedOutOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>
          <Route element={<SignedInOnly />}>
            <Route element={<ShellPage />}>
              <Route index element={<HomePage />} />
              <Route path="replay" element={<Loading><ReplayPage /></Loading>} />
              <Route path="track/:id" element={<Loading><ReplayTrackPage /></Loading>} />
              <Route path="search" element={<SearchPage />} />
              <Route path="library" element={<LibraryPage />} />
              {/* The list pages from before the combined Library, kept for links and bookmarks. */}
              <Route path="library/albums" element={<LibraryRedirect filter="albums" />} />
              <Route path="library/artists" element={<LibraryRedirect filter="artists" />} />
              <Route path="library/songs" element={<LibraryRedirect filter="songs" />} />
              <Route path="library/playlists" element={<LibraryRedirect filter="playlists" />} />
              <Route path="collection" element={<CollectionPage />} />
              <Route path="liked" element={<LikedPage />} />
              <Route path="wantlist" element={<WantlistPage />} />
              <Route path="album/:id" element={<AlbumPage />} />
              <Route path="artist/:id" element={<ArtistPage />} />
              <Route path="artist/:id/releases/:section" element={<ArtistReleasesPage />} />
              <Route path="playlist/:id" element={<PlaylistPage />} />
              <Route path="jam/:id" element={<JoinJamPage />} />
              <Route path="mix/:id" element={<MixPage />} />
              <Route path="settings" element={<SettingsRoute />} />
              <Route path="settings/:section" element={<SettingsRoute />} />
              <Route path="imports" element={<Loading><ImportsPage /></Loading>} />
              <Route path="imports/:id" element={<Loading><ImportPage /></Loading>} />
              <Route path="uploads" element={<Loading><UploadsPage /></Loading>} />
              <Route path="admin" element={<AdminOnly />}>
                <Route element={<Loading><AdminLayout /></Loading>}>
                  <Route index element={<Navigate to="/admin/library" replace />} />
                  <Route path="library" element={<Loading><AdminLibraryPage /></Loading>} />
                  <Route path="uploads" element={<Loading><AdminUploadsPage /></Loading>} />
                  <Route path="reviews" element={<Loading><AdminReviewsPage /></Loading>} />
                  <Route path="duplicates" element={<Loading><AdminDuplicatesPage /></Loading>} />
                  <Route path="file-health" element={<Loading><AdminFileHealthPage /></Loading>} />
                  <Route path="organize" element={<Loading><AdminOrganizePage /></Loading>} />
                  <Route path="search-index" element={<Loading><AdminSearchIndexPage /></Loading>} />
                  <Route path="users" element={<Loading><AdminUsersPage /></Loading>} />
                  <Route path="providers" element={<Loading><AdminProvidersPage /></Loading>} />
                  <Route path="settings" element={<Loading><AdminSettingsPage /></Loading>} />
                  <Route path="jobs" element={<Loading><AdminJobsPage /></Loading>} />
                </Route>
              </Route>
              {dev && <Route path="dev/kitchen-sink" element={<Loading><dev.KitchenSinkPage /></Loading>} />}
              {dev && <Route path="dev/engine" element={<Loading><dev.EnginePage /></Loading>} />}
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Route>
        </Route>
      </Route>
    </Routes>
  )
}
