#!/usr/bin/env python3
"""Build the Windows icon (src-tauri/icons/icon.ico) with every frame size.

A single 256px frame makes Windows downscale it for the taskbar, title bar,
Explorer lists and the installer (blurry or wrong at 16/24/32). This writes
one frame per size Windows asks for, each resampled from the 1024px brand
source with its alpha channel intact, then verifies the result:

  - frames: 16, 24, 32, 48, 64, 128, 256 (exactly)
  - every frame is RGBA, and the 16px frame's corners are fully transparent
    (the squircle card sits on a transparent canvas)

Only icon.ico is touched: the macOS .icns and the PNGs stay as they are.

Usage:
  python3 scripts/make-ico.py            # build + verify
  python3 scripts/make-ico.py --check    # verify the committed icon.ico only
"""

import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "scripts/brand/icon-source.png"
ICO = REPO / "src-tauri/icons/icon.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]


def build() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height or source.width < 256:
        raise SystemExit(f"{SOURCE} must be square and >= 256px, got {source.size}")
    # Pillow resamples each frame from the full-size source (LANCZOS).
    source.save(ICO, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"wrote {ICO} ({ICO.stat().st_size} bytes)")


def frame(size: int) -> Image.Image:
    ico = Image.open(ICO)
    ico.size = (size, size)  # selects the frame of that size
    ico.load()
    return ico.convert("RGBA") if ico.mode != "RGBA" else ico


def check() -> None:
    sizes = sorted(w for (w, h) in Image.open(ICO).info["sizes"] if w == h)
    if sizes != SIZES:
        raise SystemExit(f"icon.ico frames are {sizes}, expected {SIZES}")
    for size in SIZES:
        img = frame(size)
        if img.size != (size, size):
            raise SystemExit(f"frame {size}: decoded as {img.size}")
        if img.getextrema()[3][0] != 0:
            raise SystemExit(f"frame {size}: no transparent pixel (alpha lost)")
    small = frame(16)
    corners = [(0, 0), (15, 0), (0, 15), (15, 15)]
    alphas = [small.getpixel(c)[3] for c in corners]
    if any(a != 0 for a in alphas):
        raise SystemExit(f"16px frame corners are not transparent: alpha {alphas}")
    center = small.getpixel((8, 8))[3]
    if center == 0:
        raise SystemExit("16px frame is empty in the center")
    print(f"icon.ico ok: frames {sizes}, 16px corners alpha {alphas}, center alpha {center}")


def main() -> int:
    if "--check" not in sys.argv[1:]:
        build()
    check()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
