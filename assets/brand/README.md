# Brand assets

Squirmy's mascot is a googly worm: a plush pink worm shaped like an S, with
matte googly eyes that look at you, on a violet floor. It is modelled and
rendered in Blender by `build-worm.py`. `install-app-icon.py` copies the renders
into place:

| File | Use |
| --- | --- |
| `apps/mobile/assets/Squirmy.icon` | iOS icon (Icon Composer): `worm-body.png` with `worm-face.png` on top as a glass layer. Both are sharp and have no floor shadow, since Icon Composer adds its own. Fill is `#9d99d6`, the floor as rendered, in light mode and `#1d1929` in dark. |
| `apps/mobile/assets/icon.png` | Flattened close-up of the head on the violet floor. Expo's default icon. |
| `apps/mobile/assets/adaptive-icon.png` | Android adaptive icon foreground: the same view with the floor, framed wider so the safe zone shows the iOS crop. It is opaque, so the `#9d99d6` background is only a fallback. |
| `apps/mobile/assets/splash-icon.png`, `squirmy-mark.png` | iOS splash screen and in-app logo: the close-up as a rounded tile, transparent outside it. |
| `apps/web/public/squirmy-mark.png`, `squirmy-mark-64.png` | In-app logo: the head alone as a rounded tile, transparent outside it. The web shows the logo at 30 to 40 px, where the head keeps the eyes readable. |
| `apps/web/public/favicon.ico` | 16, 32 and 48 px, from the head alone on the violet floor. |
| `apps/web/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | The close-up on the violet floor. |
| `docs/public/` | Copies of the mark, `favicon.ico` and `apple-touch-icon.png` for the docs site. |

The icon, its layers and the favicon crop come from one view, cropped with the
camera's lens and lens shift, so they share a perspective. The head-only crop is
what keeps the eyes readable at favicon sizes and in the web app's sidebar. The
in-app marks are tiles with their corners rounded off rather than cut-outs, since
a transparent cut-out of the head shows the body cut off at the frame's edges.
The mobile app shows its mark at 44 pt and up, where the close-up's curve still
reads as a worm, so it keeps the close-up.

To regenerate everything, from the repository root (needs Blender, and on macOS
`sips` and `pngquant`):

```sh
blender --background --python-exit-code 1 \
  --python assets/brand/build-worm.py -- --size 2048 --samples 320
python3 assets/brand/install-app-icon.py
```

Renders go to `renders/`, which is not committed. `--only worm-icon,worm-mark`
renders just those files; `worm-mark` is made from `worm-icon.png` and
`worm-head-mark` from `worm-mark-bg.png`. Open `Squirmy.icon` in Icon Composer to adjust the
glass, shadow or layer settings.
