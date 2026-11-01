import { afterEach, describe, expect, it } from "vitest";
import { verificarStandard } from "../src/firmas.js";
import { MAX_INTENTOS } from "../src/reintentos.js";
import { procesarLote, tomarEnviosVencidos } from "../src/trabajador.js";
import { ADMIN, config, crearDestino, crearFuente, destinoFalso, usarBaseDeDatos, webhookStandard } from "./ayuda.js";

const { db, app } = usarBaseDeDatos();
const cerrar: (() => Promise<void>)[] = [];
afterEach(async () => { while (cerrar.length) await cerrar.pop()!(); });

async function preparar(responder?: Parameters<typeof destinoFalso>[0]) {
  const destino = await destinoFalso(responder);
  cerrar.push(destino.cerrar);
  const f = await crearFuente(app, "pagos");
  const d = await crearDestino(app, f.id, destino.url);
  return { destino, f, d };
}

async function envio() {
  const { rows } = await db.query("SELECT estado, intentos, proximo_intento_en FROM envio");
  return rows[0];
}

/** Hace que el envío pendiente "venza" ya, para no esperar los minutos reales. */
const vencerYa = () => db.query("UPDATE envio SET proximo_intento_en = now() WHERE estado = 'pendiente'");

describe("trabajador", () => {
  it("CA-3.2 y CA-3.4: entrega con 2xx, firmado con el secreto del destino, y lo registra", async () => {
    const { destino, f, d } = await preparar();
    await webhookStandard(app, "pagos", f.secreto!, { type: "pago.aprobado", monto: 10 });

    expect(await procesarLote(db, config)).toBe(1);

    expect(destino.recibidas).toHaveLength(1);
    const p = destino.recibidas[0]!;
    expect(JSON.parse(p.cuerpo)).toEqual({ type: "pago.aprobado", monto: 10 });
    // El destino puede verificar que viene de Relevo con SU secreto
    expect(verificarStandard(d.secreto, p.cabeceras as Record<string, string>, Buffer.from(p.cuerpo))).toEqual({ ok: true });
    expect(await envio()).toMatchObject({ estado: "entregado", intentos: 1 });
    const i = await db.query("SELECT codigo_http, error FROM intento");
    expect(i.rows[0]).toEqual({ codigo_http: 200, error: null });
  });

  it("CA-3.3: reintenta con espera y marca fallido después del último intento", async () => {
    const { destino, f } = await preparar(() => ({ codigo: 503 }));
    await webhookStandard(app, "pagos", f.secreto!, { type: "x" });

    await procesarLote(db, config);
    const tras1 = await envio();
    expect(tras1).toMatchObject({ estado: "pendiente", intentos: 1 });
    const espera = (new Date(tras1.proximo_intento_en).getTime() - Date.now()) / 1000;
    expect(espera).toBeGreaterThan(20); // 30 s ±20 %
    expect(espera).toBeLessThan(37);

    // Sin vencer, no se vuelve a tomar
    expect(await procesarLote(db, config)).toBe(0);

    for (let n = 2; n <= MAX_INTENTOS; n++) {
      await vencerYa();
      await procesarLote(db, config);
    }
    expect(await envio()).toMatchObject({ estado: "fallido", intentos: MAX_INTENTOS });
    expect(destino.recibidas).toHaveLength(MAX_INTENTOS);
    // El webhook-id es el mismo en todos los reintentos: el destino puede deduplicar
    expect(new Set(destino.recibidas.map((r) => r.cabeceras["webhook-id"])).size).toBe(1);
    const errores = await db.query("SELECT DISTINCT error FROM intento");
    expect(errores.rows).toEqual([{ error: "HTTP 503" }]);
  });

  it("CA-3.3: un destino que no responde a tiempo cuenta como fallo", async () => {
    const { f } = await preparar(() => ({ demoraMs: 2000 }));
    await webhookStandard(app, "pagos", f.secreto!, { type: "x" });
    await procesarLote(db, config, 10, 200);
    const i = await db.query("SELECT codigo_http, error FROM intento");
    expect(i.rows[0]).toEqual({ codigo_http: null, error: "sin respuesta en 0.2 s" });
    expect(await envio()).toMatchObject({ estado: "pendiente", intentos: 1 });
  });

  it("CA-3.5: dos trabajadores en paralelo nunca entregan el mismo envío dos veces", async () => {
    const { destino, f } = await preparar(() => ({ demoraMs: 20 }));
    for (let i = 0; i < 40; i++) await webhookStandard(app, "pagos", f.secreto!, { type: "x", i });

    // Cuatro trabajadores compiten por la misma cola hasta vaciarla
    const trabajador = async () => { while ((await procesarLote(db, config, 5)) > 0); };
    await Promise.all([trabajador(), trabajador(), trabajador(), trabajador()]);

    expect(destino.recibidas).toHaveLength(40);
    const ids = destino.recibidas.map((r) => r.cabeceras["webhook-id"]);
    expect(new Set(ids).size).toBe(40);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM envio WHERE estado = 'entregado'");
    expect(rows[0].n).toBe(40);
  });

  it("un envío tomado queda reservado (arriendo) y no lo ve otro trabajador", async () => {
    const { f } = await preparar();
    await webhookStandard(app, "pagos", f.secreto!, { type: "x" });
    expect(await tomarEnviosVencidos(db)).toHaveLength(1);
    expect(await tomarEnviosVencidos(db)).toHaveLength(0);
  });

  it("CA-5.3: reenviar a mano un envío fallido crea un intento inmediato", async () => {
    let falla = true;
    const { destino, f } = await preparar(() => ({ codigo: falla ? 500 : 204 }));
    await webhookStandard(app, "pagos", f.secreto!, { type: "x" });
    await db.query("UPDATE envio SET estado = 'fallido'");
    const { id } = (await db.query("SELECT id FROM envio")).rows[0];

    falla = true;
    const malo = await app.inject({ method: "POST", url: `/api/envios/${id}/reenviar`, headers: ADMIN });
    expect(malo.statusCode).toBe(202);
    expect(malo.json().intento).toMatchObject({ exito: false, codigo_http: 500, numero: 1 });
    expect(await envio()).toMatchObject({ estado: "fallido" }); // no reabre la cola

    falla = false;
    const bueno = await app.inject({ method: "POST", url: `/api/envios/${id}/reenviar`, headers: ADMIN });
    expect(bueno.json().intento).toMatchObject({ exito: true, codigo_http: 204, numero: 2 });
    expect(await envio()).toMatchObject({ estado: "entregado" });
    const manuales = await db.query("SELECT count(*)::int AS n FROM intento WHERE manual");
    expect(manuales.rows[0].n).toBe(2);
    expect(destino.recibidas).toHaveLength(2);
  });
});
