import type { useRouter } from 'expo-router';

/** Closes the sheet on screen, or goes home when it was opened by a link with nothing beneath. */
export function closeSheet(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}
