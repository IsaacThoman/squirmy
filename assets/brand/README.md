# Brand assets

Squirmy's mascot is an earthworm, modelled and rendered in Blender by
`build-earthworm.py`. `install-app-icon.py` copies the renders into place:

| File | Use |
| --- | --- |
| `apps/mobile/assets/Squirmy.icon` | iOS icon (Icon Composer): `earthworm-body.png` with `earthworm-face.png` on top as a glass layer. Fill is `#f4f0fc` in light mode, `#1d1929` in dark. |
| `apps/mobile/assets/icon.png` | Flattened headshot on `#1d1929`. Expo's default icon. |
| `apps/mobile/assets/adaptive-icon.png` | Android adaptive icon foreground, on `#f4f0fc`. |
| `apps/web/public/squirmy-mark.png`, `squirmy-mark-64.png` | In-app logo: the simplified head on a transparent background. |
| `apps/web/public/favicon.ico` | 16, 32 and 48 px, from the simplified head on `#1d1929`. |
| `apps/web/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | The headshot on `#1d1929`. |
| `docs/public/` | Copies of the mark, `favicon.ico` and `apple-touch-icon.png` for the docs site. |

The simplified head (`--simple`) has bigger eyes and smile and fainter rings, so
it still reads at 24 px.

To regenerate everything, from the repository root (needs Blender, and on macOS
`sips` and `pngquant`):

```sh
blender --background --python-exit-code 1 \
  --python assets/brand/build-earthworm.py -- --size 2048 --samples 512 \
  --only earthworm-icon,earthworm-icon-body,earthworm-icon-face,earthworm-android-foreground
blender --background --python-exit-code 1 \
  --python assets/brand/build-earthworm.py -- --simple --size 1024 --samples 512
python3 assets/brand/install-app-icon.py
```

Renders go to `renders/`, which is not committed. Leave out `--only` to also
render full-body previews there. Open `Squirmy.icon` in Icon Composer to adjust
the glass, shadow or layer settings.
