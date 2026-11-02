// Brand marks (S18). The SVGs in src/assets/brand/ are the single source of
// the logo and symbol: replacing those files updates every surface (login,
// sidebar, about, empty state). Assets are emitted as same-origin files
// (vite assetsInlineLimit: 0) because the CSP forbids data: images.

import logoUrl from "./assets/brand/helmcode-logo-white.svg";
import symbolUrl from "./assets/brand/helmcode-symbol-color.svg";

export const BRAND_ASSETS = { logo: logoUrl, symbol: symbolUrl } as const;

/// The Helmcode symbol. Decorative by default (the product name is always
/// next to it); pass a label when it stands alone.
export function BrandMark({ size = 28, label }: { size?: number; label?: string }) {
  return (
    <img
      className="brand-mark"
      src={symbolUrl}
      height={size}
      width={size * (115 / 157)}
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      draggable={false}
    />
  );
}

/// The full Helmcode logo (symbol + wordmark).
export function BrandLogo({ height = 40, label }: { height?: number; label: string }) {
  return <img className="brand-logo" src={logoUrl} height={height} alt={label} draggable={false} />;
}
