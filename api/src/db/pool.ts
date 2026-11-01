import pg from "pg";

export type Db = pg.Pool;
export type Cliente = pg.PoolClient;

export function crearPool(databaseUrl: string): Db {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Ejecuta `fn` dentro de una transacción; hace ROLLBACK si lanza. */
export async function enTransaccion<T>(db: Db, fn: (c: Cliente) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
