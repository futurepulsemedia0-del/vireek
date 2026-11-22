#!/usr/bin/env python3
"""Guards Vireek's app-tile icon set (needs Pillow only):  python3 scripts/brand/test_tile_icons.py

1. The generator (render_tile_icons.py) produces every icon with the right size, colours and transparency.
2. The icons committed in the repo are pixel-identical to what the generator produces now, so nobody can hand-edit one or
   forget to regenerate after a logo change.
3. public/brand/vireek-tile.svg still carries the documented colours (Clay tile, Slate V, Ivory dot).
"""
import os, re, subprocess, sys, tempfile, unittest
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CLAY, SLATE, IVORY = (217, 119, 87), (20, 20, 19), (250, 249, 245)
SIZES = {
    'public/icons/icon-192.png': 192, 'public/icons/icon-512.png': 512, 'public/icons/maskable-192.png': 192, 'public/icons/maskable-512.png': 512,
    'public/icons/monochrome-512.png': 512, 'public/icons/monochrome-96.png': 96, 'public/apple-touch-icon.png': 180, 'public/favicon-96x96.png': 96,
    'public/web-app-manifest-192x192.png': 192, 'public/web-app-manifest-512x512.png': 512, 'public/mstile-150x150.png': 150,
    'chrome-extension/icons/icon.png': 128, 'public/icons/shortcut-jobs-96.png': 96, 'public/icons/shortcut-calls-96.png': 96, 'public/icons/shortcut-inbox-96.png': 96,
}
OUT = tempfile.mkdtemp(prefix='vireek-icons-')
subprocess.run([sys.executable, os.path.join(ROOT, 'scripts/brand/render_tile_icons.py'), '--out', OUT], check=True, stdout=subprocess.DEVNULL)


def pixels(im):
    """Flat pixel list (works on old Pillow and on >= 12 where getdata() is deprecated)."""
    return list(getattr(im, 'get_flattened_data', im.getdata)())


def load(rel, base=OUT):
    return Image.open(os.path.join(base, rel)).convert('RGBA')


class Generated(unittest.TestCase):
    def test_every_icon_exists_with_the_right_size(self):
        for rel, size in SIZES.items():
            with self.subTest(rel):
                self.assertEqual(load(rel).size, (size, size))

    def test_rounded_tiles_are_clay_with_transparent_corners(self):
        for rel in ('public/icons/icon-512.png', 'public/icons/icon-192.png', 'public/favicon-96x96.png', 'chrome-extension/icons/icon.png'):
            with self.subTest(rel):
                im = load(rel); w = im.size[0]
                self.assertEqual(im.getpixel((0, 0))[3], 0, 'corner must be transparent')
                self.assertEqual(im.getpixel((int(w * 0.07), w // 2))[:3], CLAY, 'tile fill must be exactly Clay #D97757')

    def test_full_bleed_icons_are_opaque_clay(self):
        for rel in ('public/icons/maskable-512.png', 'public/icons/maskable-192.png', 'public/apple-touch-icon.png', 'public/mstile-150x150.png'):
            with self.subTest(rel):
                im = load(rel)
                self.assertEqual(im.getpixel((0, 0)), CLAY + (255,))
                self.assertEqual(im.getchannel('A').getextrema(), (255, 255), 'must be fully opaque')

    def test_apple_touch_icon_has_no_alpha_channel(self):
        self.assertEqual(Image.open(os.path.join(OUT, 'public/apple-touch-icon.png')).mode, 'RGB')

    def test_symbol_colours_are_slate_v_and_ivory_dot(self):
        im = load('public/icons/icon-512.png'); px = set(pixels(im))
        self.assertIn(SLATE + (255,), px); self.assertIn(IVORY + (255,), px)

    def test_monochrome_icons_are_white_on_transparent(self):
        for rel in ('public/icons/monochrome-512.png', 'public/icons/monochrome-96.png'):
            with self.subTest(rel):
                opaque = [p for p in pixels(load(rel)) if p[3] == 255]
                self.assertTrue(opaque)
                self.assertTrue(all(p[:3] == (255, 255, 255) for p in opaque))

    def test_maskable_symbol_stays_inside_the_safe_zone(self):
        im = load('public/icons/maskable-512.png'); w = im.size[0]
        dark = [(i % w, i // w) for i, p in enumerate(pixels(im)) if p[:3] in (SLATE, IVORY)]
        c = w / 2
        self.assertTrue(max(((x - c) ** 2 + (y - c) ** 2) ** 0.5 for x, y in dark) <= 0.40 * w, 'symbol leaves the 40% safe-zone circle')

    def test_favicon_ico_has_16_32_48(self):
        self.assertEqual(sorted(Image.open(os.path.join(OUT, 'public/favicon.ico')).info['sizes']), [(16, 16), (32, 32), (48, 48)])


class CommittedFiles(unittest.TestCase):
    def test_repo_icons_match_the_generator_pixel_for_pixel(self):
        for rel in SIZES:
            with self.subTest(rel):
                p = os.path.join(ROOT, rel)
                self.assertTrue(os.path.exists(p), f'{rel} is missing: run python3 scripts/brand/render_tile_icons.py')
                self.assertEqual(load(rel, ROOT).tobytes(), load(rel).tobytes(), f'{rel} is stale: run python3 scripts/brand/render_tile_icons.py')

    def test_repo_favicon_ico_matches_generator(self):
        a = Image.open(os.path.join(ROOT, 'public/favicon.ico')); b = Image.open(os.path.join(OUT, 'public/favicon.ico'))
        self.assertEqual(sorted(a.info['sizes']), sorted(b.info['sizes']))

    def test_tile_svg_uses_the_documented_colours(self):
        svg = open(os.path.join(ROOT, 'public/brand/vireek-tile.svg'), encoding='utf-8').read()
        fills = re.findall(r'fill="(#[0-9A-Fa-f]{6})"', svg)
        self.assertEqual([f.upper() for f in fills], ['#D97757', '#141413', '#FAF9F5'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
