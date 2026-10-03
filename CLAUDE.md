# Coucou — guide for AI coding agents

Coucou is a Windows app (Tauri 2 + Rust + TypeScript, no framework): Mochi, a small animated character living at the top of the screen, shows agent sessions and a few integrations, and lets the user approve, answer, chat and drop files without leaving what they're doing.

## Where things are

- `src/` — island front end (TypeScript, no framework): `core/` (state, bridge, layout, sound), `island/` (panel shell + FSM), `agents/` (hook and integration event plumbing), `library/` (clipboard history, file shelf), `mochi/` (Mochi in Canvas 2D), `views/` (every island view plus shared `dom`/`icons`), `upload/` (drop sequence), `settings/` (the settings window).
- `src-tauri/` — Rust backend: window geometry, named pipe, agent-hook installers (`hooks.rs` for Claude Code, `opencode.rs`, `antigravity.rs`, shared helpers in `configfile.rs`), Claude API, clipboard history (`clipboard.rs`), files and shelf (`files.rs`), pollers, secrets.
- `hook/` — `coucou-hook.exe`, the relay every agent harness spawns. One binary, three harnesses: `coucou-hook <Event> [claude|opencode|antigravity]`.
- `agents/` — harness install assets: `opencode-plugin/coucou.js` (relay path baked in at install), `antigravity-hooks-snippet.json` (per-project entries).
- `assets/sounds/` — the 28 WAV sounds (`SOUNDS_DIR` in `vite.config.ts` is the one place the path is declared).
- `design/prototype/notch-buddy.html` — original prototype, the visual source of truth. `design/captures/` — target screenshots.
- `dev/` — browser harnesses for looking at one thing closely: `upload-preview.html`, `music-preview.html`, `music-scrub-check.html`, `glow-preview.html`. Not part of the app bundle.
- `docs/` — untracked. It is upstream's project website plus the French spec (`SPEC.md`, `INTEGRATIONS.md`), kept on disk for reference; nothing here builds or ships it.

## Build

```powershell
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # installer lands in release/
```

The release exe embeds `dist/` at compile time. `src-tauri/build.rs` declares
`cargo:rerun-if-changed=../dist`, so a plain `cargo build` picks the frontend up
— before that existed, a plain `cargo build` relinked the crate against the
assets embedded by an *earlier* run and the binary kept serving the old island
with no error anywhere. Only `tauri build` / `npm run pack` run the
`beforeBuildCommand` (`npm run build`), so after changing anything under `src/`
run `npm run build` before `cargo build`.

`cargo test --workspace` runs every Rust test; `npx tsc --noEmit` typechecks the island.

## Rules

- TypeScript with no framework, Rust backend. No third-party dependencies unless truly unavoidable. The character is drawn in code (Canvas 2D), no Rive/Lottie/images.
- Secrets live in the Windows Credential Manager, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block the agent: if the app doesn't answer, the hook exits immediately (Claude Code / OpenCode: empty stdout; Antigravity `PreToolUse`: `{"decision":"ask"}`).
- Never overwrite `~/.claude/settings.json`, OpenCode plugin files or Antigravity `hooks.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a permission without an explicit click.
- Performance: 0 % CPU when the island is hidden.
- Keep the identifier `fr.louisraille.coucou` (Credential Manager items and settings depend on it) until a deliberate rename.
- Visual changes must match the prototype and the screenshots in `design/captures/`.
