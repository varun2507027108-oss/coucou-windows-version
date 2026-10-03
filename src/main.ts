// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_TAURI, onEvent, type MediaSnapshot } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./agents/hooks";
import { registerLibraryHandlers } from "./library/events";
import { applySnapshot, refreshMedia } from "./library/music";
import { registerIntegrationHandlers, refreshConfigured } from "./agents/integrations";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;
  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadIntegrationTasks();

  await onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        break;
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());

  // Ctrl+Alt+C. Rust decides whether the island is up and says which way to go,
  // so the key toggles instead of only ever opening.
  await onEvent<"show" | "hide">("summon", (what) => {
    if (what === "hide") island.collapse();
    else island.summon();
  });

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
    State.loadIntegrationTasks();
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);
  registerLibraryHandlers();

  // Now-playing snapshots land here. Stored even with the view closed (the
  // progress anchor and Mochi's mood need it); lyrics fetch only when the music
  // view is open, so an idle player costs no rate limits.
  await onEvent<MediaSnapshot>("media", (snap) => {
    applySnapshot(snap);
    if (State.view === "music") void refreshMedia();
  });

  // Spotify link completed in the browser: re-check the track so mood and art
  // apply without waiting for the next song.
  await onEvent<{ linked: boolean }>("spotify", () => {
    if (State.view === "music") void refreshMedia();
  });

  island.launch();

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
