import { Hono } from "hono";
import {
  HEALTH_SEVERITIES,
  HEALTH_STATUSES,
  type HealthScope,
} from "../domain/health-projection.js";
import type { HealthProjectionService } from "../domain/health-detectors.js";

const SCOPE_TYPES: HealthScope["type"][] = ["instance", "rig", "seat", "mission", "slice"];

export function healthRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const service = c.get("healthProjection" as never) as HealthProjectionService | undefined;
    if (!service) return c.json({ error: "health_projection_unavailable" }, 503);
    const scopeTypeRaw = c.req.query("scope_type");
    const scopeId = c.req.query("scope_id");
    if ((scopeTypeRaw === undefined) !== (scopeId === undefined)) {
      return c.json({ error: "scope_type and scope_id must be provided together" }, 400);
    }
    if (scopeTypeRaw !== undefined && !SCOPE_TYPES.includes(scopeTypeRaw as HealthScope["type"])) {
      return c.json({ error: `scope_type must be one of: ${SCOPE_TYPES.join(", ")}` }, 400);
    }
    const severity = c.req.query("severity");
    if (severity !== undefined && !HEALTH_SEVERITIES.includes(severity as never)) {
      return c.json({ error: `severity must be one of: ${HEALTH_SEVERITIES.join(", ")}` }, 400);
    }
    const status = c.req.query("status");
    if (status !== undefined && !HEALTH_STATUSES.includes(status as never)) {
      return c.json({ error: `status must be one of: ${HEALTH_STATUSES.join(", ")}` }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 100 : Number(limitRaw);
    try {
      return c.json(service.list({
        limit,
        scopeType: scopeTypeRaw as HealthScope["type"] | undefined,
        scopeId,
        severity: severity as (typeof HEALTH_SEVERITIES)[number] | undefined,
        status: status as (typeof HEALTH_STATUSES)[number] | undefined,
      }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get("/:findingId", (c) => {
    const service = c.get("healthProjection" as never) as HealthProjectionService | undefined;
    if (!service) return c.json({ error: "health_projection_unavailable" }, 503);
    const record = service.get(c.req.param("findingId"));
    return record ? c.json(record) : c.json({ error: "health_finding_not_found" }, 404);
  });

  return app;
}
