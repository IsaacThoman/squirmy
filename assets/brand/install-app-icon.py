"""Copy the rendered googly worm into the app, web and docs icon files.

Needs macOS (sips) and pngquant. Render first (see README.md), then from the
repository root:
    python3 assets/brand/install-app-icon.py
"""

from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
RENDERS = HERE / 'renders'
MOBILE = ROOT / 'apps' / 'mobile' / 'assets'
WEB = ROOT / 'apps' / 'web' / 'public'
DOCS = ROOT / 'docs' / 'public'
SRGB = '/System/Library/ColorSync/Profiles/sRGB Profile.icc'


def tag_srgb(path):
    """Blender writes untagged PNGs. Tag them sRGB so Icon Composer and
    browsers don't guess a different colour space."""
    subprocess.run(['sips', '--embedProfile', SRGB, str(path)], check=True, capture_output=True)


def resize(source, size, destination, optimize=False):
    subprocess.run(['sips', '-z', str(size), str(size), str(source), '--out', str(destination)],
                   check=True, capture_output=True)
    if optimize:
        # Lossy palette quantisation keeps these web images small. Browsers
        # treat untagged PNGs as sRGB, so no profile is needed.
        subprocess.run(['pngquant', '--force', '--skip-if-larger', '--strip', '--quality', '70-95',
                        '--speed', '1', '--output', str(destination), str(destination)], check=True)
    else:
        tag_srgb(destination)


def write_ico(source, destination, sizes=(16, 32, 48)):
    """Windows-style icon with a PNG image per size."""
    with tempfile.TemporaryDirectory() as tmp:
        images = []
        for size in sizes:
            png = Path(tmp) / f'{size}.png'
            resize(source, size, png)
            images.append((size, png.read_bytes()))
    offset = 6 + 16 * len(images)
    header = struct.pack('<HHH', 0, 1, len(images))
    entries, data = b'', b''
    for size, png in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    destination.write_bytes(header + entries + data)


def main():
    icon = RENDERS / 'worm-icon.png'            # close-up of the head on the violet floor
    mark = RENDERS / 'worm-mark.png'            # the head alone, transparent
    small = RENDERS / 'worm-mark-bg.png'        # the head alone on the violet floor

    # iOS: Icon Composer layers, at the 1024 px canvas size. A larger render
    # adds nothing to the compiled icon and makes the files several times bigger.
    layers = MOBILE / 'Squirmy.icon' / 'Assets'
    layers.mkdir(parents=True, exist_ok=True)
    for render, layer in (('worm-icon-body.png', 'worm-body.png'),
                          ('worm-icon-face.png', 'worm-face.png')):
        resize(RENDERS / render, 1024, layers / layer)

    # Expo's default icon, and the Android adaptive icon foreground.
    resize(icon, 1024, MOBILE / 'icon.png')
    resize(RENDERS / 'worm-android-foreground.png', 1024, MOBILE / 'adaptive-icon.png')
    # iOS splash screen and in-app logo (sign-in screens, the account sheet).
    resize(mark, 512, MOBILE / 'splash-icon.png', optimize=True)
    resize(mark, 256, MOBILE / 'squirmy-mark.png', optimize=True)

    # Web app: in-app logo and favicons.
    resize(mark, 256, WEB / 'squirmy-mark.png', optimize=True)
    resize(mark, 64, WEB / 'squirmy-mark-64.png', optimize=True)
    write_ico(small, WEB / 'favicon.ico')
    resize(icon, 192, WEB / 'icon-192.png', optimize=True)
    resize(icon, 512, WEB / 'icon-512.png', optimize=True)
    resize(icon, 180, WEB / 'apple-touch-icon.png', optimize=True)

    # Docs site: logo and favicons.
    DOCS.mkdir(parents=True, exist_ok=True)
    for name in ('squirmy-mark.png', 'favicon.ico', 'apple-touch-icon.png'):
        shutil.copyfile(WEB / name, DOCS / name)


if __name__ == '__main__':
    main()
