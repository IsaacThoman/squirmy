# Detached playback: UI spec

Status: the protocol, server and shared client code are done, and the web and iOS apps have the controls. This page says how they present them.

Normally every device a user signs in on is a view of one shared session: whatever plays, plays in one place, and every device can control it. Detaching lets one device step out of that and play its own queue, so two people in one household (or one person in two rooms) can listen to different things on one account. Re-attaching puts it back.

The rules are in the "Detaching" section of [`packages/contracts/src/session.ts`](https://github.com/IsaacThoman/squirmy/blob/dev/packages/contracts/src/session.ts) and the server's side in [Architecture, "Sessions"](./architecture.md#sessions). This page covers only what people see.

## What the apps get

From `SessionClient` (client-core), already wired into each app's player:

| | Web (`usePlayer()`) | iOS (`PlaybackProvider` actions and snapshot) |
| --- | --- | --- |
| This device is detached | `state.detached` | `snapshot.detached` |
| Detaching is possible here | `state.canDetach` | `snapshot.canDetach` |
| Detach | `controls.detach()` | `actions.detach()` |
| Re-attach | `controls.attach()` / `controls.attach({ bringQueue: true })` | `actions.attach(...)` |
| Other devices that are detached | `state.devices[i].detached` (`{ playing, trackId, albumId }`) | `snapshot.devices[i].detached` |

`detach` and `attach` resolve to `{ ok: true }` or `{ ok: false, error }` once the server answers (usually well under a second). Nothing changes on screen until then. While detached, everything the player already shows (now playing, queue, history, shuffle, repeat, autoplay) is the device's own session, so the existing player screens need no changes to work; what they need is to make the state obvious.

`canDetach` is false on a device that only controls (a web tab that cannot play audio), against a server too old to support it, and before the first connection. Hide the controls then; don't show them disabled.

## The detached state must be obvious

A detached device that looks like a normal one is a trap: the user presses play on the phone, expects the living room to change, and nothing happens. So:

- **A persistent marker in the player.** While detached, the player bar (web) and the mini player and now-playing screen (iOS) show a small label: **Only on this device**, with an "unlinked" icon (web: `Unlink2` from lucide; iOS: the SF Symbol closest to it, chosen so it reads as "not linked" next to the existing device icons). It sits where "Playing on …" sits for a remote: the same slot, so the two never show at once. It is a button: pressing it opens the devices picker, where re-attaching lives. In the iOS mini player the label sits under the title in a bubble 44 pt tall, too little for two buttons stacked, so there the unlinked icon beside it is the button and the label opens Now Playing with the title.
- **Tint, not alarm.** Use the theme's accent colour for the label, not a warning colour. Detached is a choice, not an error.
- **The tab title (web) is unchanged.** It already shows the track.
- **The lock screen and Control Center (iOS) are unchanged.** They control this phone's audio either way.

## Detaching

The control lives in the devices picker (web: the Devices popover, `DeviceList`; iOS: the "Playback device" sheet), below the device list, separated by a divider:

- **Play separately on this device** (web says "this tab", iOS "this iPhone"), subtitle *Your other devices keep their own queue.*

Pressing it detaches at once, with no confirmation: it is undone by one press. Then:

- If this device was playing, it keeps playing without a pause and the user's other devices show their session paused. Say so on the player's status line (web) or in the notice (iOS): **Playing only on this device** / *Your other devices are paused where they were.*
- If it was not playing, its queue starts as a paused copy of the shared one and other devices are untouched. The player's **Only on this device** says it; iOS's notice: **Playing only on this device**.

Errors, shown on the player's status line (web) or in the notice (iOS) and leaving everything as it was:

| `error` | Message |
| --- | --- |
| `offline` | Can't do that while offline. |
| `too_many_detached` | Eight devices are already playing separately. Re-attach one first. |
| `timeout`, `disconnected`, `internal_error` | Couldn't play separately. Try again. |
| anything else | Couldn't play separately. |

## Re-attaching

While detached, the devices picker replaces the device list with what matters now:

- A header: **Playing only on this device**, with the current track's title, if any. On iOS it reads **Only on this device**, the marker's words, with "Paused ·" before the title while paused, so it is right whether the phone plays or not.
- **Rejoin your other devices**: attach as a remote. This device's own queue is discarded and its audio stops; it then shows whatever the shared session is doing (possibly "Playing on Living room").
- **Bring this queue with me**, subtitle *Your other devices switch to what's playing here*: `attach({ bringQueue: true })`. This device stays the one playing, with no gap, and the shared session takes on its queue, history and settings. Whatever another device was playing stops. Hide this option when the own session has nothing in it (no current track and an empty queue); the server would refuse it with `nothing_to_bring`.

Neither asks for confirmation, but **Rejoin** discards a queue, so when this device is playing, show its result on the status line (web) or in the notice (iOS) with the track that stopped: **Rejoined your other devices** / *Stopped "Song title".* The queue it discarded is not recoverable; that is acceptable because detached queues are scratch space by design.

Errors use the detach table above, with "Couldn't rejoin. Try again." in place of "Couldn't play separately."

## Other devices see it

Every device lists the user's live devices (open and answering the server; see "Presence" in the session contract), so a detached device that goes away leaves the list like any other and is back when it reconnects. A detached one:

- is **not** a transfer target (its `canPlay` is false; the server refuses transfers to it), so it never appears among the devices you can move playback to;
- appears in its own group under the list, **Playing separately**, one row per device: its icon and name, and as subtitle the track it plays (look up `detached.trackId` with the app's track store) followed by "· Paused" when `detached.playing` is false. A row with no track says *Nothing playing*. The rows are not pressable.

This group is how a user who wonders "why didn't the kitchen change?" finds the answer, so show it whenever any device is detached, even if this device is not.

The released iOS app (before this feature) already behaves acceptably: it filters out devices with `canPlay: false`, so detached devices simply don't appear there, and the server never lets it transfer to one.

## Coming back later

The server remembers a detached device:

- **Reload, relaunch, network drop, server restart:** the device comes back detached, with its own queue. No message is needed; the marker is enough.
- **Away more than seven days:** the server forgets the own session and the device comes back in the shared session. The apps already say this (`onDetachedEnded`): web on the player's status line, *Playing with your other devices again* / *This tab was away for over a week, so its own queue was cleared.*; iOS the same in its notice style.

A web device is one tab (`claimTabDevice`), so detaching one tab does not detach the others. Lists fold a browser's tabs into one row (client-core `listedDevices`), but never detached ones: each plays its own queue and is listed under "Playing separately".

## Not in scope

- Several devices playing the same thing in sync. Deliberately left out.
- Naming or grouping detached sessions, or moving a detached session to another device. A detached session belongs to exactly one device.
- A setting to turn the feature off. The controls stay out of the way in the devices picker.

## Checklist for the implementing pull requests

- Marker in the player bar or mini player and now playing, hidden when `!detached`.
- Detach row in the devices picker, hidden when `!canDetach`.
- Detached picker with Rejoin and Bring this queue with me, the latter hidden when there is nothing to bring.
- "Playing separately" group on every device.
- The status line (web) or notice (iOS) for success and each error.
- Screenshots of each state in the pull request, in light and dark.
- The user guides ([web](./use/web.md), [iOS](./use/ios.md)) get a short "Playing separately on one device" section, and [Devices and transferring playback](./server/playback.md#devices-and-transferring-playback) a sentence pointing at it.
