# Third-party notices

alabs is licensed under the MIT License (see `LICENSE`). A built alabs
application also contains the third-party components below. Their licenses
require that their copyright and permission notices travel with any copy of
the built application. This file is that record.

The source repository itself contains none of this code. It is fetched from
the public npm registry and crates.io by `npm ci` and `cargo build` according
to `package-lock.json` and `src-tauri/Cargo.lock`. The license text for each
package is in its own package folder after installation.

## Frontend packages bundled into the application

| Component | Version | License | Copyright |
| --- | --- | --- | --- |
| Monaco Editor | 0.56.0 | MIT | Copyright (c) 2016 - present Microsoft Corporation |
| @monaco-editor/react | 4.7.0 | MIT | Copyright (c) 2018 Suren Atoyan |
| React and React DOM | 19.3.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| DOMPurify | 3.4.8 | Apache-2.0 (offered as MPL-2.0 OR Apache-2.0; alabs takes it under Apache-2.0) | Dr.-Ing. Mario Heiderich, Cure53 |
| marked | 14.0.0 | MIT | Copyright (c) 2011-2018, Christopher Jeffrey; Copyright (c) 2018+, MarkedJS |
| @tauri-apps/api | 2.11.1 | MIT (offered as MIT OR Apache-2.0) | Copyright (c) 2017 - Present Tauri Apps Contributors |
| @tauri-apps/plugin-dialog | 2.7.3 | MIT (offered as MIT OR Apache-2.0) | 2019-2022, The Tauri Programme in the Commons Conservancy |
| Dexie.js | 4.4.6 | Apache-2.0 | David Fahlander and the Dexie.js contributors |

Dexie is bundled into the browser build only (`ALABS_RUNTIME=browser`), where
it keeps editor recovery drafts in IndexedDB. The desktop application does not
contain it. It has no dependencies of its own. Its `LICENSE` is the
unmodified Apache-2.0 text and names no copyright line of its own; the holder
above is taken from the package's `author` and `contributors` fields.

Monaco Editor incorporates further components (the Node.js path library,
marked, TypeScript, an HTML 5.1 W3C working draft, JS Beautifier, Ionic
documentation and vscode-swift). Their notices are in
`node_modules/monaco-editor/ThirdPartyNotices.txt` and must accompany any
distribution of the built application.

## Rust crates compiled into the application

Direct dependencies:

| Crate | Version | License |
| --- | --- | --- |
| tauri | 2.11.5 | Apache-2.0 OR MIT |
| tauri-plugin-dialog | 2.7.3 | Apache-2.0 OR MIT |
| tauri-build | 2.6.3 | Apache-2.0 OR MIT |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| cap-std | 4.0.3 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| ignore | 0.4.33 | Unlicense OR MIT |
| libc | 0.2.189 | MIT OR Apache-2.0 |

The local server (`alabs-serve`, built with `--features serve`) adds these
direct dependencies. It does not compile Tauri, so a build of the server
contains none of the crates above except serde, serde_json, cap-std, ignore
and libc.

| Crate | Version | License |
| --- | --- | --- |
| axum | 0.8.9 | MIT |
| tokio | 1.53.1 | MIT |
| tower | 0.5.3 | MIT |
| tower-http | 0.6.11 | MIT |
| futures-core | 0.3.34 | MIT OR Apache-2.0 |

The complete set of crates in `src-tauri/Cargo.lock`, with each license, can
be listed at any time with:

```bash
cargo metadata --manifest-path src-tauri/Cargo.toml --locked --offline --format-version 1
```

Most of those crates are dual-licensed MIT OR Apache-2.0. The exceptions that
carry their own obligations are:

- MPL-2.0 (unmodified; source available on crates.io): cssparser,
  cssparser-macros, dtoa-short, option-ext, selectors.
- Unicode-3.0 (notice retention): the icu_* , zerovec, zerofrom, yoke,
  litemap, tinystr, writeable, zerotrie and potential_utf crates, and
  unicode-ident.
- Apache-2.0 only: tao, sync_wrapper.
- Apache-2.0 WITH LLVM-exception only: target-lexicon, winx.
- BSD-3-Clause: alloc-no-stdlib, alloc-stdlib, brotli (with MIT),
  brotli-decompressor.
- MIT AND BSD-3-Clause (both notices required): matchit, reached only through
  axum in the server build.

## Not part of the application

Development-only tools (Vite, Vitest, jsdom, TypeScript, Playwright, the
Tauri CLI and their dependencies) are used to build and test alabs and are
not distributed with it. Playwright drives the Google Chrome already
installed on the machine and downloads no browser of its own.

## Artwork

The alabs artwork in `assets/brand/` and `assets/supporting-assets/` is not
third-party. Its status is stated in the README of each folder.
