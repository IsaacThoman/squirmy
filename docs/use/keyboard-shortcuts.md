# Keyboard shortcuts

The web app's shortcuts, from `apps/web/src/player/shortcuts.ts`, the app shell (`apps/web/src/components/layout/AppShell.tsx`) and its components. **Settings → About** lists the main ones.

## Anywhere

These work on every page once you are signed in, also while you type in a field. The key is Cmd (⌘) on a Mac and Ctrl elsewhere.

| Key | Action |
|---|---|
| Ctrl+K or ⌘K | Open [quick search](./web.md#quick-search), or close it |
| Ctrl+B or ⌘B | Fold the sidebar to its rail of icons, or open it again. On a phone it opens and closes the drawer |
| Ctrl+, or ⌘, | Open **Settings** |

## Player

These work anywhere in the app, as long as the focused element does not use the key itself: a text field keeps its arrows and Space, a slider keeps its arrows, anything in a list (the queue and its history, a track list, the lyrics), a menu or a grid keeps its arrows, a focused button or link keeps Space, and an open dialog (Settings, say) keeps them all; Now Playing and the floating queue, parts of the player, do not. With Ctrl, Alt or Cmd held, these keys are left to the browser.

| Key | Action |
|---|---|
| Space | Play or pause |
| ← | Seek back 5 seconds |
| → | Seek forward 5 seconds |
| ↑ | Volume up (5%) on the device that is playing |
| ↓ | Volume down (5%) on the device that is playing |

Play, pause and seeking need something in the session. The volume keys change the volume of whichever device plays, so they work as a remote too. Browsers and operating systems with media keys also control the player through the Media Session API while this tab plays.

## Now Playing

| Key | Action |
|---|---|
| F | Go into [full screen](./web.md#playing-music), or leave it |
| Escape | Leave full screen; otherwise close Now Playing |
| Enter | In full screen, on the screen itself: play or pause |
| ← / → | In full screen, on the transport: move to the button before or after |

In full screen, while the controls are hidden, the first key only brings them back.

## Quick search

| Key | Action |
|---|---|
| ↑ / ↓ | Move through the results, or through the places to go when nothing is typed |
| Enter | Open the highlighted artist, album or place, or play the highlighted song |
| Escape | Close quick search |

## Sidebar

| Where | Key | Action |
|---|---|---|
| The sidebar's right edge, focused with Tab | ← / → | Make the sidebar narrower or wider |
| The sidebar's right edge, focused with Tab | Enter | Fold the sidebar, or open it again |
| The open drawer, on a phone | Escape | Close it |

## Lists and fields

| Where | Key | Action |
|---|---|---|
| Queue, on a song's reorder handle | ↑ / ↓ | Move the song up or down one place |
| A search field | Escape | Clear it |
| Settings → Playback, **This browser's name** | Enter | Save the name |
| Admin folder picker, path field | Enter | Open the typed path |
| Admin server settings, a text field | Enter | Save the value |

There are no other single-key shortcuts.
