// Dev harness for the now-playing view. Feeds buildMusic() a synthetic snapshot
// so the layout, the cover-palette glow and the scrubber can be inspected (and
// screenshotted) without a real OS media session. Not part of the app bundle.

import { buildMusic, parseLrc } from "../src/library/music";
import { State } from "../src/core/state";
import { loadPalette } from "../src/library/palette";
import type { MediaSnapshot } from "../src/core/bridge";

State.settings.mediaEnabled = true;
State.settings.mediaLyrics = true;
State.view = "music";

// Freeze the ring at a chosen point in its cycle when asked, so a screenshot
// can show the glow travelling. See the note in music-preview.html.
const probe = new URLSearchParams(location.search).get("probe");
if (probe !== null) {
  document.body.classList.add("probe");
  document.body.style.setProperty("--probe", `${probe}s`);
}

const track: MediaSnapshot = {
  active: true,
  playing: true,
  title: "Superman",
  artist: "Eminem, Dina Rae",
  album: "Death of the Slim Shady LP",
  positionSecs: 74,
  durationSecs: 350,
  art: "./cover-sample.png",
  canPlay: true,
  canPause: true,
  canNext: true,
  canPrev: true,
  canSeek: true,
  mood: "fiery",
};
State.media = track;
State.mediaAtWallMs = performance.now();
State.lyricLines = parseLrc(
  [
    "[00:00.00]Don't wanna let nobody know, nobody",
    "[00:06.00]I'm back on the smoke again",
    "[01:10.00]Superman, take me where the light is",
    "[01:16.00]I got a million of these problems",
    "[01:22.00]Every single one of them glows when the sun comes up",
    "[01:30.00]Dina Rae on the track, keep it running",
  ].join("\n"),
);

void loadPalette(track.art!).then((p) => {
  State.mediaAccent = p;
  // The app gets this for free: `State.notify` marks the island dirty and
  // `syncDom` re-syncs the visible view. The harness has to do it by hand.
  view.sync();
  // Same for the compact bar and its ring, which the island tints in
  // syncCompactTrack() by writing the palette onto #island itself.
  const island = document.getElementById("island");
  if (p && island) {
    island.style.setProperty("--amb-base", p.base);
    island.style.setProperty("--amb-deep", p.deep);
    island.style.setProperty("--amb-light", p.light);
  }
  const strip = document.getElementById("compact-track");
  const fill = strip?.querySelector<HTMLElement>(".compact-track-fill");
  if (fill) {
    const pct = ((track.positionSecs + 4) / track.durationSecs) * 100;
    fill.style.transform = `scaleX(${pct / 100})`;
  }
});

const host = document.getElementById("views")!;
const view = buildMusic();
view.el.classList.add("on");
host.append(view.el);
view.sync();

// Same per-frame entry point the island uses.
const loop = () => {
  view.tick(performance.now());
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
