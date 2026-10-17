import { useEffect, useState } from "react";
import type { ApiSuccess, HealthData } from "@shared";
import { HEALTH_PATH } from "@shared";

type HealthStatus = "checking" | "ok" | "down";

/** The response body comes from the network, so check its shape instead of trusting it. */
function reportsHealthy(body: unknown): body is ApiSuccess<HealthData> {
  if (typeof body !== "object" || body === null) return false;
  if (!("success" in body) || body.success !== true || !("data" in body)) return false;
  const data = body.data;
  return typeof data === "object" && data !== null && "status" in data && data.status === "ok";
}

async function fetchHealth(signal: AbortSignal): Promise<HealthStatus> {
  try {
    const response = await fetch(HEALTH_PATH, { signal });
    if (!response.ok) return "down";
    const body: unknown = await response.json();
    return reportsHealthy(body) ? "ok" : "down";
  } catch (error) {
    if (signal.aborted) return "checking";
    console.warn("The API health check failed.", error);
    return "down";
  }
}

/** A small indicator that asks the API server whether it is up. */
export function HealthIndicator() {
  const [status, setStatus] = useState<HealthStatus>("checking");

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal).then((result) => {
      if (!controller.signal.aborted) setStatus(result);
    });
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <p role="status" aria-label="API health" data-status={status}>
      API: {status}
    </p>
  );
}
