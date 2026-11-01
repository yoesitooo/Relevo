import { expect, it } from "vitest";
import { migrar } from "../src/db/migrar.js";
import { usarBaseDeDatos } from "./ayuda.js";

const { db } = usarBaseDeDatos();

it("T-1: migrar es idempotente y crea las 5 tablas", async () => {
  expect(await migrar(db)).toEqual([]); // ya se aplicó al preparar la base
  const { rows } = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  expect(rows.map((r) => r.tablename)).toEqual(["destino", "envio", "evento", "fuente", "intento", "migracion"]);
});
