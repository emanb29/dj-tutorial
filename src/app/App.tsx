import { lazy, Suspense } from "react";
import { HealthIndicator } from "./HealthIndicator.tsx";

// The dev playground loads the audio engine and the controller, so it is a separate chunk.
const Playground = lazy(() => import("./playground/Playground.tsx").then((module) => ({ default: module.Playground })));

export const PLAYGROUND_PATH = "/playground";

/**
 * The playground is a developer tool: on the dev server (including the owner's tunnel) it is always
 * there; in a production build it needs an explicit `?playground` flag (the end-to-end tests use it).
 */
export function playgroundEnabled(location: { pathname: string; search: string }, devServer: boolean): boolean {
  if (location.pathname.replace(/\/$/, "") !== PLAYGROUND_PATH) return false;
  return devServer || new URLSearchParams(location.search).has("playground");
}

export function App() {
  if (playgroundEnabled(window.location, import.meta.env.DEV)) {
    return (
      <Suspense fallback={null}>
        <Playground />
      </Suspense>
    );
  }
  return (
    <main>
      <h1>Learn to DJ</h1>
      <HealthIndicator />
    </main>
  );
}
