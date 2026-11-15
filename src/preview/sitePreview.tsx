// R20-D: the sandboxed preview of a website write_website built. The core
// decides a file qualifies (src-tauri/src/site_preview.rs) and serves its
// bytes from its own scheme with a no-network CSP header; here the frame
// is sandboxed with scripts only. Never allow-same-origin: the site gets
// an opaque origin, so its scripts reach neither this app's DOM, nor its
// storage, nor its cookies, nor the Tauri bridge.
//
// jsdom has no real frames, origins or CSP, so the tests pin the sandbox
// attribute, the core's flag and the policy text. Release checklist (real
// app, every OS): build a site with write_website whose script tries
//   1. window.parent.document / window.top.__TAURI_INTERNALS__ (must throw
//      a SecurityError: opaque origin),
//   2. window.__TAURI_INTERNALS__.invoke("profiles_load") and
//      fetch("ipc://localhost/profiles_load") / fetch("http://ipc.localhost/profiles_load")
//      (no bridge in the frame; fetch blocked by connect-src 'none'),
//   3. localStorage / document.cookie (SecurityError),
//   4. fetch("https://example.com") and new Image().src = "https://example.com/x.png"
//      (CSP violations in the console, no request leaves the machine),
// and check its inline styles, data: images and scripts DO render and run.
// Also open nan-site://localhost/<token> as a top-level URL from devtools:
// the CSP header's sandbox directive keeps it an opaque origin there too.

import { useT } from "../i18n";

/// The one sandbox token the site frame gets. Adding allow-same-origin
/// (or any other token) would break the isolation the caption promises.
export const SITE_SANDBOX = "allow-scripts";

export function SitePreview({ url, name }: { url: string; name: string }) {
  const t = useT();
  return (
    <figure className="preview-site">
      <figcaption className="preview-note preview-site-caption">{t.preview.siteCaption}</figcaption>
      <iframe
        className="preview-site-frame"
        src={url}
        sandbox={SITE_SANDBOX}
        referrerPolicy="no-referrer"
        title={t.preview.siteFrame(name)}
      />
    </figure>
  );
}
