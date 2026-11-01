/**
 * Aplica las migraciones SQL en orden, una sola vez cada una (idempotente).
 * Uso: npm run migrar
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./pool.js";
import { crearPool } from "./pool.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migraciones");

export async function migrar(db: Db, dir = DIR): Promise<string[]> {
  const c = await db.connect();
  try {
    // Un solo proceso migra a la vez (si arrancan api y trabajador juntos)
    await c.query("SELECT pg_advisory_lock(727274)");
    await c.query(`CREATE TABLE IF NOT EXISTS migracion (
      nombre text PRIMARY KEY, aplicada_en timestamptz NOT NULL DEFAULT now())`);
    const hechas = new Set((await c.query<{ nombre: string }>("SELECT nombre FROM migracion")).rows.map((r) => r.nombre));
    const archivos = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const aplicadas: string[] = [];
    for (const archivo of archivos) {
      if (hechas.has(archivo)) continue;
      const sql = await readFile(path.join(dir, archivo), "utf8");
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query("INSERT INTO migracion (nombre) VALUES ($1)", [archivo]);
        await c.query("COMMIT");
        aplicadas.push(archivo);
      } catch (e) {
        await c.query("ROLLBACK");
        throw new Error(`Migración ${archivo} falló: ${(e as Error).message}`);
      }
    }
    return aplicadas;
  } finally {
    await c.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    c.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Falta DATABASE_URL");
  const db = crearPool(url);
  const aplicadas = await migrar(db);
  console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.join(", ")}` : "Base de datos al día.");
  await db.end();
}
