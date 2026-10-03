# Contributing to Coucou

Thanks for wanting to help Mochi grow up! 🫶

## Getting started

Requirements: [Rust](https://rustup.rs), [Node 20+](https://nodejs.org), and the
**MSVC build tools** (Visual Studio Build Tools with "Desktop development with
C++"). WebView2 ships with Windows 10/11.

```powershell
npm install
npm run tauri dev      # live-reloading development build
```

`npm run dev` alone serves the front end in an ordinary browser, which is enough
to work on the island's looks.

## Good first contributions

- A new integration (a poller + a pill + a detail card). Look at the Stripe poller for a compact example.
- A new emote or sound for Mochi.
- A new agent harness next to Claude Code, OpenCode and Antigravity (a relay agent tag + an installer + a pill).
- Bug fixes — please describe how to reproduce.

## Rules of the house

- TypeScript with no framework, Rust backend, **no third-party dependencies** unless there's really no other way.
- Secrets go in the Windows Credential Manager, never on disk or in git.
- No telemetry, no network calls except to services the user configured.
- Never block the agent: if the app doesn't answer, the hook must exit right away.
- Never write agent config files without a backup and the user's confirmation.
- Keep it light: 0 % CPU when the island is hidden.

## Pull requests

- One topic per PR, with a short GIF or screenshot for anything visual.
- `npx tsc --noEmit` and `cargo test --workspace` must pass with no new warnings.
