// Dev harness: the collapsed island once per glow style, so the choice is made
// from a picture. Uses the shipping CSS and the real sampled palette, so what is
// shown is what the island does. Not part of the app bundle.

import { loadPalette } from "../src/library/palette";

const COVER = "./cover-sample.png";

const STYLES: Array<[string, string]> = [
  ["corner", "Defined edge light with a quiet inset reflection."],
  ["wide", "Same edge with a broader, softer halo."],
  ["pulse", "Adds a slow travelling highlight and a gentle playing response."],
  ["off", "No album colour on the bar at all."],
];

const grid = document.getElementById("grid")!;

const build = (style: string, desc: string) => {
  const island = document.createElement("div");
  island.id = "island";
  island.className = "flowing";
  island.dataset.glow = style;

  // Same four lighting layers, same order, as Island's constructor.
  const glow = document.createElement("div");
  glow.className = "notch-glow";
  for (const cls of ["glow-halo", "glow-sheen", "glow-edge", "glow-sweep"]) {
    const i = document.createElement("i");
    i.className = cls;
    glow.append(i);
  }
  island.append(glow);

  const mochi = document.createElement("div");
  Object.assign(mochi.style, {
    position: "absolute", left: "12px", top: "5px", width: "22px", height: "22px",
    borderRadius: "11px", background: "linear-gradient(180deg,#fbfbfc,#e7e9ec)", zIndex: "2",
  });
  island.append(mochi);

  const strip = document.createElement("div");
  strip.id = "compact-track";
  Object.assign(strip.style, { opacity: "1", left: "62px", width: "149px", top: "6px" });
  strip.innerHTML =
    '<div class="compact-track-text">' +
    '<div class="compact-track-title">Superman</div>' +
    '<div class="compact-track-artist">Eminem, Dina Rae</div>' +
    '</div><div class="compact-track-bar"><div class="compact-track-fill"></div></div>';
  const fill = strip.querySelector<HTMLElement>(".compact-track-fill")!;
  fill.style.transform = "scaleX(0.21)";
  island.append(strip);

  const cell = document.createElement("div");
  cell.className = "cell";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = style;
  const desk = document.createElement("div");
  desk.className = "desk";
  desk.append(island);
  const d = document.createElement("div");
  d.className = "desc";
  d.textContent = desc;
  cell.append(name, desk, d);
  grid.append(cell);
  return island;
};

const islands = STYLES.map(([style, desc]) => build(style, desc));

void loadPalette(COVER).then((p) => {
  if (!p) return;
  for (const el of islands) {
    el.style.setProperty("--amb-base", p.base);
    el.style.setProperty("--amb-light", p.light);
    el.style.setProperty("--amb-glow-a", p.glowA);
    el.style.setProperty("--amb-glow-b", p.glowB);
  }
});