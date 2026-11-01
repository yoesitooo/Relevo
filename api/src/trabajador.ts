/**
 * Trabajador de entregas
 *
 * Usa PostgreSQL como cola. Para no mantener transacciones abiertas mientras se
 * espera la respuesta del destino (hasta 10 s), cada envío se "reserva" con un
 * arriendo: en una sola sentencia se toman los envíos vencidos con
 * FOR UPDATE SKIP LOCKED y se les corre `proximo_intento_en` unos minutos.
 * Así dos trabajadores nunca toman el mismo envío; si un trabajador muere a
 * mitad de una entrega, el arriendo vence y otro lo reintenta (entrega
 * "al menos una vez": el destino deduplica con webhook-id, que es el ID del envío).
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { leerConfig } from "./config.js";
import type { Cliente, Db } from "./db/pool.js";
import { migrar } from "./db/migrar.js";
import { crearPool } from "./db/pool.js";
import { firmarStandard } from "./firmas.js";
import { MAX_INTENTOS, proximaEspera } from "./reintentos.js";
import { descifrar } from "./secretos.js";

export const TIEMPO_MAXIMO_MS = 10_000;
const ARRIENDO = "5 minutes";

export interface EnvioReservado {
  id: string;
  intentos: number;
  url: string;
  secreto_cifrado: string;
  cuerpo: unknown;
}

export interface ResultadoIntento {
  numero: number;
  codigo_http: number | null;
  duracion_ms: number;
  error: string | null;
  exito: boolean;
}

export async function tomarEnviosVencidos(db: Db | Cliente, limite = 10): Promise<EnvioReservado[]> {
  const { rows } = await db.query<EnvioReservado>(
    `WITH tomados AS (
       SELECT id FROM envio
       WHERE estado = 'pendiente' AND proximo_intento_en <= now()
       ORDER BY proximo_intento_en
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE envio e SET proximo_intento_en = now() + interval '${ARRIENDO}', actualizado_en = now()
     FROM tomados t, destino d, evento ev
     WHERE e.id = t.id AND d.id = e.destino_id AND ev.id = e.evento_id
     RETURNING e.id, e.intentos, d.url, d.secreto_cifrado, ev.cuerpo`,
    [limite],
  );
  return rows;
}

/** Hace UNA petición al destino, firmada con el secreto del destino. */
export async function enviarHttp(
  envio: EnvioReservado,
  config: Config,
  tiempoMaximoMs = TIEMPO_MAXIMO_MS,
  ahora = Date.now(),
): Promise<Omit<ResultadoIntento, "numero">> {
  const cuerpo = JSON.stringify(envio.cuerpo);
  const timestamp = Math.floor(ahora / 1000);
  const secreto = descifrar(envio.secreto_cifrado, config.claveCifrado);
  const inicio = performance.now();
  try {
    const r = await fetch(envio.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Relevo/0.1",
        "webhook-id": envio.id, // estable entre reintentos: el destino puede deduplicar
        "webhook-timestamp": String(timestamp),
        "webhook-signature": firmarStandard(secreto, envio.id, timestamp, cuerpo),
      },
      body: cuerpo,
      redirect: "manual",
      signal: AbortSignal.timeout(tiempoMaximoMs),
    });
    await r.body?.cancel(); // no se necesita la respuesta
    const exito = r.status >= 200 && r.status < 300;
    return { codigo_http: r.status, duracion_ms: Math.round(performance.now() - inicio), error: exito ? null : `HTTP ${r.status}`, exito };
  } catch (e) {
    const err = e as Error;
    const mensaje = err.name === "TimeoutError" ? `sin respuesta en ${tiempoMaximoMs / 1000} s` : err.message;
    return { codigo_http: null, duracion_ms: Math.round(performance.now() - inicio), error: mensaje, exito: false };
  }
}

/** Entrega un envío reservado, registra el intento y reprograma o cierra el envío. */
export async function entregar(
  db: Db,
  envio: EnvioReservado,
  config: Config,
  manual = false,
  tiempoMaximoMs = TIEMPO_MAXIMO_MS,
): Promise<ResultadoIntento> {
  const r = await enviarHttp(envio, config, tiempoMaximoMs);
  const numero = envio.intentos + 1;
  await db.query(
    "INSERT INTO intento (envio_id, numero, manual, codigo_http, duracion_ms, error) VALUES ($1, $2, $3, $4, $5, $6)",
    [envio.id, numero, manual, r.codigo_http, r.duracion_ms, r.error],
  );
  if (r.exito) {
    await db.query("UPDATE envio SET estado = 'entregado', intentos = $2, actualizado_en = now() WHERE id = $1", [envio.id, numero]);
  } else if (manual) {
    // Un reenvío manual fallido no reabre la cola: queda como estaba (fallido o pendiente)
    await db.query("UPDATE envio SET intentos = $2, actualizado_en = now() WHERE id = $1", [envio.id, numero]);
  } else {
    const espera = proximaEspera(numero);
    if (espera === null) {
      await db.query("UPDATE envio SET estado = 'fallido', intentos = $2, actualizado_en = now() WHERE id = $1", [envio.id, numero]);
    } else {
      await db.query(
        `UPDATE envio SET intentos = $2, proximo_intento_en = now() + ($3 || ' milliseconds')::interval, actualizado_en = now()
         WHERE id = $1`,
        [envio.id, numero, String(espera)],
      );
    }
  }
  return { numero, ...r };
}

/** Una vuelta: toma lo vencido y lo entrega en paralelo. Devuelve cuántos procesó. */
export async function procesarLote(db: Db, config: Config, limite = 10, tiempoMaximoMs = TIEMPO_MAXIMO_MS): Promise<number> {
  const envios = await tomarEnviosVencidos(db, limite);
  await Promise.all(envios.map((e) => entregar(db, e, config, false, tiempoMaximoMs)));
  return envios.length;
}

/** Archivo de "latido": el chequeo de salud de Docker verifica que se actualice. */
export const ARCHIVO_LATIDO = process.env.ARCHIVO_LATIDO ?? "/tmp/relevo-latido";

export async function iniciarTrabajador(db: Db, config: Config, señal: AbortSignal, pausaMs = 1000): Promise<void> {
  console.log(`Trabajador activo (hasta ${MAX_INTENTOS} intentos por envío).`);
  while (!señal.aborted) {
    await writeFile(ARCHIVO_LATIDO, String(Date.now())).catch(() => {});
    try {
      const n = await procesarLote(db, config);
      if (n === 0) await new Promise((r) => setTimeout(r, pausaMs));
    } catch (e) {
      console.error("Error en el trabajador; reintento en 5 s:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = leerConfig();
  const db = crearPool(config.databaseUrl);
  await migrar(db); // si arranca antes que la API, igual encuentra las tablas (hay un candado entre ambos)
  const control = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => control.abort());
  await iniciarTrabajador(db, config, control.signal);
  await db.end();
}
