# Retro Preservation, Legal Directory & Sandboxed WASM Execution (Vibe Coding Manual v5.0.4, Chapter 26)

## 1. Zero-Hosting Doctrine
- The system must NEVER host, index for download, upload, or persist copyrighted ROMs, proprietary BIOS files, or other protected game assets.
- The preservation hub reduces legal risk while helping users find legitimate ways to play classic games.

## 2. Where to Play Legally
- The legal directory may aggregate official digital re-releases, retro compilations, subscription catalogs (NSO, PS Plus Classics, Antstream), and homebrew/indie repositories (Itch.io, PICO-8).
- Entries must point users toward lawful access paths rather than asset acquisition.

## 3. Sandboxed Client-Side Runner & Patch Index
- Client execution must be sandboxed and local-only through WebAssembly, using user-provided file dumps without server persistence or upload.
- Community enhancement indexing may include non-copyright patch files such as `.ips` and `.bps` that contain code modifications, translations, or metadata but NOT proprietary game assets.
