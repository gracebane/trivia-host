#!/usr/bin/env python3
"""ega.py — turn any image into 16-colour EGA pixel art (Monkey Island 1990 look).

    python3 assets/ega.py assets/originals/photo.jpg      # → assets/ega/photo.ega.png, 320 wide, ordered dither, 3× pixels
    python3 assets/ega.py photo.jpg -o out.png --width 160 --scale 4
    python3 assets/ega.py photo.jpg --dither fs           # Floyd–Steinberg instead of the checkerboard
    python3 assets/ega.py photo.jpg --aspect              # 320×200-on-a-4:3-monitor tall pixels
    python3 assets/ega.py *.png --bright 1.3 --contrast 1.2 --sat 1.3   # lift a dark photo first; EGA likes bold colour

Layout: assets/originals/ holds source photos, assets/ega/ holds renders (the
default output folder when -o is not given). A bar-photo preset that worked:
    --sat 1.6 --contrast 1.15 --spread 0.22 --matrix 4

Pipeline: shrink to the target width (box filter, so detail averages out instead
of aliasing) → optional contrast / saturation → snap every pixel to the nearest
of the 16 EGA colours with dithering → blow back up with hard, square pixels.

Ordered (Bayer) dithering is the one that reads as "EGA game": the palette has
no mid-tones, so skies and water become regular two-colour checkerboards, which
is exactly what LucasArts' artists hand-drew. Floyd–Steinberg looks more like a
photo that has been posterised. `--spread` controls how hard the dither pushes.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance

OUT_DIR = Path(__file__).resolve().parent / "ega"  # default output folder

# The IBM EGA default 16-colour palette, index order 0–15.
EGA = np.array(
    [
        (0x00, 0x00, 0x00),  # 0 black
        (0x00, 0x00, 0xAA),  # 1 blue
        (0x00, 0xAA, 0x00),  # 2 green
        (0x00, 0xAA, 0xAA),  # 3 cyan
        (0xAA, 0x00, 0x00),  # 4 red
        (0xAA, 0x00, 0xAA),  # 5 magenta
        (0xAA, 0x55, 0x00),  # 6 brown
        (0xAA, 0xAA, 0xAA),  # 7 light grey
        (0x55, 0x55, 0x55),  # 8 dark grey
        (0x55, 0x55, 0xFF),  # 9 light blue
        (0x55, 0xFF, 0x55),  # 10 light green
        (0x55, 0xFF, 0xFF),  # 11 light cyan
        (0xFF, 0x55, 0x55),  # 12 light red
        (0xFF, 0x55, 0xFF),  # 13 light magenta
        (0xFF, 0xFF, 0x55),  # 14 yellow
        (0xFF, 0xFF, 0xFF),  # 15 white
    ],
    dtype=np.float32,
)

# 8×8 Bayer threshold matrix, values 0..63, as a 0..1 map centred on 0.
_B2 = np.array([[0, 2], [3, 1]])


def bayer(n):
    m = _B2
    while m.shape[0] < n:
        m = np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
    return (m + 0.5) / (n * n) - 0.5


def nearest(px):
    """px: (..., 3) float RGB → (...,) palette index. Plain RGB distance, with
    green weighted up a little (the eye is more sensitive to it)."""
    w = np.array([0.30, 0.59, 0.11], dtype=np.float32) * 3
    d = ((px[..., None, :] - EGA) ** 2 * w).sum(-1)
    return d.argmin(-1)


def ordered(img, spread, size):
    a = np.asarray(img, dtype=np.float32)
    h, w = a.shape[:2]
    t = bayer(size)
    tile = np.tile(t, (h // size + 1, w // size + 1))[:h, :w]
    a = a + tile[..., None] * spread * 255
    return nearest(np.clip(a, 0, 255))


def floyd_steinberg(img):
    a = np.asarray(img, dtype=np.float32).copy()
    h, w = a.shape[:2]
    out = np.zeros((h, w), dtype=np.int64)
    for y in range(h):
        for x in range(w):
            old = a[y, x]
            i = nearest(np.clip(old, 0, 255))
            out[y, x] = i
            err = old - EGA[i]
            if x + 1 < w:
                a[y, x + 1] += err * 7 / 16
            if y + 1 < h:
                if x > 0:
                    a[y + 1, x - 1] += err * 3 / 16
                a[y + 1, x] += err * 5 / 16
                if x + 1 < w:
                    a[y + 1, x + 1] += err * 1 / 16
    return out


def convert(src, width=320, dither="ordered", spread=0.35, matrix=8, scale=3, aspect=False, contrast=1.0, sat=1.0, bright=1.0):
    img = src.convert("RGB")
    # EGA's 320×200 was shown on a 4:3 monitor, so each pixel was 1.2× taller
    # than wide. Squash vertically before quantising, stretch back on output.
    h = round(img.height * width / img.width * (5 / 6 if aspect else 1))
    img = img.resize((width, max(1, h)), Image.Resampling.BOX)
    if bright != 1.0:
        img = ImageEnhance.Brightness(img).enhance(bright)
    if contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(contrast)
    if sat != 1.0:
        img = ImageEnhance.Color(img).enhance(sat)

    if dither == "none":
        idx = nearest(np.asarray(img, dtype=np.float32))
    elif dither == "fs":
        idx = floyd_steinberg(img)
    else:
        idx = ordered(img, spread, matrix)

    out = Image.fromarray(EGA[idx].astype(np.uint8), "RGB")
    if scale != 1 or aspect:
        out = out.resize((out.width * scale, round(out.height * scale * (6 / 5 if aspect else 1))), Image.Resampling.NEAREST)
    return out


def main():
    ap = argparse.ArgumentParser(description="Convert images to 16-colour EGA pixel art.")
    ap.add_argument("images", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path, help=f"output file (single input) or folder (several); default {OUT_DIR}")
    ap.add_argument("--width", type=int, default=320, help="pixel width before upscaling (EGA was 320)")
    ap.add_argument("--dither", choices=["ordered", "fs", "none"], default="ordered")
    ap.add_argument("--spread", type=float, default=0.35, help="ordered-dither strength, 0–1 (bigger = busier checkerboards)")
    ap.add_argument("--matrix", type=int, choices=[2, 4, 8], default=8, help="Bayer matrix size; 2 or 4 is coarser and more retro")
    ap.add_argument("--scale", type=int, default=3, help="integer upscale so the pixels are visible")
    ap.add_argument("--aspect", action="store_true", help="simulate the 4:3 monitor's tall pixels")
    ap.add_argument("--bright", type=float, default=1.0, help="brightness multiplier; >1 lifts dark photos before quantising")
    ap.add_argument("--contrast", type=float, default=1.0)
    ap.add_argument("--sat", type=float, default=1.0, help="saturation multiplier")
    a = ap.parse_args()

    if len(a.images) > 1 and a.out and a.out.suffix:
        sys.exit("--out must be a folder when converting several images")
    for src in a.images:
        if not src.exists():
            print(f"skip (missing): {src}", file=sys.stderr)
            continue
        if a.out and (len(a.images) == 1 and a.out.suffix):
            dst = a.out
        else:
            folder = a.out or OUT_DIR
            folder.mkdir(parents=True, exist_ok=True)
            dst = folder / f"{src.stem}.ega.png"
        with Image.open(src) as im:
            out = convert(im, a.width, a.dither, a.spread, a.matrix, a.scale, a.aspect, a.contrast, a.sat, a.bright)
        out.save(dst)
        print(f"{src.name} → {dst}  ({out.width}×{out.height}, {a.dither})")


if __name__ == "__main__":
    main()
