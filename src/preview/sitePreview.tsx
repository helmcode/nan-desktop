// R20-D: the sandboxed preview of a website write_website built; R22: of
// ANY HTML file the user previews (an ephemeral "document" token the pane
// releases on close). The core decides a file qualifies and its class
// (src-tauri/src/site_preview.rs) and serves its bytes from its own scheme
// with a no-network CSP header; here the frame is sandboxed with scripts
// only. Not srcdoc: it would inherit the APP's CSP (inline scripts blocked
// in release, the app's network allowances instead of none). Never allow-same-origin: the site gets
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
// R22 (user HTML, real app, every OS): grant a folder and preview
//   5. a large styled report (~160 KB, e.g. deepinfer.html) - it renders
//      as a page (styles, tables), whole, scrolls to its last line;
//   6. a user .html running the probes 1-4 above - same results as a
//      tool website (the isolation does not depend on the marker);
//   7. a page with <a href="https://..."> and target=_blank links and
//      <form action>: clicking opens nothing (no popups, no forms, no top
//      navigation); external <img src="https://..."> and <link> CSS show
//      nothing and send no request;
//   8. close the pane, then load the old nan-site URL from devtools: 404
//      (the document token was released); a write_website site still
//      serves after a user document closes.

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
