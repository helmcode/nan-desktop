#!/usr/bin/env python3
"""Compose the Helmcode Desktop icon source on Apple's macOS icon grid.

Apple's macOS template: a 1024x1024 canvas where the squircle card occupies
about 824x824 centered (~10% margin per side), corner radius ~185px, and the
glyph inside at ~55-60% of the card. The card sits on a TRANSPARENT canvas:
macOS renders the shape as-is (no automatic mask).

Usage: python3 scripts/make-icons.py [symbol.png] [out.png]
Defaults to the committed brand symbols and src icon path used by
`pnpm exec tauri icon <out>` afterwards.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

CANVAS = 1024
CARD = 824          # squircle side (Apple grid: ~824/1024)
RADIUS = 185        # Apple's squircle corner radius on this grid
GLYPH_RATIO = 0.58  # symbol width relative to the card

REPO = Path(__file__).resolve().parent.parent
SYMBOL_MORADO = REPO / "scripts/brand/simbolo-morado.png"
SYMBOL_BLANCO = REPO / "scripts/brand/simbolo-blanco.png"

# Brand card: accent gradient, dark enough for the white symbol.
CARD_TOP = (73, 52, 225)    # #4934E1
CARD_BOTTOM = (55, 38, 184)  # #3726B8


def gradient_card(size: int) -> Image.Image:
    """The rounded-square card with a vertical brand gradient."""
    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(CARD_TOP[0] + (CARD_BOTTOM[0] - CARD_TOP[0]) * t)
        g = int(CARD_TOP[1] + (CARD_BOTTOM[1] - CARD_TOP[1]) * t)
        b = int(CARD_TOP[2] + (CARD_BOTTOM[2] - CARD_TOP[2]) * t)
        grad.putpixel((0, y), (r, g, b, 255))
    grad = grad.resize((size, size))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=RADIUS, fill=255
    )
    card.paste(grad, (0, 0), mask)
    return card


def pick_symbol() -> Image.Image:
    """The white symbol: correct contrast on the accent card (the purple
    variant would sink into it)."""
    symbol = Image.open(SYMBOL_BLANCO).convert("RGBA")
    return symbol


def main() -> int:
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / "scripts/brand/icon-source.png"
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    offset = (CANVAS - CARD) // 2
    card = gradient_card(CARD)
    canvas.paste(card, (offset, offset), card)

    symbol = pick_symbol()
    target = int(CARD * GLYPH_RATIO)
    scale = target / symbol.width
    symbol = symbol.resize((target, int(symbol.height * scale)), Image.LANCZOS)
    # Center the glyph on the CARD (not the canvas).
    cx = offset + (CARD - symbol.width) // 2
    cy = offset + (CARD - symbol.height) // 2
    canvas.paste(symbol, (cx, cy), symbol)

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "PNG")
    print(f"icon source written: {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
