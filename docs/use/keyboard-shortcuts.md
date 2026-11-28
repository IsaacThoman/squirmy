# Keyboard shortcuts

The web app's shortcuts, from `apps/web/src/player/shortcuts.ts`, the app shell (`apps/web/src/components/layout/AppShell.tsx`) and its components. Press **?** anywhere in the app for the same list, and **Settings → About** lists the main ones.

## Anywhere

These work on every page once you are signed in, also while you type in a field. The key is Cmd (⌘) on a Mac and Ctrl elsewhere.

| Key | Action |
|---|---|
| Ctrl+K or ⌘K | Open [search and commands](./web.md#search-and-commands), or close it |
| Ctrl+F or ⌘F | Open search and commands. Pressed again while it is open, it is the browser's own Find |
| Ctrl+B or ⌘B | Fold the sidebar to its rail of icons, or open it again. On a phone it opens and closes the drawer |
| Ctrl+, or ⌘, | Open **Settings** |

## Player

These work anywhere in the app, as long as the focused element does not use the key itself: a text field keeps its arrows and Space, a slider keeps its arrows, anything in a list (the queue and its history, a track list, the lyrics), a menu or a grid keeps its arrows, a focused button or link keeps Space, and an open dialog (Settings, say) keeps them all; Now Playing and the floating queue, parts of the player, do not. With Ctrl, Alt or Cmd held, these keys are left to the browser.

| Key | Action |
|---|---|
| Space | Play or pause |
| ← | Seek back 5 seconds |
| → | Seek forward 5 seconds |
| Shift+← | Previous song |
| Shift+→ | Next song |
| ↑ | Volume up (5%) on the device that is playing |
| ↓ | Volume down (5%) on the device that is playing |

Play, pause, seeking and skipping need something in the session. The volume keys change the volume of whichever device plays, so they work as a remote too. Browsers and operating systems with media keys also control the player through the Media Session API while this tab plays.

## Letter keys

One key each, with no Ctrl, Alt or Cmd. They work anywhere but where letters are typed or pick something: a text field, a menu, a list of options (the search box's results) and a dialog other than Now Playing. Held down, a key acts once.

| Key | Action |
|---|---|
| M | Mute, or give the device that plays its volume back |
| S | Shuffle on or off |
| R | Repeat: off, all, one, off again |
| L | Save the song playing to your library, or remove it |
| Q | Show or hide the queue (on a phone, Now Playing's queue) |
| Y | Show or hide the lyrics |
| / | Open search and commands |
| ? | List every shortcut |

While [Now Playing](./web.md#playing-music) is open, Q shows its queue, as on a phone, rather than the queue panel it covers.

## Now Playing

The player keys and the letter keys work here too.

| Key | Action |
|---|---|
| F | Go into [full screen](./web.md#playing-music), or leave it |
| Escape | Leave full screen; otherwise close Now Playing |
| Enter | In full screen, on the screen itself: play or pause |
| ← / → | In full screen, on the transport: move to the button before or after |
| Q / Y | In full screen: leave it for Now Playing's queue or lyrics |

In full screen, while the controls are hidden, the first key only brings them back. A right-click on the cover, there and in Now Playing, opens the song's menu; while it is open, Escape and the letters belong to the menu.

## Search and commands

| Key | Action |
|---|---|
| ↑ / ↓ | Move through the results and commands, or through the places to go and the commands when nothing is typed |
| Enter | Open the highlighted artist, album or place, play the highlighted song, or run the highlighted command |
| > first | List commands alone, as `>shuffle` |
| Escape | Close it |

## Song lists

In an album, a playlist, Liked Songs, an artist's top songs, your songs and Up next in the queue. On the search page and in the queue a click plays a song, so there songs are picked with ⌘/Ctrl-click and Shift-click alone.

| Key | Action |
|---|---|
| Click | Pick a song (with a mouse; a tap plays it) |
| Ctrl-click or ⌘-click | Add a song to what is picked, or take it out |
| Shift-click | Pick every song from the last one clicked to this one |
| ↑ / ↓ | Move to the song above or below (in the queue: move the song itself) |
| Shift+↑ / Shift+↓ | Pick the songs from the first one picked to the one above or below |
| Ctrl+A or ⌘A | Pick every song in the list, from inside it or from the page around it |
| Escape | Let go of the songs picked |
| Double-click | Play a song |
| Context menu key, or Shift+F10 | Open the focused song's menu (the picked songs' menu, when it is one of them) |

## Sidebar

| Where | Key | Action |
|---|---|---|
| The sidebar's right edge, focused with Tab | ← / → | Make the sidebar narrower or wider |
| The sidebar's right edge, focused with Tab | Enter | Fold the sidebar, or open it again |
| The open drawer, on a phone | Escape | Close it |

## Fields and other places

| Where | Key | Action |
|---|---|---|
| A search field | Escape | Clear it |
| Settings → Playback, **This browser's name** | Enter | Save the name |
| Admin folder picker, path field | Enter | Open the typed path |
| Admin server settings, a text field | Enter | Save the value |
| The pop-out player's window | Space | Play or pause |

There are no other single-key shortcuts.
