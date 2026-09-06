// The lazy-load seam for /clouds. The scene is three.js + R3F + the takram
// geospatial stack — none of it should land in the concept-board bundle,
// and the shaders / 3D noise textures should only ever load on this route.

import { lazy, Suspense } from "react";

const CloudsScene = lazy(() => import("./clouds-scene"));

export default function CloudsClient() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[100dvh] w-full items-center justify-center bg-black">
          <span className="text-[11px] uppercase tracking-[0.2em] text-white/40">
            Loading sky…
          </span>
        </div>
      }
    >
      <CloudsScene />
    </Suspense>
  );
}
