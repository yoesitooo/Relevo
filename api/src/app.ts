/**
 * Construye la aplicación Fastify (sin escuchar): así las pruebas la usan con inject().
 */
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { registrarAdmin } from "./admin.js";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import { registrarRecepcion } from "./recepcion.js";

export function construirApp(db: Db, config: Config, opciones: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opciones.logger ?? false,
    // Los proveedores reintentan si tardas: corta peticiones lentas
    requestTimeout: 15_000,
    // Campos desconocidos → 400 (por defecto Fastify los borra en silencio y un
    // error de tipeo como "filtro_tipo" pasaría sin aviso)
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(cors, { origin: config.origenesPanel, methods: ["GET", "POST", "PATCH"] });
  app.get("/salud", async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });
  registrarRecepcion(app, db, config);
  registrarAdmin(app, db, config);
  app.setErrorHandler((err: FastifyError, req, res) => {
    if (err.validation) return res.code(400).send({ error: "validacion", detalle: err.message });
    req.log.error(err);
    return res.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: "interno" });
  });
  return app;
}
