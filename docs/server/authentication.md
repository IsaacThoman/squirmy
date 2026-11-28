# Signing in and security

How people sign in to a Squirmy server, and what an admin can do when something goes wrong. For accounts, roles and invites, see [Users and access](./users.md).

| Way to sign in | Web app | iOS and Apple TV apps | Subsonic apps |
|---|---|---|---|
| Username and password | yes | yes | no |
| Password and an authenticator code ([two-factor](#two-factor-authentication)) | yes | yes | no |
| [Passkey](#passkeys) | yes | not yet | no |
| [Single sign-on](#single-sign-on-openid-connect) (OpenID Connect) | yes | iOS: yes; Apple TV: no | no |
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

## Passkeys

A passkey signs in with the device's own lock (Face ID, Touch ID, Windows Hello, a PIN or a security key) instead of a password. Passkeys are kept by the device or a password manager (iCloud Keychain, Google Password Manager, 1Password, Bitwarden…), which can sync them to your other devices. The server keeps only the public half.

### What the server needs

Browsers offer passkeys only on a secure page, and a passkey belongs to one host name. So passkeys work when **[`PUBLIC_URL`](./configuration.md) is an `https://` address**, such as `https://music.example.com`, and people open the web app at that address. (For development, `http://localhost:<port>` works too.) Without it, **Settings → Security** says so and the sign-in page offers no passkey button. Opening the web app at another address (a LAN IP, a second host name) shows the passkey button but the browser offers no passkey there.

The relying party ID is `PUBLIC_URL`'s host name. **Changing the host name** makes every passkey unusable: people sign in with their password and add new ones. Moving the server behind the same name changes nothing.

### Adding and using one

1. Open **Settings → Security** and choose **Add passkey**.
2. Enter your password (a passkey outlives the session it is added from, as an app password does), and name it; the name defaults to the browser's.
3. Follow the browser's prompt.

On the sign-in page, **Sign in with a passkey** lets the browser offer the passkeys it has for the server; no username is needed. A passkey sign-in skips the authenticator code: the device already checked who you are (user verification is required). **Rename** and **Remove** are next to each passkey; an account can hold 20.

An admin resetting someone's password or disabling their account removes their passkeys, as it does their app passwords. Changing your own password keeps them: check the list in **Settings → Security** if you think someone else had your account. Admins see someone's passkeys in **Manage → Sign-ins and security…**.

The iOS and Apple TV apps don't offer passkeys yet: they need the app to be linked to your server's domain, which a self-hosted server can't set up for the app.

### Limits

Passkey sign-ins are limited to 20 a minute per address. Each ceremony has its own challenge, which lasts 5 minutes and is used once. A passkey whose signature counter goes backwards (a sign of a copied authenticator) is refused.

## Single sign-on (OpenID Connect)

Squirmy can sign people in through an OpenID Connect provider you run or use: Authelia, Authentik, Keycloak, Kanidm, Pocket ID, Google and others. The sign-in page then shows **Sign in with …**, people can connect their existing accounts, and you can turn password sign-in off.

It uses the authorization code flow with PKCE, state and nonce, and the provider's discovery document (`/.well-known/openid-configuration`). The ID token's signature, issuer, audience, expiry and nonce are checked; userinfo, when the provider has it, adds claims the ID token leaves out. A browser cookie ties each round trip to the browser that started it, so a callback link sent to someone else signs nobody in.

### Setting it up

1. Set [`PUBLIC_URL`](./configuration.md) to the address people use. The provider sends them back to `<PUBLIC_URL>/api/v1/auth/sso/callback`.
2. At the provider, create a **confidential** client (OpenID Connect, authorization code) with that callback as its redirect URI, the scopes `openid profile email` (plus `groups` where the provider needs it to send groups), and client authentication `client_secret_basic` (`client_secret_post` also works when the provider offers only that).
3. In **Admin → Server settings → Single sign-on**, enter the **Issuer URL** (the provider's address for this client, such as `https://auth.example.com` for Authelia, `https://auth.example.com/application/o/squirmy/` for Authentik, `https://keycloak.example.com/realms/home` for Keycloak, `https://accounts.google.com` for Google), the **Client ID** and the **Client secret**. The screen shows the callback address to copy.
4. Choose **Test**: it loads the provider's configuration with what you saved.
5. Turn on **Offer single sign-on**.

An issuer on plain `http://` is accepted (a provider on the same private network), but use https wherever the traffic leaves the machine.

### Who gets in, and as whom

When someone signs in with the provider, Squirmy looks for:

1. An account already **connected** to that provider account (by its issuer and subject).
2. An account with the same **email address**, when the provider says it verified that address. Only admins set emails: **Admin → Users & invites → Add user** or **Manage → Edit…**. That account is then connected.
3. Otherwise, with **Create accounts** on, a new member account. Its username comes from the **Username claim** (`preferred_username`; an email gives the part before the @, and characters a username cannot have become dashes). If that username is taken, sign-in says so instead of making a second account: give the existing account the person's email address. Accounts made this way have no password; their owners sign in with the provider or a passkey, and an admin can set a password with **Reset password…**.

With **Create accounts** off, people need an account first (made by an admin with their email, or connected by them from their settings).

**Allowed groups** limits sign-in to members of the listed groups, read from the **Groups claim** (`groups`; a dotted path such as `realm_access.roles` reaches into nested claims). It applies to every sign-in, not only new accounts.

Signing in with the provider skips Squirmy's two-factor step: the provider decides how people prove who they are.

### Connecting an existing account

In **Settings → Security**, **Connect** (with your password) sends you to the provider and back; you can then sign in either way. **Disconnect** removes the link; an account without a password cannot remove its only way in. One provider account can be connected to one Squirmy account.

### The iOS app

The iOS app's sign-in shows **Sign In with …** and opens the provider in the system's sign-in sheet, which returns to the app with a one-time code (valid for two minutes, used once) that the app trades for a session. Only the app's own `squirmy://` address is accepted as a return address. The Apple TV app has no browser, so it cannot use single sign-on; with password sign-in off it cannot sign in.

### Turning password sign-in off

**Turn off password sign-in** makes the sign-in page offer only single sign-on and passkeys, and turns joining with an invite off (it would make a password account). App passwords for Subsonic apps keep working. To avoid locking everyone out, it can be turned on only while single sign-on is set up and on, and only by an admin whose own account is connected to the provider; single sign-on cannot be turned off while it is on.

If the provider breaks and no admin can sign in, set the environment variable `SQUIRMY_ADMIN_PASSWORD_LOGIN=true` and restart: admins (only) can sign in with their password again, and turn the setting off. Remove the variable afterwards. An admin who has no password (made by single sign-on) needs another admin to set one first; on a server with only such an admin, set a password hash in the database, or turn the setting off there (`server_settings`, key `settings`, `passwordLoginDisabled`).

### Errors

The sign-in page says why single sign-on sent someone back: cancelled at the provider, too slow or started in another browser, not in an allowed group, no account and creating accounts off, a username already taken, a disabled account, or an answer that could not be checked (a wrong client secret, a clock far off, a misconfigured provider). The server log has the details of the last kind (`Single sign-on failed`).
