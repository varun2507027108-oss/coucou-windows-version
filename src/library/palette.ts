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

/**
 * Colours the UI is tinted with.
 *
 * `glowA`/`glowB` are a normalized edge-light pair, not the colours used for
 * broad interface surfaces. A tight 2px ring has to name the record at a
 * glance, so saturation and usable brightness are preserved. Large blurred
 * washes are what turned those saturated means into grey or brown haze.
 */
export interface Palette {
  base: string;
  deep: string;
  light: string;
  /** Primary edge-light colour, normalized from the dominant bucket. */
  glowA: string;
  /** Secondary edge-light colour, from the second bucket when useful. */
  glowB: string;
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

interface RgbMean {
  r: number;
  g: number;
  b: number;
}

function formatRgb(color: RgbMean): string {
  return rgb(
    clampNumber(Math.round(color.r), 0, 255),
    clampNumber(Math.round(color.g), 0, 255),
    clampNumber(Math.round(color.b), 0, 255),
  );
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(color: { r: number; g: number; b: number }): HslColor {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(color: HslColor): { r: number; g: number; b: number } {
  const h = ((color.h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const sector = Math.floor(h / 60);
  let prime: [number, number, number] = [0, 0, 0];
  if (sector === 0) prime = [c, x, 0];
  else if (sector === 1) prime = [x, c, 0];
  else if (sector === 2) prime = [0, c, x];
  else if (sector === 3) prime = [0, x, c];
  else if (sector === 4) prime = [x, 0, c];
  else prime = [c, 0, x];
  const m = color.l - c / 2;
  return {
    r: (prime[0] + m) * 255,
    g: (prime[1] + m) * 255,
    b: (prime[2] + m) * 255,
  };
}

/**
 * Normalizes a sampled bucket for a thin edge light.
 *
 * Edge lighting wants hue identity first: the colour must still read as the
 * album. So normalize saturation upward and clamp lightness into a readable
 * band instead of washing the value toward grey. Achromatic covers stay neutral
 * rather than inventing a hue; their brightness is still normalized so they do
 * not disappear.
 */
function edgeLight(
  color: { r: number; g: number; b: number },
  tone: "primary" | "secondary" | "secondary-from-primary",
): string {
  const hsl = rgbToHsl(color);
  if (hsl.s < 0.2) {
    return formatRgb(hslToRgb({ h: 0, s: 0, l: clampNumber(hsl.l, 0.34, 0.55) }));
  }
  const saturation =
    tone === "primary"
      ? clampNumber(hsl.s * 1.1, 0.6, 0.82)
      : clampNumber(hsl.s * 0.96, 0.48, 0.7);
  const lightness =
    tone === "primary"
      ? clampNumber(hsl.l, 0.47, 0.6)
      : clampNumber(hsl.l, 0.39, 0.52);
  return formatRgb(hslToRgb({ h: hsl.h, s: saturation, l: lightness }));
}

/**
 * Rotates an sampled mean by degrees, used only when a cover yields a single
 * usable bucket. Keeps saturation/lightness so the fallback stays the record.
 */
function rotateHue(color: RgbMean, degrees: number): RgbMean {
  const hsl = rgbToHsl(color);
  if (hsl.s < 0.2) return color;
  const rotated = hslToRgb({ h: hsl.h + degrees, s: hsl.s, l: hsl.l });
  return { r: rotated.r, g: rotated.g, b: rotated.b };
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

    interface GlowBucket {
      r: number;
      g: number;
      b: number;
      n: number;
    }

    const bucketMean = (bucket: GlowBucket): RgbMean => ({
      r: bucket.r / bucket.n,
      g: bucket.g / bucket.n,
      b: bucket.b / bucket.n,
    });

    const first = ranked[0];
    // A second bucket only counts if it is a real minority, otherwise a single
    // stray bright pixel becomes half the glow.
    const second = ranked.length > 1 && ranked[1].n > ranked[0].n * 0.18 ? ranked[1] : null;
    const firstMean = bucketMean(first);
    const secondMean = second ? bucketMean(second) : null;
    const base = formatRgb(firstMean);
    // `deep` is the darkest of the three and is only used for large soft washes,
    // where being dark is fine. `light` is the highlight: it draws the island's
    // border ring and the play button, both of which disappear against a
    // near-black panel if the sampled colour is itself nearly black — which is
    // exactly what a cover with a black band produces. So it gets a floor.
    const deep = secondMean ? formatRgb(secondMean) : shade(base, -0.42);
    const light = lift(second ? shade(base, 0.34) : shade(base, 0.46), 0.42);
    // Edge lighting needs the dominant hues themselves, normalized rather than
    // desaturated. If there is no usable second bucket, rotate the dominant hue
    // slightly so the edge still alternates two tones instead of one flat ring;
    // a 32° shift stays recognizably the same record while reading as two
    // colours along the border.
    const secondaryMean = secondMean ?? rotateHue(firstMean, 32);
    return {
      base,
      deep,
      light,
      glowA: edgeLight(firstMean, "primary"),
      glowB: edgeLight(secondaryMean, secondMean ? "secondary" : "secondary-from-primary"),
    };
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

/**
 * Brightens an `rgb(r g b)` string until its brightest channel reaches `floor`.
 *
 * Scaling toward white rather than adding evenly, so the hue survives: adding
 * the same amount to all three channels turns a saturated red into a flat pink.
 */
function lift(colour: string, floor: number): string {
  const nums = colour.match(/[\d.]+/g);
  if (!nums || nums.length < 3) return colour;
  const ch = nums.slice(0, 3).map(Number);
  const peak = Math.max(ch[0], ch[1], ch[2]);
  if (peak >= floor * 255) return colour;
  const k = (floor * 255) / Math.max(1, peak);
  return rgb(
    Math.min(255, Math.round(ch[0] * k)),
    Math.min(255, Math.round(ch[1] * k)),
    Math.min(255, Math.round(ch[2] * k)),
  );
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

