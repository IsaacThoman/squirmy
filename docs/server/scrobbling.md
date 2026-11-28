# Scrobbling

Squirmy can send what each person listens to to ListenBrainz and Last.fm. Each user connects their own account; the operator only has to set up Last.fm.

## What counts as a play

A play counts once you have listened to half of a song or four minutes of it, whichever comes first. Pauses and seeks do not add listening time, and plays under five seconds are skips. Plays from Subsonic apps that report them (`scrobble`) count too.

Plays are sent in the background, about once a minute, with the title, artist, album, track number, length, start time and, when the song is identified, its MusicBrainz recording, release and artist ids. If a service is down, plays wait and are retried with growing delays for a while; plays older than 14 days are not sent. "Now playing" is sent once, when a song starts, and is not retried.

Only plays made after you connect are sent. Disconnecting stops sending and drops plays that were still waiting.

## ListenBrainz

**Operator:** nothing to do. (The ListenBrainz token in **Admin → Server settings → API keys** is for top songs and similar artists, not for users' scrobbling.)

**Each user:**

1. Copy the user token from [your ListenBrainz settings](https://listenbrainz.org/settings/).
2. In the web app, open **Settings → Scrobbling**, choose **Connect** next to ListenBrainz, paste it into **User token**, and choose **Connect**. In the iOS app, open the account sheet, then **Settings**, paste the token under **ListenBrainz**, and choose **Connect**.

The token is checked with ListenBrainz before it is saved, and stored encrypted.

## Last.fm

**Operator:**

1. Create a Last.fm API account and note its **API key** and **shared secret**.
2. Open **Admin → Server settings → API keys → Last.fm**, choose **Add key**, enter both, and choose **Save key**.
3. Set [`PUBLIC_URL`](./configuration.md#environment-variables) to the address people use. After approving access on Last.fm, the browser is sent back to `<PUBLIC_URL>/api/v1/scrobbling/lastfm/callback`. Without `PUBLIC_URL`, the server uses the address of the request, which is wrong behind a reverse proxy that is not trusted (`TRUST_PROXY`), and unreachable when the app connected through a local address.

Until the key is set, users see "An admin of this server has to add a Last.fm API key first."

**Each user:**

1. In the web app, open **Settings → Scrobbling** and choose **Connect** next to Last.fm. In the iOS app, open the account sheet, then **Settings**, then **Connect** under **Last.fm**.
2. Approve Squirmy on Last.fm's page.
3. From the web app, you land back in it, with **Settings** open on **Scrobbling** and a confirmation. From the iOS app, Last.fm's page closes and **Last.fm** in Settings shows the account, or why it didn't connect. The approval link is valid for 10 minutes.

## Status and problems

**Settings → Scrobbling** shows each connected service with the account name, how many plays are waiting and how many could not be sent, and a switch to stop sending to that service without disconnecting (plays made while it is off are never sent). The iOS app shows the same switch as **Scrobbling** under each connected service. Disconnecting asks first: plays still waiting to be sent are dropped. When a service stops accepting the connection (a revoked token, a removed app), it says "… no longer accepts this connection. Connect again to keep scrobbling." with **Reconnect**, and plays wait until you do. A play that fails 10 times is given up on and counted as could not be sent.

### Compatible ListenBrainz servers

In web Settings, choose **Change connection** to use a different server. Supply its user token and the complete versioned path in **API URL**, for example `https://listens.example.com/1/`. Compatible servers need to implement token validation and listen submission. Heart sync also requires recording feedback endpoints. Leaving the field blank uses ListenBrainz. The token, now-playing updates, completed plays and feedback for the account all go to the selected server. A change of destination starts a new connection.

The server checks destination addresses on connection. For a service on an RFC1918 network, an admin must enable **Allow local HTTP destinations** in [Integrations](./integrations.md#webhooks). Use HTTPS when sending credentials over an untrusted network.

## Heart sync

In web **Settings → Scrobbling**, turn on **Sync hearts** for either connected service. Sync runs in the background about every 15 minutes while scrobbling is enabled. It reads Last.fm loves and ListenBrainz love/hate feedback and sends Squirmy track hearts as loves. ListenBrainz exports require a MusicBrainz recording ID. ListenBrainz hates remove a heart if the remote feedback is at least as recent as the heart.

Squirmy matches a MusicBrainz recording ID first, then matches normalized artist and track names when they identify a single recording. Unmatched and ambiguous feedback is skipped and reconsidered on later runs, so there is no separate pending collection to maintain. Each sync reads up to 10,000 of the most recent entries per service and sends up to 50 local hearts per service. Imported hearts stay local and a previously observed remote love does not override a later local removal. Removing a heart in Squirmy leaves remote feedback as it was.
