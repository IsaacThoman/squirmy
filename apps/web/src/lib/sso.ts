/** What the server's single sign-on redirects mean, by the code it puts in `sso_error`. */
const ssoMessages: Record<string, string> = {
  sso_unavailable: 'Single sign-on isn’t set up on this server.',
  sso_expired: 'That sign-in took too long, or was started in another browser. Try again.',
  sso_denied: 'The sign-in was cancelled.',
  sso_failed: 'The sign-in provider’s answer couldn’t be checked. Try again, or ask an admin to test the setup.',
  sso_not_allowed: 'Your account at the provider isn’t in a group that may use this server.',
  sso_no_account: 'There’s no account here for you yet. Ask an admin to add one with your email address.',
  sso_username_taken: 'An account here already has your username. Ask an admin to add your email address to it.',
  sso_username_invalid: 'The provider gave no username this server can use. Ask an admin.',
  sso_linked_elsewhere: 'That provider account is already connected to another account here.',
  account_disabled: 'This account is disabled. Ask an admin to turn it back on.',
}

export function ssoMessage(code: string): string {
  return ssoMessages[code] ?? 'Single sign-on didn’t work. Try again.'
}

/** Sends the browser to the provider, to come back signed in at `next`. */
export function startSso(next: string) {
  window.location.assign(`/api/v1/auth/sso/start?next=${encodeURIComponent(next)}`)
}
