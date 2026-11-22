# Users and access

Everyone on a server shares one library. Likes, playlists, listening history, the wantlist and the playback session are each person's own. This page covers the first admin, inviting people, roles and permissions, and app passwords.

## The first admin

The first account, created in the setup wizard on first start, is an admin with every permission. Until it exists, every page of the web app shows the setup wizard, so do the setup before exposing a new server to the internet.

The server always keeps at least one active admin: the last one cannot be demoted, disabled or deleted.

## Roles and permissions

| | Member | Admin |
|---|---|---|
| Browse, search, play, like, make playlists | yes | yes |
| Library folders, review queue, organize, users, server settings, jobs | no | yes |
| **Can upload music** ([uploads](./adding-music.md#uploading)) | if granted | always |
| **Can fetch missing music** (through an [acquisition provider](./acquisition.md)) | if granted | always |

Shown as the **Upload** and **Fetch** badges next to a user in **Management → Users & invites**.

## Inviting people

1. Open **Management → Users & invites** and choose **Invite someone**.
2. Pick the role, **Can upload music**, **Can fetch missing music**, and when the link expires (**In a day**, **In 7 days**, **In 14 days**, **In 30 days** or **Never**).
3. Copy the **Invite link** and send it. It looks like `https://music.example.com/register?invite=…`, built from the address you opened the admin page at, so open it at the public address before copying.

The person opens the link, chooses a username and a password, and is signed in. Each link works once. **Revoke** stops an unused link; accounts already made with it stay.

To make an account yourself instead, choose **Add user**, set a username, an optional display name and a password (at least 8 characters), and pass the password on.

### Open registration

**Management → Server settings → General → Registration → Require an invite to join** is on by default. Turned off, anyone who can reach the server can create a member account, without upload or fetch permissions, from the sign-in page. Leave it on for a server on the internet.

## Managing accounts

Each user's **Manage** menu in **Management → Users & invites** has:

- **Edit…**: display name, role and permissions.
- **Reset password…**: sets a new password and signs them out everywhere. Their app passwords keep working.
- **Disable account…**: signs them out everywhere and blocks sign-in until **Enable account**.
- **Delete account…**: deletes their likes, playlists and history too. The shared library stays.

## Signing in and sessions

Sessions last 180 days and renew while in use. Changing your own password (**Settings → Account → Change password**) signs out your other browsers and apps; app passwords keep working.

Sign-in is rate limited to 5 attempts a minute per username and 20 per IP address. Behind a reverse proxy, set [`TRUST_PROXY`](./reverse-proxy.md#what-trust-proxy-does) so the limit applies to the real client address.

## App passwords

App passwords are for [Subsonic apps](./subsonic.md), which need a password of their own. They work only on the Subsonic API under `/rest`; they cannot sign in to the web app or the iOS app, and your account password does not work in Subsonic apps.

1. Open **Settings → App passwords** and choose **Create**.
2. Name it after the app that will use it ("Symfonium on my phone") and choose **Create**.
3. Copy it. This is the only time it is shown.

The list shows when each was created and last used. **Revoke** signs that one app out without touching anything else. App passwords are stored encrypted with the server secret, because Subsonic's login scheme needs the original text.
