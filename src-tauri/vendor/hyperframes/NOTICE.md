# HyperFrames runtime (vendored)

`hyperframe.runtime.iife.js` is the browser runtime of HyperFrames, copied
byte for byte from the published npm package `@hyperframes/core@0.9.86`
(`dist/hyperframe.runtime.iife.js`, sha256
`33d00f387cea4763f02c8339022daa3f27004ca8c36ad6b01e8f1afca67d8a2c`).

- Copyright HeyGen, Inc. Licensed under the Apache License 2.0 (see
  `LICENSE` in this folder).
- Source: https://github.com/heygen-com/hyperframes (packages/core).
- Not modified.

Why it is vendored: the Rust core inlines it into the sandboxed video
preview document (`src-tauri/src/video/preview.rs`). The preview has no
network (`connect-src 'none'`, no remote scripts), so the player can never
fetch it from a CDN, and the core cannot read `node_modules` at run time.

The version is pinned together with `@hyperframes/player`, `@hyperframes/lint`
and `@hyperframes/core` in `package.json` and with the server renderer
(`@hyperframes/producer`). `src/video/runtimePin.test.ts` fails when this
file and `node_modules/@hyperframes/core` drift apart: bumping HyperFrames is
one coordinated change (desktop and server together).
