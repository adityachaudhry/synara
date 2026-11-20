/**
 * `GET /metrics`: controller health in the Prometheus text format, for Glasswing's Prometheus on the
 * Railway private network. Only private hosts may read it (no token: a failed scrape must mean the
 * controller is down, not that a credential drifted).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { renderMetrics } from "../controllerMetrics.ts";
import { privateHost } from "./diligenceRoute.ts";

export const metricsRouteLayer = HttpRouter.add("GET", "/metrics", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!privateHost(request.headers.host)) return HttpServerResponse.text("not found", { status: 404 });
  return HttpServerResponse.text(renderMetrics(), { status: 200, contentType: "text/plain; version=0.0.4; charset=utf-8" });
}));
