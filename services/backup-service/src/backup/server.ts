import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { BackupEngine } from "./engine.js";
import { validBackupCommand } from "./contract.js";

export function buildBackupServer(token: string, engine: BackupEngine) {
  const app = Fastify({ bodyLimit: 2048, logger: false });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const authorization = request.headers.authorization ?? "";
    const supplied = Buffer.from(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply.code(401).send({ error: "AUTH_REQUIRED" });
    const actor = request.headers["x-actor-email"];
    if (request.headers["x-access-role"] !== "system" || typeof actor !== "string" || actor.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)) return reply.code(403).send({ error: "ADMIN_REQUIRED" });
  });
  app.get("/v1/backups", async () => engine.status());
  app.post("/v1/backups", async (request, reply) => {
    if (!validBackupCommand(request.body)) return reply.code(400).send({ error: "INVALID_COMMAND" });
    try {
      const job = await engine.submit(request.body, String(request.headers["x-actor-email"]));
      return reply.code(202).send({ job });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const allowed = ["JOB_BUSY", "BACKUP_NOT_READY", "IDEMPOTENCY_CONFLICT", "RESTORE_NOT_CONFIGURED"];
      return reply.code(allowed.includes(code) ? 409 : 503).send({ error: allowed.includes(code) ? code : "BACKUP_SERVICE_UNAVAILABLE" });
    }
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: "INVALID_REQUEST" }));
  return app;
}
