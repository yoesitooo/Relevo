/** Utilidades de prueba: base de datos limpia, app y un destino HTTP de mentira. */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { construirApp } from "../src/app.js";
import { type Config, leerConfig } from "../src/config.js";
import { migrar } from "../src/db/migrar.js";
import { crearPool, type Db } from "../src/db/pool.js";
import { firmarStandard } from "../src/firmas.js";

process.env.DATABASE_URL ??= "postgresql://relevo:relevo@localhost:5432/relevo_test";

export const config: Config = leerConfig();
export const ADMIN = { authorization: `Bearer ${config.adminApiKey}` };

/** Prepara una base limpia para el archivo de pruebas y la vacía antes de cada prueba. */
export function usarBaseDeDatos(): { db: Db; app: ReturnType<typeof construirApp> } {
  const db = crearPool(config.databaseUrl);
  const app = construirApp(db, config);
  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrar(db);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE fuente, destino, evento, envio, intento CASCADE");
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });
  return { db, app };
}

/** Crea una fuente por la API y devuelve su id, slug y secreto. */
export async function crearFuente(
  app: ReturnType<typeof construirApp>,
  slug: string,
  tipo_firma: "standard" | "github" | "ninguna" = "standard",
  secreto?: string,
) {
  const r = await app.inject({ method: "POST", url: "/api/fuentes", headers: ADMIN, payload: { slug, nombre: slug, tipo_firma, secreto } });
  if (r.statusCode !== 201) throw new Error(`crearFuente: ${r.statusCode} ${r.body}`);
  const cuerpo = r.json() as { id: string; secreto?: string; url_entrada: string };
  return { ...cuerpo, slug, secreto: cuerpo.secreto ?? secreto };
}

export async function crearDestino(app: ReturnType<typeof construirApp>, fuenteId: string, url: string, filtro_tipos?: string[]) {
  const r = await app.inject({ method: "POST", url: `/api/fuentes/${fuenteId}/destinos`, headers: ADMIN, payload: { url, filtro_tipos } });
  if (r.statusCode !== 201) throw new Error(`crearDestino: ${r.statusCode} ${r.body}`);
  return r.json() as { id: string; secreto: string };
}

/** Envía un webhook firmado con Standard Webhooks. */
export function webhookStandard(app: ReturnType<typeof construirApp>, slug: string, secreto: string, cuerpo: object, opciones: { id?: string; timestamp?: number } = {}) {
  const texto = JSON.stringify(cuerpo);
  const id = opciones.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = opciones.timestamp ?? Math.floor(Date.now() / 1000);
  return app.inject({
    method: "POST",
    url: `/in/${slug}`,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": firmarStandard(secreto, id, timestamp, texto),
    },
    payload: texto,
  });
}

export interface PeticionRecibida {
  cabeceras: IncomingMessage["headers"];
  cuerpo: string;
}

/** Servidor HTTP local que hace de destino; `responder` decide el código o la demora. */
export async function destinoFalso(responder: (n: number) => { codigo?: number; demoraMs?: number } = () => ({ codigo: 200 })) {
  const recibidas: PeticionRecibida[] = [];
  const server: Server = createServer((req, res) => {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      recibidas.push({ cabeceras: req.headers, cuerpo });
      const { codigo = 200, demoraMs = 0 } = responder(recibidas.length);
      setTimeout(() => res.writeHead(codigo).end("ok"), demoraMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/webhook`,
    recibidas,
    cerrar: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
