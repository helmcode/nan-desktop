// Brand marks (S18). The SVGs in src/assets/brand/ are the single source of
// the logo and symbol: replacing those files updates every surface (login,
// sidebar, about, empty state). Assets are emitted as same-origin files
// (vite assetsInlineLimit: 0) because the CSP forbids data: images.

import logoUrl from "./assets/brand/helmcode-logo-white.svg";
import symbolUrl from "./assets/brand/helmcode-symbol-color.svg";

export const BRAND_ASSETS = { logo: logoUrl, symbol: symbolUrl } as const;

/// Named tile sizes (px) for the symbol. Surfaces pick a variant, never an
/// ad-hoc pixel size, so the mark stays consistent everywhere:
/// - `sm`: sidebar, next to body text (text height).
/// - `md`: Settings "About" row.
/// - `lg`: preview link-out card.
/// - `xl`: chat empty state.
/// The pixel values live in App.css (`.brand-mark--<size>`); this map mirrors
/// them for tests and for anyone sizing neighbouring elements.
export const BRAND_MARK_SIZES = { sm: 20, md: 28, lg: 32, xl: 40 } as const;
export type BrandMarkSize = keyof typeof BRAND_MARK_SIZES;

/// The Helmcode symbol inside a rounded tile (one corner-radius ratio at
/// every size, like the avatar and the chips). The official symbol is tall
/// (115x157), so the tile is square and the glyph keeps its aspect ratio
/// inside it. Decorative by default (the product name is always next to it);
/// pass a label when it stands alone.
export function BrandMark({ size = "sm", label }: { size?: BrandMarkSize; label?: string }) {
  return (
    <span
      className={`brand-mark brand-mark--${size}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <img src={symbolUrl} alt="" draggable={false} />
    </span>
  );
}

/// The full Helmcode logo (symbol + wordmark).
export function BrandLogo({ height = 40, label }: { height?: number; label: string }) {
  return <img className="brand-logo" src={logoUrl} height={height} alt={label} draggable={false} />;
}
