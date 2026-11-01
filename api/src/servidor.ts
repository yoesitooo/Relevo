import { construirApp } from "./app.js";
import { leerConfig } from "./config.js";
import { migrar } from "./db/migrar.js";
import { crearPool } from "./db/pool.js";

const config = leerConfig();
const db = crearPool(config.databaseUrl);
await migrar(db);
const app = construirApp(db, config, { logger: true });

for (const s of ["SIGINT", "SIGTERM"] as const) {
  process.on(s, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.puerto, host: "0.0.0.0" });
