// Dev harness: checks the two things about the album glow that can be verified
// without a compositor.
//
// 1. The colours are *registered* CSS properties. CSS cannot animate an
//    unregistered custom property at all — it is a token stream, so a
//    `transition` on it silently does nothing and the light jumps on every track
//    instead of cross-fading. Registration is what makes that work, and it is
//    observable: a registered `<color>` computes to `rgb(...)`, while an
//    unregistered one hands back the token exactly as authored. So this sets a
//    *named* colour and checks whether it comes back resolved.
//
// 2. Containment. The effect must never reach the left or right edge of the
//    screen, which is a property of the box it lives in rather than of the blur.
//
// What this deliberately does NOT assert: that the transition takes 1.4s. Under
// headless virtual time the animation clock and the timer clock do not advance in
// step, so the same page read as "mid-blend" on one run and "snapped" on the next
// with no code change. Timing has to be confirmed by eye in the running app.
//
// Not part of the app bundle.

const out = document.getElementById("out")!;
const island = document.getElementById("island")!;
const lines: string[] = [];
const verdicts: boolean[] = [];

const check = (ok: boolean, name: string, detail = "") => {
  verdicts.push(ok);
  lines.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * Registration is checked from the CSSOM rather than by reading the computed
 * value back. Setting the property and reading it immediately returned the
 * pre-recalc value on some runs and the fresh one on others, and since a
 * registered colour and a resolved rgb() string look alike either way, an
 * assertion on it passed while proving nothing. A `CSSPropertyRule` in
 * `document.styleSheets` is the registration itself, with no timing involved.
 */
function registeredProperties(): string[] {
  const found: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet; the island's is same-origin, so this is belt and braces
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      const r = rule as CSSRule & { name?: string; syntax?: string };
      // Chromium exposes @property as CSSPropertyRule, which carries `name`.
      if (typeof r.name === "string" && r.name.startsWith("--amb-glow")) {
        found.push(`${r.name} ${r.syntax ?? ""}`.trim());
      }
    }
  }
  return found;
}

const run = () => {
  const props = registeredProperties();
  lines.push(`registered: ${props.join("  |  ") || "none"}`);
  check(
    props.some((p) => p.startsWith("--amb-glow-a")),
    "--amb-glow-a is a registered <color> property, so it can transition at all",
  );
  check(
    props.some((p) => p.startsWith("--amb-glow-b")),
    "--amb-glow-b is registered too",
  );
  check(
    props.every((p) => p.includes("<color>")),
    "both are registered as colours, not as some other type",
  );

  const dur = getComputedStyle(island).transitionDuration;
  check(
    /1\.4s/.test(dur),
    "a 1.4s transition is declared on the colours",
    `transition-duration: ${dur}`,
  );

  // Containment.
  const glow = island.querySelector<HTMLElement>(".notch-glow")!;
  const r = glow.getBoundingClientRect();
  const pw = island.getBoundingClientRect();
  check(
    Math.round(r.width) === 460 && Math.round(r.height) === 210,
    "glow box is a fixed 460x210",
    `got ${Math.round(r.width)}x${Math.round(r.height)}`,
  );
  const reach = (r.width - pw.width) / 2;
  check(
    reach <= 100,
    "cannot reach past 100px from the pill, so never a screen edge",
    `reach is ${reach.toFixed(0)}px`,
  );

  // Three layers, in order, all absolutely placed and non-interactive.
  const layers = [...glow.querySelectorAll<HTMLElement>("i")];
  check(layers.length === 3, "three glow layers", `got ${layers.length}`);
  check(
    layers.every((l) => getComputedStyle(l).position === "absolute"),
    "every layer is absolutely positioned",
  );
  check(
    getComputedStyle(glow).pointerEvents === "none",
    "the glow cannot swallow a click",
  );

  out.textContent =
    lines.join("\n") +
    `\n${verdicts.filter(Boolean).length}/${verdicts.length} passed`;
};

try {
  run();
} catch (err) {
  // Without this the page keeps saying "running" and the harness failure looks
  // like a product failure.
  out.textContent =
    lines.join("\n") +
    `\nERROR ${err instanceof Error ? err.message : String(err)}`;
}