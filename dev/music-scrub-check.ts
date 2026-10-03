// Dev harness: exercises the now-playing scrubber without a real media session.
// The Tauri IPC is stubbed so the only thing under test is the view's own
// pointer handling and the number it asks for. Not part of the app bundle.

import { Bridge } from "../src/core/bridge";
import type { MediaSnapshot } from "../src/core/bridge";
import { buildMusic, positionAt, progressOf } from "../src/library/music";
import { State } from "../src/core/state";

const out = document.getElementById("out")!;
const lines: string[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  lines.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

// ── Pure helpers ────────────────────────────────────────────────────────────
check("progressOf clamps", progressOf(500, 100) === 1 && progressOf(-5, 100) === 0);
check("progressOf of an unknown length is 0", progressOf(30, 0) === 0);
check("positionAt is the inverse", positionAt(0.25, 400) === 100);
check("positionAt clamps", positionAt(2, 400) === 400 && positionAt(-1, 400) === 0);

// ── IPC stubs ───────────────────────────────────────────────────────────────
const seeks: number[] = [];
const commands: string[] = [];
(Bridge as unknown as { mediaSeek: (p: number) => Promise<boolean> }).mediaSeek = async (p) => {
  seeks.push(p);
  return true;
};
(Bridge as unknown as { mediaCommand: (op: string) => Promise<boolean> }).mediaCommand = async (op) => {
  commands.push(op);
  return true;
};

const track: MediaSnapshot = {
  active: true,
  playing: true,
  title: "Superman",
  artist: "Eminem, Dina Rae",
  album: "Death of the Slim Shady LP",
  positionSecs: 74,
  durationSecs: 400,
  art: null,
  canPlay: true,
  canPause: true,
  canNext: true,
  canPrev: true,
  canSeek: true,
  mood: "fiery",
};

State.settings.mediaEnabled = true;
State.view = "music";
State.media = track;
State.mediaAtWallMs = performance.now();

const host = document.getElementById("views")!;
const view = buildMusic();
view.el.classList.add("on");
host.append(view.el);
view.sync();

const bar = view.el.querySelector<HTMLElement>(".music-bar")!;
const r = bar.getBoundingClientRect();
const at = (fraction: number) => ({
  pointerId: 1,
  pointerType: "mouse",
  isPrimary: true,
  bubbles: true,
  cancelable: true,
  clientX: r.left + r.width * fraction,
  clientY: r.top + r.height / 2,
});

const wait = () => new Promise((res) => setTimeout(res, 30));

const run = async () => {
  check("bar has a width to scrub", r.width > 50, `width=${r.width.toFixed(1)}`);

  // A press at 25%, a drag to 60%, a release there.
  bar.dispatchEvent(new PointerEvent("pointerdown", at(0.25)));
  check("scrubbing class set on press", bar.classList.contains("scrubbing"));
  const tipOnPress = view.el.querySelector(".music-scrub-tip")!.textContent;
  check("time bubble shows on press", tipOnPress === "1:40", `got "${tipOnPress}"`);

  bar.dispatchEvent(new PointerEvent("pointermove", at(0.6)));
  const tipOnDrag = view.el.querySelector(".music-scrub-tip")!.textContent;
  check("time bubble follows the drag", tipOnDrag === "4:00", `got "${tipOnDrag}"`);

  bar.dispatchEvent(new PointerEvent("pointerup", at(0.6)));
  await wait();
  check("exactly one seek was requested", seeks.length === 1, `got ${seeks.length}`);
  check("seek landed where it was dropped", Math.abs((seeks[0] ?? -1) - 240) < 1.5,
    `asked for ${seeks[0]}`);
  check("scrubbing class cleared on release", !bar.classList.contains("scrubbing"));

  // Transport still works, and a drag must not swallow a click.
  view.el.querySelector<HTMLButtonElement>(".music-btn.main")!.click();
  await wait();
  check("play/pause reaches the OS session", commands.includes("toggle"),
    `got [${commands.join(",")}]`);

  // A session that refuses seeking must not be asked to.
  seeks.length = 0;
  State.media = { ...track, canSeek: false };
  view.sync();
  check("timeline marked unseekable", bar.classList.contains("disabled"));
  bar.dispatchEvent(new PointerEvent("pointerdown", at(0.5)));
  bar.dispatchEvent(new PointerEvent("pointerup", at(0.5)));
  await wait();
  check("no seek sent when the player refuses", seeks.length === 0, `got ${seeks.length}`);

  out.textContent = lines.join("\n") + `\n${lines.filter((l) => l.startsWith("PASS")).length}/${lines.length} passed`;
};

run();
