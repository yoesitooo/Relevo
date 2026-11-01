import { describe, expect, it } from "vitest";
import { firmarGithub } from "../src/firmas.js";
import { crearDestino, crearFuente, usarBaseDeDatos, webhookStandard } from "./ayuda.js";

const { db, app } = usarBaseDeDatos();

async function contar(tabla: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabla}`);
  return rows[0]!.n;
}

describe("POST /in/:slug — Standard Webhooks", () => {
  it("CA-1.1: firma válida → 202, guarda el evento y crea un envío por destino", async () => {
    const f = await crearFuente(app, "pagos");
    await crearDestino(app, f.id, "http://127.0.0.1:9/a");
    await crearDestino(app, f.id, "http://127.0.0.1:9/b");

    const inicio = performance.now();
    const r = await webhookStandard(app, "pagos", f.secreto!, { type: "pago.aprobado", monto: 50000 });
    const ms = performance.now() - inicio;

    expect(r.statusCode).toBe(202);
    expect(ms).toBeLessThan(200); // no espera a los destinos
    const ev = await db.query("SELECT tipo, cuerpo FROM evento WHERE id = $1", [r.json().evento_id]);
    expect(ev.rows[0]).toMatchObject({ tipo: "pago.aprobado", cuerpo: { type: "pago.aprobado", monto: 50000 } });
    expect(await contar("envio")).toBe(2);
  });

  it("CA-1.2: firma inválida → 401 y no guarda nada", async () => {
    const f = await crearFuente(app, "pagos");
    const r = await webhookStandard(app, "pagos", "whsec_" + Buffer.alloc(24, 1).toString("base64"), { type: "x" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "firma_invalida" });
    expect(await contar("evento")).toBe(0);
    expect(f.secreto).toMatch(/^whsec_/);
  });

  it("CA-1.2: cuerpo alterado después de firmar → 401", async () => {
    const f = await crearFuente(app, "pagos");
    const firmado = await webhookStandard(app, "pagos", f.secreto!, { type: "x", monto: 1 });
    expect(firmado.statusCode).toBe(202);
    const id = "msg_alterado";
    const ts = Math.floor(Date.now() / 1000);
    const { firmarStandard } = await import("../src/firmas.js");
    const r = await app.inject({
      method: "POST", url: "/in/pagos",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts),
        "webhook-signature": firmarStandard(f.secreto!, id, ts, '{"type":"x","monto":1}') },
      payload: '{"type":"x","monto":1000000}',
    });
    expect(r.statusCode).toBe(401);
  });

  it("CA-1.3: marca de tiempo de hace más de 5 minutos → 401", async () => {
    const f = await crearFuente(app, "pagos");
    const r = await webhookStandard(app, "pagos", f.secreto!, { type: "x" }, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: "marca_de_tiempo_vencida" });
  });

  it("CA-1.4: fuente inexistente o desactivada → 404", async () => {
    expect((await webhookStandard(app, "no-existe", "whsec_AAAA", {})).statusCode).toBe(404);
    const f = await crearFuente(app, "vieja");
    await db.query("UPDATE fuente SET activa = false WHERE id = $1", [f.id]);
    expect((await webhookStandard(app, "vieja", f.secreto!, {})).statusCode).toBe(404);
  });

  it("CA-2.1: el mismo webhook-id no se guarda ni se reenvía dos veces", async () => {
    const f = await crearFuente(app, "pagos");
    await crearDestino(app, f.id, "http://127.0.0.1:9/a");
    const a = await webhookStandard(app, "pagos", f.secreto!, { type: "x" }, { id: "msg_repetido" });
    const b = await webhookStandard(app, "pagos", f.secreto!, { type: "x" }, { id: "msg_repetido" });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ duplicado: true });
    expect(await contar("evento")).toBe(1);
    expect(await contar("envio")).toBe(1);
  });

  it("el mismo webhook-id en otra fuente sí es un evento distinto", async () => {
    const a = await crearFuente(app, "uno");
    const b = await crearFuente(app, "dos");
    await webhookStandard(app, "uno", a.secreto!, {}, { id: "msg_1" });
    await webhookStandard(app, "dos", b.secreto!, {}, { id: "msg_1" });
    expect(await contar("evento")).toBe(2);
  });

  it("CA-3.1: solo crea envíos para destinos activos cuyo filtro coincide", async () => {
    const f = await crearFuente(app, "pagos");
    await crearDestino(app, f.id, "http://127.0.0.1:9/todos");
    await crearDestino(app, f.id, "http://127.0.0.1:9/solo-aprobados", ["pago.aprobado"]);
    await crearDestino(app, f.id, "http://127.0.0.1:9/solo-rechazados", ["pago.rechazado"]);
    const inactivo = await crearDestino(app, f.id, "http://127.0.0.1:9/inactivo");
    await db.query("UPDATE destino SET activo = false WHERE id = $1", [inactivo.id]);

    await webhookStandard(app, "pagos", f.secreto!, { type: "pago.aprobado" });
    const { rows } = await db.query<{ url: string }>("SELECT d.url FROM envio e JOIN destino d ON d.id = e.destino_id ORDER BY d.url");
    expect(rows.map((r) => r.url)).toEqual(["http://127.0.0.1:9/solo-aprobados", "http://127.0.0.1:9/todos"]);
  });

  it("no guarda cabeceras sensibles", async () => {
    const f = await crearFuente(app, "pagos", "ninguna");
    const r = await app.inject({
      method: "POST", url: "/in/pagos",
      headers: { "content-type": "application/json", authorization: "Bearer algo", cookie: "s=1", "x-proveedor": "si" },
      payload: "{}",
    });
    const { rows } = await db.query("SELECT cabeceras FROM evento WHERE id = $1", [r.json().evento_id]);
    expect(rows[0].cabeceras).toMatchObject({ "x-proveedor": "si" });
    expect(rows[0].cabeceras).not.toHaveProperty("authorization");
    expect(rows[0].cabeceras).not.toHaveProperty("cookie");
    expect(f.secreto).toBeUndefined();
  });

  it("cuerpo que no es JSON → 400", async () => {
    await crearFuente(app, "libre", "ninguna");
    const r = await app.inject({ method: "POST", url: "/in/libre", headers: { "content-type": "text/plain" }, payload: "hola" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("cuerpo_invalido");
  });
});

describe("POST /in/:slug — GitHub", () => {
  const SECRETO = "secreto-de-github-123";

  it("verifica X-Hub-Signature-256 y usa X-GitHub-Delivery y X-GitHub-Event", async () => {
    await crearFuente(app, "repo", "github", SECRETO);
    const cuerpo = JSON.stringify({ action: "opened", number: 7 });
    const cabeceras = {
      "content-type": "application/json",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-github-event": "pull_request",
      "x-hub-signature-256": firmarGithub(SECRETO, cuerpo),
    };
    const ok = await app.inject({ method: "POST", url: "/in/repo", headers: cabeceras, payload: cuerpo });
    expect(ok.statusCode).toBe(202);
    const ev = await db.query("SELECT id_externo, tipo FROM evento");
    expect(ev.rows[0]).toEqual({ id_externo: "72d3162e-cc78-11e3-81ab-4c9367dc0958", tipo: "pull_request" });

    const repetido = await app.inject({ method: "POST", url: "/in/repo", headers: cabeceras, payload: cuerpo });
    expect(repetido.statusCode).toBe(200);

    const malo = await app.inject({ method: "POST", url: "/in/repo", headers: { ...cabeceras, "x-hub-signature-256": firmarGithub("otro", cuerpo) }, payload: cuerpo });
    expect(malo.statusCode).toBe(401);
  });
});
