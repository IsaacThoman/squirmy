import { Navigate, Route, Routes } from 'react-router'
import { AdminLayout } from '@/components/admin/AdminLayout'
import { LoginPage, RegisterPage, SettingsPage, SetupPage } from '@/pages/account'
import {
  AdminJobsPage, AdminLibraryPage, AdminOrganizePage, AdminProvidersPage, AdminReviewsPage, AdminSettingsPage, AdminUsersPage,
} from '@/pages/admin'
import { KitchenSinkPage } from '@/pages/KitchenSink'
import {
  AlbumPage, ArtistPage, HomePage, LibraryAlbumsPage, LibraryArtistsPage, LibraryPlaylistsPage, LibrarySongsPage, LikedPage, NotFoundPage,
  PlaylistPage, SearchPage, ShellPage, WantlistPage,
} from '@/pages/music'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ShellPage />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="library" element={<Navigate to="/library/albums" replace />} />
        <Route path="library/albums" element={<LibraryAlbumsPage />} />
        <Route path="library/artists" element={<LibraryArtistsPage />} />
        <Route path="library/songs" element={<LibrarySongsPage />} />
        <Route path="library/playlists" element={<LibraryPlaylistsPage />} />
        <Route path="liked" element={<LikedPage />} />
        <Route path="wantlist" element={<WantlistPage />} />
        <Route path="album/:id" element={<AlbumPage />} />
        <Route path="artist/:id" element={<ArtistPage />} />
        <Route path="playlist/:id" element={<PlaylistPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/library" replace />} />
          <Route path="library" element={<AdminLibraryPage />} />
          <Route path="reviews" element={<AdminReviewsPage />} />
          <Route path="organize" element={<AdminOrganizePage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="providers" element={<AdminProvidersPage />} />
          <Route path="settings" element={<AdminSettingsPage />} />
          <Route path="jobs" element={<AdminJobsPage />} />
        </Route>
        <Route path="dev/kitchen-sink" element={<KitchenSinkPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
