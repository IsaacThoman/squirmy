# Signing in and security

How people sign in to a Squirmy server, and what an admin can do when something goes wrong. For accounts, roles and invites, see [Users and access](./users.md).

| Way to sign in | Web app | iOS and Apple TV apps | Subsonic apps |
|---|---|---|---|
| Username and password | yes | yes | no |
| Password and an authenticator code ([two-factor](#two-factor-authentication)) | yes | yes | no |
| [App password](./users.md#app-passwords) | no | no | yes |

## Sessions

Each sign-in opens a session: a random token that the server keeps only as a hash. The web app holds it in an httpOnly cookie, the apps in the system keychain. A session lasts 180 days and renews while it is used.

**Settings → Security → Where you're signed in** lists your sessions, most recently used first: the browser or device, when it last did something, and when and how it signed in. **Sign out** ends one session, and **Sign out everywhere else** ends all but the one you are using. The ended browser or app is signed out at once, and has to sign in again. App passwords are separate credentials and keep working; revoke them under **Settings → App passwords**.

The list shows no locations: Squirmy does not look addresses up with outside services.

An admin can do the same for anyone, from **Admin → Users & invites → Manage → Sign-ins and security…**: sign out one session, or **Sign out everywhere**. Changing your password, an admin resetting it and disabling an account still end sessions as described in [Managing accounts](./users.md#managing-accounts).

## Two-factor authentication

With two-factor authentication on, signing in with a password also asks for a six-digit code from an authenticator app (1Password, Google Authenticator, Authy, Bitwarden and others; any app that supports TOTP, [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), with the usual 30-second codes).

### Turning it on

1. Open **Settings → Security** and choose **Turn on** next to **Authenticator app**.
2. Enter your password.
3. Scan the QR code with the app, or type the setup key into it. The server draws the QR code itself; the secret is not sent anywhere else.
4. Enter the code the app shows, and choose **Turn on**.
5. Save the ten **recovery codes**. Each one signs you in once in place of a code, if you lose your phone. They are shown only this once; **New recovery codes** (with your password and a current code) replaces the whole set.

From then on, the web app, the iOS app and the Apple TV app ask for a code after the password. A code works once, and a code from just before or after the current one is accepted, for a phone clock that is a little off.

### Turning it off

**Settings → Security → Turn off** takes your password and a current code (or an unused recovery code), so neither someone who borrowed a signed-in browser nor someone who only knows your password can turn it off.

If you lost both your phone and your recovery codes, ask an admin: **Admin → Users & invites → Manage → Sign-ins and security… → Turn off** removes the second factor from that account. Admins cannot do this for their own account from there; another admin can. A server with a single admin who lost both should keep the recovery codes somewhere safe, because the only other way back is the database (delete the admin's row from the `totp_credentials` table).

### What it covers

The code is asked for when someone signs in with a password. It does not apply to:

- **App passwords** for Subsonic apps. They are random passwords for one app each, made while signed in with your password; Subsonic's sign-in has no room for a second step. Revoke one under **Settings → App passwords** if a device is lost.
- **Sessions already open** when you turn it on. Use **Sign out everywhere else** if you want every device to sign in again with a code.

### Limits

After a right password, the server waits 5 minutes for the code, and 5 wrong codes end that attempt: the password has to be entered again. Wrong codes are also counted per account, wherever they come from: after 10 in an hour, the account waits out the rest of the hour before another code is checked. Someone trying codes already has the password, so change it if this happens and you did not do it. Secrets are stored encrypted with the server secret, and recovery codes only as keyed hashes. Like the sign-in limits, the counters live in the server's memory and start again when it restarts.
