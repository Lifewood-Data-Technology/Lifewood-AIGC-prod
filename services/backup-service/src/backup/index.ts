import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadBackupConfig } from "./config.js";
import { BackupEngine } from "./engine.js";
import { MysqlWasabiAdapter } from "./mysql-wasabi.js";
import { buildBackupServer } from "./server.js";

const config = loadBackupConfig();
await mkdir(config.root, { recursive: true, mode: 0o700 });
// One process owns a vault. A stale lock after a crash requires the operator
// to confirm the old process is stopped before removing this one lock file.
const lockPath = join(config.root, ".service.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.write(String(process.pid));
const engine = new BackupEngine(config.root, config.key, new MysqlWasabiAdapter(config));
const app = buildBackupServer(config.token, engine);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await engine.idle();
  await lock.close();
  await unlink(lockPath);
}
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
try {
  await engine.initialize();
  await app.listen({ host: config.host, port: config.port });
} catch {
  // Never log connection strings, provider errors, or SQL output.
  process.stderr.write("Backup service startup failed; check configuration, access and the dedicated vault lock.\n");
  await lock.close();
  await unlink(lockPath);
  process.exitCode = 1;
}
