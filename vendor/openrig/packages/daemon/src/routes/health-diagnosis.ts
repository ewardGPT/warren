import { Hono } from "hono";
import type { HealthDiagnosisService } from "../domain/health-diagnosis.js";
import type { HealthPolicyStore } from "../domain/health-policy.js";
import type { HealthCheckpointSource } from "../domain/health-checkpoints.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

export function healthDiagnosisRoutes(): Hono {
  const app = new Hono();
  app.onError((error, c) => c.json({ error: "health_diagnosis_refused", message: error.message }, 400));
  app.use("*", async (c, next) => {
    if (!c.get("healthDiagnosis" as never)) return c.json({ error: "health_diagnosis_unavailable" }, 503);
    try { await next(); } catch (error) { return c.json({ error: "health_diagnosis_refused", message: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.get("/policy", (c) => c.json({ ...(c.get("healthPolicy" as never) as HealthPolicyStore).read(), engine: (c.get("healthDiagnosis" as never) as HealthDiagnosisService).status() }));
  app.get("/checkpoints", (c) => c.json({ checkpoints: (c.get("healthCheckpoints" as never) as HealthCheckpointSource).entries(), coverage: "Authored outcome-boundary censuses; absence is not evidence of health." }));
  app.get("/", (c) => c.json((c.get("healthDiagnosis" as never) as HealthDiagnosisService).list()));
  app.get("/:id", (c) => c.json((c.get("healthDiagnosis" as never) as HealthDiagnosisService).show(c.req.param("id"))));
  app.post("*", async (c) => {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw) > 1048576) return c.json({ error: "health_request_too_large" }, 413);
    const body = JSON.parse(raw) as { actor?: string; value?: unknown; apply?: boolean };
    const sender = requireSenderIdentity(c, { verb: "health diagnosis", bodyClaim: body.actor });
    if (!sender.ok) return sender.response;
    const service = c.get("healthDiagnosis" as never) as HealthDiagnosisService;
    const route = c.req.path.split("/").slice(3);
    if (route[0] === "policy") return c.json((c.get("healthPolicy" as never) as HealthPolicyStore).apply(body.value, sender.session));
    if (route[0] === "checkpoints") return c.json((c.get("healthCheckpoints" as never) as HealthCheckpointSource).submit(body.value, sender.session));
    if (route[0] === "evaluate") {
      if (body.apply !== undefined && typeof body.apply !== "boolean") throw new Error("apply must be a boolean");
      return c.json(await service.evaluate(sender.session, body.apply === true));
    }
    if (route[1] === "disposition") return c.json(service.dispose(route[0]!, sender.session, body.value, resolveRecordedProvenance(c, sender)));
    if (route[1] === "notify") return c.json(await service.notify(route[0]!, sender.session, resolveRecordedProvenance(c, sender)));
    return c.json({ error: "not_found" }, 404);
  });
  return app;
}
