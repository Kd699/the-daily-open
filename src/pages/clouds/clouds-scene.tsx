"use client";

// The /clouds scene: geospatial volumetric clouds (@takram/three-clouds)
// lit and composited by @takram/three-atmosphere, dialled by DialKit.
// This is the VOLUMETRIC engine; an Engine dial swaps it for the wisps
// engine (clouds-wisps.tsx) — the same presets painted by one lightweight
// procedural shader. Shared sky vocabulary lives in ./sky.ts.
//
// HOW THE PIECES COMPOSE. Clouds is a postprocessing effect, not a mesh: it
// ray-marches cloud density into buffers inside EffectComposer, and
// AerialPerspective (from the atmosphere package) composites those buffers
// while drawing the sky and applying sun/sky irradiance — which is why the
// two must sit together inside <Atmosphere>. The camera lives in real ECEF
// coordinates on the WGS84 ellipsoid, so "where you are" is a geodetic
// longitude/latitude/height, not an arbitrary scene position.
//
// SKY IS A PRESET, TIME IS THE STYLE (after Steve Lauda's Blissful sky,
// x.com/stevelauda_/status/2066417007038521475). One select steps the sky
// through Pre-dawn → Night, and each stop is a real solar hour, the exposure
// that makes that hour legible, a postcard heading, and a cloud MOOD — the
// atmosphere model does the palette (indigo twilight, peach at sunrise,
// saturated midday blue, ember dusk) and the mood decides whether the hour
// arrives with big soft clouds, thin wisps, or a brooding deck. "Live" is
// the default and the easter egg: the visitor's own clock is the solar hour,
// interpolating between the neighbouring stops.
//
// SWITCHING SKIES: ONE EASED BREATH, NOT A FLIGHT. Every animated quantity
// — solar hour, exposure, heading/pitch, cloud coverage/density/scale, star
// brightness — is evaluated per frame from ONE fixed-duration tween and
// written STRAIGHT ONTO the CloudsEffect / renderer / camera (zero React
// re-renders per frame). Tweens, not damped lerp, on purpose: exponential
// smoothing moves FASTEST in its first frame — the old cut read as zooming
// through space — where an ease-in-out starts still, breathes through the
// middle and lands softly. Two durations off one clock: the scene (sun,
// light, camera) crosses in ~2s, the deck fades over ~3.5s so wisps are
// still quietly appearing and dissolving after the light has settled. The
// only drift is a whisper of weather scroll that swells mid-fade and calms
// to zero — clouds moving across, not racing. Hour and heading interpolate
// circularly (midday→night rolls forward, not back through morning).
// Honours prefers-reduced-motion by snapping.
//
// THE CAMERA IS A DIAL, NOT A GESTURE. No OrbitControls: the view is fixed,
// a postcard rather than a fly-through, and the only way to move it is the
// View folder (geodetic location plus heading/pitch in the local east-
// north-up frame). Selecting a sky swings the heading dial to that sky's
// postcard direction; the dial stays live on top.
//
// THE CLOUDS ARE FOUR WORDS, not fourteen parameters: Speed, Fullness,
// Intensity, Size — the Blissful vocabulary. The package's default layers
// are disabled and one thin, eroded layer is dialled instead; the preset
// mood multiplies the sliders, so the same hand-set character reads calm at
// midday and stormy at dusk. Everything else — quality preset, clump
// sharpness, layer altitude/thickness — is real but secondary, so it lives
// in a collapsed Advanced folder.
//
// The default weather/shape/turbulence/star textures stream from the takram
// packages' GitHub media host on first load; nothing is bundled here.

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  EffectComposer,
  SMAA,
  ToneMapping,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Vector3 } from "three";
import { DEFAULT_STARS_DATA_URL } from "@takram/three-atmosphere";
import {
  AerialPerspective,
  Atmosphere,
  Stars,
  type AtmosphereApi,
  type StarsImpl,
} from "@takram/three-atmosphere/r3f";
import type { CloudsEffect } from "@takram/three-clouds";
import { CloudLayer, Clouds } from "@takram/three-clouds/r3f";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { DialRoot, useDialKitController, type DialConfig } from "dialkit";
import "dialkit/styles.css";
import WispsCanvas from "./clouds-wisps";
import {
  SKY_PRESETS,
  ease,
  liveSky,
  wrapDelta,
  type CloudDials,
  type SkyStop,
} from "./sky";

/** Solar time → a real Date for Atmosphere.updateByDate. The sun's direction
 *  comes from the date, so "1pm at longitude 30°E" must be handed over as
 *  11am UTC — hours minus longitude/15. Fixed to midsummer 2026 because only
 *  time of day is dialled; the season is part of the page's look. */
function sunDate(hours: number, longitude: number): Date {
  return new Date(
    Date.UTC(2026, 0, 1) + (171 * 24 + hours - longitude / 15) * 3_600_000
  );
}

// Everything a sky is, as one flat vector the tween runs over. period
// marks the circular members; epsilon is how far a target must move before
// a new tween starts (Live's clock creeps ~0.017h/min — restarting on
// every creep would turn the tween back into the exponential it replaced).
const TWEEN_KEYS = {
  hour: { period: 24, epsilon: 0.05 },
  exposure: { epsilon: 0.1 },
  heading: { period: 360, epsilon: 0.5 },
  pitch: { epsilon: 0.25 },
  originE: { epsilon: 5 },
  originN: { epsilon: 5 },
  stars: { epsilon: 0.05 },
  coverage: { epsilon: 0.003 },
  density: { epsilon: 0.001 },
  repeat: { epsilon: 0.5 },
} as const;
type TweenKey = keyof typeof TWEEN_KEYS;
type SkyVector = Record<TweenKey, number>;

// The scene crosses in a breath; the deck fades a little longer, so wisps
// are still appearing and dissolving after the light has settled.
const SCENE_SECONDS = 2;
const CLOUD_SECONDS = 3.5;
const CLOUD_KEYS: readonly TweenKey[] = ["coverage", "density", "repeat"];

type Tween = { t: number; from: SkyVector; to: SkyVector; fromRest: boolean };

function evalTween(tw: Tween): SkyVector {
  const out = {} as SkyVector;
  for (const key of Object.keys(TWEEN_KEYS) as TweenKey[]) {
    const { period } = TWEEN_KEYS[key] as { period?: number };
    const seconds = CLOUD_KEYS.includes(key) ? CLOUD_SECONDS : SCENE_SECONDS;
    const eased = ease(Math.min(1, tw.t / seconds), tw.fromRest);
    const delta = period
      ? wrapDelta(tw.from[key], tw.to[key], period)
      : tw.to[key] - tw.from[key];
    const value = tw.from[key] + delta * eased;
    out[key] = period ? (value + period) % period : value;
  }
  return out;
}

function Scene({ dials }: { dials: CloudDials }) {
  const camera = useThree(({ camera }) => camera);
  const atmosphereRef = useRef<AtmosphereApi>(null);
  const starsRef = useRef<StarsImpl>(null);
  const [clouds, setClouds] = useState<CloudsEffect | null>(null);

  // Snap instead of glide for anyone who asked the OS for less motion.
  const reducedMotion = useMemo(
    () =>
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );

  // The Blissful easter egg's other half: the weather texture starts at a
  // random offset each mount, so which clouds you get — and where they sit
  // in the frame — is unique to the visit, not a fixed postcard.
  useEffect(() => {
    clouds?.localWeatherOffset.set(Math.random(), Math.random());
  }, [clouds]);

  // The one tween the frame loop owns. null until the first frame seeds it
  // at its own target (t past both durations), so a page opened on
  // ?sky=Dusk starts AT dusk instead of easing in from midday.
  const tween = useRef<Tween | null>(null);

  // Latest dials for the frame loop without re-binding the callback.
  const dialsRef = useRef(dials);
  dialsRef.current = dials;

  useFrame(({ gl }, delta) => {
    const d = dialsRef.current;
    const sky: SkyStop = d.sky === "Live" ? liveSky() : SKY_PRESETS[d.sky];

    // Targets: the preset's mood rides ON the user's sliders, so the same
    // hand-set character reads calm at midday and stormy at dusk.
    const target: SkyVector = {
      hour: sky.hour,
      exposure: sky.exposure,
      heading: d.view.heading,
      pitch: d.view.pitch,
      originE: d.view.origin.x,
      originN: d.view.origin.y,
      coverage: Math.min(1, d.fullness * 0.5 * sky.mood.fullness),
      density: Math.min(0.3, d.intensity * 0.15 * sky.mood.intensity),
      repeat: 60 + (1 - Math.min(1, d.size * sky.mood.size)) * 140,
      stars: sky.stars,
    };

    // Retarget only when something meaningfully moved (see TWEEN_KEYS —
    // restarting on Live's clock-creep would put the hard start back). A
    // new tween departs from wherever the old one currently IS, so a switch
    // mid-switch bends the path instead of jumping.
    const previous =
      tween.current == null || reducedMotion
        ? (tween.current = {
            t: CLOUD_SECONDS + 1,
            from: { ...target },
            to: { ...target },
            fromRest: true,
          })
        : tween.current;
    const moved = (Object.keys(TWEEN_KEYS) as TweenKey[]).some((key) => {
      const { period, epsilon } = TWEEN_KEYS[key] as {
        period?: number;
        epsilon: number;
      };
      const delta = period
        ? wrapDelta(previous.to[key], target[key], period)
        : target[key] - previous.to[key];
      return Math.abs(delta) > epsilon;
    });
    const tw =
      moved && !reducedMotion
        ? (tween.current = {
            t: 0,
            from: evalTween(previous),
            to: { ...target },
            fromRest: previous.t >= CLOUD_SECONDS,
          })
        : previous;
    tw.t += delta;
    const a = evalTween(tw);

    // Light and exposure.
    gl.toneMappingExposure = a.exposure;
    atmosphereRef.current?.updateByDate(sunDate(a.hour, d.view.longitude));
    if (starsRef.current) starsRef.current.material.intensity = a.stars;

    // Clouds — written straight onto the effect. The only motion on top of
    // the dialled wind is a whisper of weather scroll shaped like the fade
    // itself (sin(πt) — nothing at the ends, a breath in the middle), so a
    // switch reads as wisps drifting across while they appear and dissolve,
    // and the sky is perfectly still again the moment it has arrived.
    if (clouds) {
      const cloudPhase = Math.min(1, tw.t / CLOUD_SECONDS);
      const drift = Math.sin(Math.PI * cloudPhase) * 1.5e-5;
      clouds.coverage = a.coverage;
      clouds.localWeatherVelocity.set(d.speed * 1e-5 + drift, drift * 0.3);
      clouds.localWeatherRepeat.setScalar(a.repeat);
      const layer = clouds.cloudLayers[0];
      if (layer) layer.densityScale = a.density;
    }

    // Camera: the dialled geodetic stance, aimed by the SMOOTHED heading and
    // pitch — so a preset switch pans, it doesn't teleport.
    const position = new Geodetic(
      radians(d.view.longitude),
      radians(d.view.latitude),
      d.view.height
    ).toECEF(new Vector3());
    const east = new Vector3();
    const north = new Vector3();
    const up = new Vector3();
    Ellipsoid.WGS84.getEastNorthUpVectors(position, east, north, up);
    // The origin pad walks the stance across the ground plane — metres east
    // and north in the local frame, smoothed like the rest of the camera so
    // dragging the pad glides under the deck instead of teleporting.
    position.addScaledVector(east, a.originE).addScaledVector(north, a.originN);
    const h = radians(a.heading);
    const p = radians(a.pitch);
    const direction = new Vector3()
      .addScaledVector(east, Math.sin(h) * Math.cos(p))
      .addScaledVector(north, Math.cos(h) * Math.cos(p))
      .addScaledVector(up, Math.sin(p));
    camera.up.copy(up);
    camera.position.copy(position);
    camera.lookAt(position.addScaledVector(direction, 1e4));
  });

  return (
    <Atmosphere ref={atmosphereRef} correctAltitude>
      {/* Real stars (the package's HYG-derived catalogue), lifted per preset
          — night pushes them hard, day leaves them below the tone-mapper's
          floor. Suspense is load-bearing: Stars suspends while the catalogue
          streams from GitHub, and without a boundary it would take the WHOLE
          canvas down with it — black sky until the .bin arrives. */}
      <Suspense fallback={null}>
        {/* @ts-expect-error takram Stars types assume React 19 ref-as-prop */}
        <Stars ref={starsRef} data={DEFAULT_STARS_DATA_URL} pointSize={1.5} />
      </Suspense>
      <EffectComposer multisampling={0} enableNormalPass>
        <Clouds
          ref={setClouds}
          disableDefaultLayers
          qualityPreset={dials.advanced.quality}
          shadow-maxFar={1e5}
        >
          {/* The one curated layer (see file comment): thin, sparse, eroded.
              weatherExponent (clumping) sharpens the weather signal so low
              fullness means separated clumps, not a uniform veil; full
              shapeDetailAmount keeps the clumps translucent and ragged —
              wisps. coverage/density/repeat are NOT props: the frame loop
              above owns them so they can glide between moods. */}
          <CloudLayer
            channel="r"
            altitude={dials.advanced.altitude}
            height={dials.advanced.thickness}
            shapeAmount={1}
            shapeDetailAmount={1}
            weatherExponent={dials.advanced.clumping}
            shapeAlteringBias={0.35}
            coverageFilterWidth={0.6}
            shadow
          />
        </Clouds>
        {/* ground={false}: the ellipsoid is never drawn, so there is no dark
            sea and no hard horizon line — below the horizon the rays keep
            sampling atmosphere and the sky just continues. */}
        <AerialPerspective sky sunLight skyLight ground={false} />
        <ToneMapping mode={ToneMappingMode.AGX} />
        <SMAA />
      </EffectComposer>
    </Atmosphere>
  );
}

export default function CloudsScene() {
  // Hooks (useDialKit) cannot live inside <Canvas> — R3F's reconciler only
  // knows three.js objects — so the panel registers out here and the values
  // flow down as plain props. Slider tuples are [default, min, max, step].
  // This is the ONLY panel registered on /clouds: components/dialkit.tsx
  // stands down on this route so the popover holds exactly these dials.
  //
  // ?sky=Dusk seeds the select, so a particular sky is a shareable URL —
  // client-only read (this component is ssr:false) and it only seeds the
  // DEFAULT: the dial stays live on top of it.
  const params = new URLSearchParams(window.location.search);
  const skyParam = params.get("sky");
  const initialSky =
    skyParam && (skyParam === "Live" || skyParam in SKY_PRESETS)
      ? skyParam
      : "Live";
  const initialEngine =
    params.get("engine")?.toLowerCase() === "volumetric" ? "Volumetric" : "Wisps";
  // Controller rather than plain useDialKit because presets WRITE a dial:
  // picking a sky swings view.heading to that sky's postcard direction.
  const dial = useDialKitController(
    "Clouds",
    {
      // Two renderers, one sky (see clouds-wisps.tsx): Volumetric is the
      // physical @takram atmosphere; Wisps is the same presets as a single
      // procedural shader painting — far lighter, its own hand-tinted look.
      // Advanced and View belong to Volumetric only; Wisps has no camera.
      engine: {
        type: "select",
        options: ["Volumetric", "Wisps"],
        default: initialEngine,
      },
      sky: {
        type: "select",
        options: ["Live", ...Object.keys(SKY_PRESETS)],
        default: initialSky,
      },
      speed: [2, 0, 10, 0.1],
      fullness: [0.35, 0, 1, 0.01],
      intensity: [0.5, 0, 1, 0.01],
      size: [0.75, 0.1, 1, 0.01],
      advanced: {
        _collapsed: true,
        quality: {
          type: "select",
          options: ["low", "medium", "high", "ultra"],
          default: "high",
        },
        clumping: [2, 1, 8, 0.1],
        altitude: [1400, 200, 8000, 50],
        thickness: [800, 100, 2500, 25],
      },
      view: {
        _collapsed: true,
        longitude: [30, -180, 180, 0.5],
        latitude: [35, -85, 85, 0.5],
        height: [250, 10, 30000, 10],
        // The camera's position origin: an XY pad in metres east/north of
        // the geodetic anchor. Lat/lon steps are ~55 km — this is how you
        // actually walk under the clouds.
        origin: {
          type: "pad",
          x: [0, -4000, 4000, 25],
          y: [0, -4000, 4000, 25],
          labels: { x: "East", y: "North" },
        },
        heading: [35, 0, 360, 1],
        pitch: [22, -5, 85, 0.5],
      },
    } as DialConfig
  );
  const values = dial.values as unknown as CloudDials;

  // Selecting a sky swings the heading dial to that sky's postcard
  // direction (Live: the nearer stop's). setValue, not a derived value, so
  // the dial shows where it points and stays adjustable from there — the
  // frame loop then PANS to it.
  const setValue = dial.setValue;
  useEffect(() => {
    const heading =
      values.sky === "Live" ? liveSky().heading : SKY_PRESETS[values.sky].heading;
    setValue("view.heading", heading);
  }, [values.sky, setValue]);

  return (
    <div className="relative h-[100dvh] w-full bg-black">
      {/* Keyed swap, not co-mounting: the engines are separate WebGL
          contexts, and only the dialled one should own a context at all —
          that lightness is the wisps engine's whole reason to exist. */}
      {values.engine === "Wisps" ? (
        <WispsCanvas dials={values} />
      ) : (
        /* depth:false and multisampling 0 as upstream: the composer owns
           depth via its normal pass, and MSAA is wasted under temporal
           upscaling. fov 55 over R3F's default 75: a longer lens makes the
           wisps read as subjects instead of specks, and keeps the pale
           horizon band out of most of the frame so the blue stays
           saturated. */
        <Canvas gl={{ depth: false }} camera={{ near: 1, far: 4e5, fov: 55 }}>
          <Scene dials={values} />
        </Canvas>
      )}
      <DialRoot position="top-right" theme="dark" productionEnabled />
    </div>
  );
}
