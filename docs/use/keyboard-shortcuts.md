# Keyboard shortcuts

The web app's shortcuts, from `apps/web/src/player/shortcuts.ts` and its components.

## Player

These work anywhere in the app, as long as the focused element does not use the key itself: a text field keeps its arrows and Space, a slider keeps its arrows, and a focused button or link keeps Space. Shortcuts with Ctrl, Alt or Cmd held are left to the browser.

| Key | Action |
|---|---|
| Space | Play or pause |
| ← | Seek back 5 seconds |
| → | Seek forward 5 seconds |
| ↑ | Volume up (5%) on the device that is playing |
| ↓ | Volume down (5%) on the device that is playing |

Play, pause and seeking need something in the session. The volume keys change the volume of whichever device plays, so they work as a remote too. Browsers and operating systems with media keys also control the player through the Media Session API while this tab plays.

## Lists and fields

| Where | Key | Action |
|---|---|---|
| Queue, on a song's reorder handle | ↑ / ↓ | Move the song up or down one place |
| The desktop workspace | ⌘ K / Ctrl K | Focus the search field |
| A search field | Escape | Clear it |
| Management folder picker, path field | Enter | Open the typed path |
| Management server settings, a text field | Enter | Save the value |

There are no other single-key shortcuts yet.
