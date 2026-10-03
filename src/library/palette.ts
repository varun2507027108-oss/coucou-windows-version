// Album art → the colours the player is made of.
//
// Apple Music, Spotify and the Dribbble "dynamic colour" crowd all do the same
// thing: pull a couple of dominant colours out of the cover and tint everything
// around it, so each song gets its own light. The art is the only real colour
// in the UI, so this is where the player's personality comes from.
//
// How it works: draw the cover into a tiny offscreen canvas, read the pixels,
// and bucket them by hue ignoring the near-black and near-white ends (album
// photos are mostly shadows and paper). One bucket usually wins on its own; a
// second is kept when the winner's neighbours are genuinely different, which is
// what gives a two-tone glow instead of a flat wash.

/** Three colours: the glow's core, a supporting tint, and a warm highlight. */
export interface Palette {
  base: string;
  deep: string;
  light: string;
}

const SAMPLE = 24;

/** Perceptually spread hues, so two buckets never land on the same colour. */
const HUE_BUCKETS = [12, 45, 95, 150, 195, 235, 275, 320];

function inBucket(hue: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < HUE_BUCKETS.length; i++) {
    const d = Math.abs(((hue - HUE_BUCKETS[i] + 540) % 360) - 180);
    const dist = 180 - d;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r} ${g} ${b})`;
}

/**
 * Samples an already-loaded image. Returns null when it cannot be read — a
 * canvas tainted by a cross-origin image, or a decode that has not happened yet
 * — and the caller keeps whatever palette it already had.
 */
export function extractPalette(img: HTMLImageElement): Palette | null {
  if (!img.naturalWidth || !img.naturalHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    const buckets = HUE_BUCKETS.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 128) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const v = max / 255;
      const sat = max === 0 ? 0 : (max - min) / max;
      // Shadows and blown-out paper say nothing about the record's colour.
      if (v < 0.16 || v > 0.94 || sat < 0.18) continue;
      const bucket = buckets[inBucket(hslHue(r, g, b))];
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.n += 1;
    }

    const ranked = buckets
      .map((b, i) => ({ ...b, i }))
      .filter((b) => b.n > 0)
      .sort((a, b) => b.n - a.n);
    if (!ranked.length) return null;

    const mean = (b: { r: number; g: number; b: number; n: number }) =>
      rgb(Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n));

    const first = ranked[0];
    // A second bucket only counts if it is a real minority, otherwise a single
    // stray bright pixel becomes half the glow.
    const second = ranked.length > 1 && ranked[1].n > ranked[0].n * 0.18 ? ranked[1] : null;
    const base = mean(first);
    const deep = second ? mean(second) : shade(base, -0.42);
    const light = second ? shade(base, 0.34) : shade(base, 0.46);
    return { base, deep, light };
  } catch {
    // A tainted canvas throws rather than returning null.
    return null;
  }
}

function hslHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Lightens (positive) or darkens (negative) an `rgb(r g b)` string. */
function shade(colour: string, amount: number): string {
  const nums = colour.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return colour;
  const ch = nums.slice(0, 3).map((n) => {
    const v = Number(n);
    return Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  });
  return rgb(ch[0], ch[1], ch[2]);
}

// ── Loading from a URL ───────────────────────────────────────────────────────
// The music view has an <img> to sample, but the compact bar does not open the
// view at all, so a track's colour has to be reachable from the data URL alone.
// One decode and one sample per track, memoised on the URL: a cover never
// changes under a given data URL, and re-decoding it every snapshot would be
// the exact waste this module exists to avoid.

const loaded = new Map<string, Palette | null>();

export function loadPalette(src: string): Promise<Palette | null> {
  const hit = loaded.get(src);
  if (hit !== undefined) return Promise.resolve(hit);
  return new Promise<Palette | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const p = extractPalette(img);
      loaded.set(src, p);
      resolve(p);
    };
    img.onerror = () => {
      // Cache the failure too: a broken cover would otherwise be retried on
      // every track change for the rest of the session.
      loaded.set(src, null);
      resolve(null);
    };
    img.src = src;
  });
}

