// The sky vocabulary shared by BOTH /clouds engines — the volumetric scene
// (clouds-scene.tsx, @takram atmosphere + ray-marched clouds) and the wisps
// scene (clouds-wisps.tsx, one procedural fullscreen shader). Presets, the
// Live clock interpolation, and the easing/wrapping helpers live here so
// the two renderers stay two STYLES of the same sky rather than two skies.

import type { CloudsQualityPreset } from "@takram/three-clouds";

// Each stop: solar hour, exposure, postcard heading, star brightness, and a
// cloud mood that multiplies the user's Fullness/Intensity/Size sliders.
// Hours assume the default view (lat 35, day 172): the sun rises near solar
// 4.8 and sets near 19.2, so Sunrise/Sunset sit just past those edges where
// the colour actually happens, and Dusk is civil twilight — sun down, sky
// still burning. Moods: sunrise and sunset arrive with BIG soft decks to
// catch the colour (the Blissful reference frames), morning is thin airy
// wisps on light blue, dusk broods — fuller and denser, the storm end of
// the range — and night strips the sky back so the stars own it.
export const SKY_PRESETS = {
  "Pre-dawn": { hour: 4.3, exposure: 40, heading: 55, stars: 3, mood: { fullness: 0.8, intensity: 0.8, size: 1 } },
  Sunrise: { hour: 5.4, exposure: 14, heading: 60, stars: 0, mood: { fullness: 1.7, intensity: 0.9, size: 1.25 } },
  Morning: { hour: 9, exposure: 8, heading: 35, stars: 0, mood: { fullness: 0.9, intensity: 0.85, size: 1 } },
  Midday: { hour: 13, exposure: 6.5, heading: 35, stars: 0, mood: { fullness: 1, intensity: 1, size: 1 } },
  Afternoon: { hour: 16.5, exposure: 8, heading: 25, stars: 0, mood: { fullness: 1.25, intensity: 1.1, size: 1.1 } },
  Sunset: { hour: 19.0, exposure: 16, heading: 295, stars: 0, mood: { fullness: 1.6, intensity: 1.1, size: 1.25 } },
  Dusk: { hour: 19.6, exposure: 55, heading: 295, stars: 1.5, mood: { fullness: 1.35, intensity: 1.5, size: 1.15 } },
  Night: { hour: 0.5, exposure: 90, heading: 0, stars: 6, mood: { fullness: 0.55, intensity: 0.7, size: 1 } },
} as const;
export type SkyPresetName = keyof typeof SKY_PRESETS;
export type SkyStop = {
  hour: number;
  exposure: number;
  heading: number;
  stars: number;
  mood: { fullness: number; intensity: number; size: number };
};

/** "Live": the visitor's clock is the solar hour, and everything else
 *  interpolates between the two presets that bracket it (wrapping midnight),
 *  so 3pm looks like a slightly-late Midday and 9pm sits between Dusk and
 *  Night. The heading is the nearer stop's — a direction can't be averaged
 *  usefully. */
export function liveSky(): SkyStop {
  const now = new Date();
  const hour = now.getHours() + now.getMinutes() / 60;
  const stops = Object.values(SKY_PRESETS)
    .slice()
    .sort((a, b) => a.hour - b.hour);
  let before = stops[stops.length - 1];
  let after = stops[0];
  for (const stop of stops) {
    if (stop.hour <= hour) before = stop;
    if (stop.hour > hour) {
      after = stop;
      break;
    }
  }
  const span = (after.hour - before.hour + 24) % 24 || 24;
  const t = ((hour - before.hour + 24) % 24) / span;
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    hour,
    exposure: mix(before.exposure, after.exposure),
    heading: t < 0.5 ? before.heading : after.heading,
    stars: mix(before.stars, after.stars),
    mood: {
      fullness: mix(before.mood.fullness, after.mood.fullness),
      intensity: mix(before.mood.intensity, after.mood.intensity),
      size: mix(before.mood.size, after.mood.size),
    },
  };
}

/** Shortest signed distance a→b on a circle of the given period — how hour
 *  (24) and heading (360) interpolate, so midday→night rolls forward
 *  through dusk instead of rewinding the afternoon. */
export function wrapDelta(a: number, b: number, period: number): number {
  return ((b - a + period / 2 + period * 2) % period) - period / 2;
}

/** Two easings for two situations. A switch FROM REST gets ease-in-out
 *  cubic — still at both ends, breathing through the middle, the calm a
 *  damped lerp's hard start could not give. A tween that INTERRUPTS one
 *  still in flight (a dial being dragged retargets every frame) gets
 *  ease-out — nonzero slope at t=0, so the scene answers the hand
 *  immediately instead of freezing at the start of a curve it keeps being
 *  reset to, and still lands softly. */
export function ease(t: number, fromRest: boolean): number {
  if (fromRest) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  return 1 - Math.pow(1 - t, 3);
}

// The panel's shape, shared so either engine can be handed the same dials.
export interface CloudDials {
  engine: "Volumetric" | "Wisps";
  sky: "Live" | SkyPresetName;
  speed: number;
  fullness: number;
  intensity: number;
  size: number;
  advanced: {
    quality: CloudsQualityPreset;
    clumping: number;
    altitude: number;
    thickness: number;
  };
  view: {
    longitude: number;
    latitude: number;
    height: number;
    /** Metres east (x) / north (y) of the geodetic anchor — the camera's
     *  position origin, walkable at cloud scale where the lat/lon dials
     *  step in ~55 km increments. */
    origin: { x: number; y: number };
    heading: number;
    pitch: number;
  };
}
