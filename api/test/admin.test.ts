import { describe, expect, it } from "vitest";
import { claveValida, validarUrlDestino } from "../src/admin.js";
import { descifrar } from "../src/secretos.js";
import { ADMIN, config, crearDestino, crearFuente, usarBaseDeDatos, webhookStandard } from "./ayuda.js";

const { db, app } = usarBaseDeDatos();

describe("autenticación", () => {
  it("CA-4.3: sin clave o con clave equivocada → 401", async () => {
    for (const headers of [{}, { authorization: "Bearer otra-clave-cualquiera-xx" }, { authorization: config.adminApiKey }]) {
      const r = await app.inject({ method: "GET", url: "/api/fuentes", headers });
      expect(r.statusCode).toBe(401);
    }
    expect(claveValida(`Bearer ${config.adminApiKey}`, config.adminApiKey)).toBe(true);
  });

  it("la recepción de webhooks no exige la clave de administración", async () => {
    const r = await app.inject({ method: "POST", url: "/in/x", payload: "{}" });
    expect(r.statusCode).toBe(404);
  });
});

describe("fuentes", () => {
  it("CA-4.1: crea una fuente Standard y devuelve URL y secreto una sola vez", async () => {
    const r = await app.inject({ method: "POST", url: "/api/fuentes", headers: ADMIN, payload: { slug: "wompi", nombre: "Wompi", tipo_firma: "standard" } });
    expect(r.statusCode).toBe(201);
    const f = r.json();
    expect(f.url_entrada).toBe("http://relevo.test/in/wompi");
    expect(f.secreto).toMatch(/^whsec_/);

    const lista = (await app.inject({ method: "GET", url: "/api/fuentes", headers: ADMIN })).json();
    expect(lista[0]).toMatchObject({ slug: "wompi", destinos: 0, tipo_firma: "standard" });
    expect(JSON.stringify(lista)).not.toContain(f.secreto); // no se vuelve a mostrar

    // Se guarda cifrado
    const { rows } = await db.query("SELECT secreto_cifrado FROM fuente");
    expect(rows[0].secreto_cifrado).not.toContain("whsec_");
    expect(descifrar(rows[0].secreto_cifrado, config.claveCifrado)).toBe(f.secreto);
  });

  it("valida el slug, exige secreto para GitHub y rechaza slugs repetidos", async () => {
    const crear = (payload: object) => app.inject({ method: "POST", url: "/api/fuentes", headers: ADMIN, payload });
    expect((await crear({ slug: "Mal Slug", nombre: "x", tipo_firma: "standard" })).statusCode).toBe(400);
    expect((await crear({ slug: "gh", nombre: "x", tipo_firma: "github" })).statusCode).toBe(400);
    expect((await crear({ slug: "ok", nombre: "x", tipo_firma: "otro" })).statusCode).toBe(400);
    expect((await crear({ slug: "ok", nombre: "x", tipo_firma: "standard", extra: 1 })).statusCode).toBe(400);
    expect((await crear({ slug: "ok", nombre: "x", tipo_firma: "standard" })).statusCode).toBe(201);
    const repetido = await crear({ slug: "ok", nombre: "y", tipo_firma: "standard" });
    expect(repetido.statusCode).toBe(409);
    expect(repetido.json()).toEqual({ error: "slug_en_uso" });
  });
});

describe("destinos", () => {
  it("CA-4.2: crea destinos, devuelve su secreto y valida la URL", async () => {
    const f = await crearFuente(app, "pagos");
    const d = await crearDestino(app, f.id, "https://mi-sistema.example/webhooks", ["pago.aprobado"]);
    expect(d.secreto).toMatch(/^whsec_/);
    const lista = (await app.inject({ method: "GET", url: `/api/fuentes/${f.id}/destinos`, headers: ADMIN })).json();
    expect(lista).toEqual([expect.objectContaining({ url: "https://mi-sistema.example/webhooks", filtro_tipos: ["pago.aprobado"], activo: true })]);

    const malo = await app.inject({ method: "POST", url: `/api/fuentes/${f.id}/destinos`, headers: ADMIN, payload: { url: "ftp://x" } });
    expect(malo.statusCode).toBe(400);
    const noExiste = await app.inject({ method: "POST", url: "/api/fuentes/00000000-0000-4000-8000-000000000000/destinos", headers: ADMIN, payload: { url: "https://a.b" } });
    expect(noExiste.statusCode).toBe(404);
  });

  it("en producción solo se permite https", () => {
    expect(validarUrlDestino("http://interno.local/x", false)).toBe("La URL debe usar https.");
    expect(validarUrlDestino("https://ok.example", false)).toBeNull();
    expect(validarUrlDestino("no es url", false)).toBe("La URL no es válida.");
  });

  it("PATCH activa/desactiva y cambia el filtro", async () => {
    const f = await crearFuente(app, "pagos");
    const d = await crearDestino(app, f.id, "https://a.example");
    const r = await app.inject({ method: "PATCH", url: `/api/destinos/${d.id}`, headers: ADMIN, payload: { activo: false, filtro_tipos: ["x"] } });
    expect(r.json()).toMatchObject({ activo: false, filtro_tipos: ["x"] });
    expect((await app.inject({ method: "PATCH", url: `/api/destinos/${d.id}`, headers: ADMIN, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/destinos/no-uuid", headers: ADMIN, payload: { activo: true } })).statusCode).toBe(400);
  });
});

describe("eventos", () => {
  it("CA-5.1: lista con estado resumido, filtros y paginación por cursor", async () => {
    const f = await crearFuente(app, "pagos");
    await crearDestino(app, f.id, "https://a.example");
    const otra = await crearFuente(app, "github-repo", "ninguna");
    for (let i = 0; i < 53; i++) await webhookStandard(app, "pagos", f.secreto!, { type: "pago", i });
    await app.inject({ method: "POST", url: "/in/github-repo", headers: { "content-type": "application/json" }, payload: '{"type":"push"}' });
    await db.query(`UPDATE envio SET estado = 'fallido' WHERE id IN (SELECT id FROM envio LIMIT 2)`);
    void otra;

    const p1 = (await app.inject({ method: "GET", url: "/api/eventos", headers: ADMIN })).json();
    expect(p1.items).toHaveLength(50);
    expect(p1.items[0]).toMatchObject({ fuente: "github-repo", estado_resumen: "sin_destinos" });
    const p2 = (await app.inject({ method: "GET", url: `/api/eventos?cursor=${p1.siguiente}`, headers: ADMIN })).json();
    expect(p2.items).toHaveLength(4);
    expect(p2.siguiente).toBeNull();
    const todos = [...p1.items, ...p2.items].map((e: { id: string }) => e.id);
    expect(new Set(todos).size).toBe(54); // sin repetidos entre páginas

    const fallidos = (await app.inject({ method: "GET", url: "/api/eventos?estado=fallido", headers: ADMIN })).json();
    expect(fallidos.items).toHaveLength(2);
    const deGithub = (await app.inject({ method: "GET", url: "/api/eventos?fuente=github-repo", headers: ADMIN })).json();
    expect(deGithub.items).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/eventos?cursor=basura", headers: ADMIN })).statusCode).toBe(400);
  });

  it("CA-5.2: el detalle trae cuerpo, cabeceras y la línea de tiempo por destino", async () => {
    const f = await crearFuente(app, "pagos");
    await crearDestino(app, f.id, "https://a.example");
    const r = await webhookStandard(app, "pagos", f.secreto!, { type: "pago.aprobado", monto: 7 });
    const { id: envioId } = (await db.query("SELECT id FROM envio")).rows[0];
    await db.query("INSERT INTO intento (envio_id, numero, codigo_http, duracion_ms, error) VALUES ($1, 1, 500, 40, 'HTTP 500')", [envioId]);

    const d = (await app.inject({ method: "GET", url: `/api/eventos/${r.json().evento_id}`, headers: ADMIN })).json();
    expect(d.evento).toMatchObject({ fuente: "pagos", tipo: "pago.aprobado", cuerpo: { monto: 7 } });
    expect(d.envios).toHaveLength(1);
    expect(d.envios[0]).toMatchObject({ destino_url: "https://a.example", estado: "pendiente" });
    expect(d.envios[0].intentos_detalle).toEqual([expect.objectContaining({ numero: 1, codigo_http: 500, error: "HTTP 500", manual: false })]);

    expect((await app.inject({ method: "GET", url: "/api/eventos/00000000-0000-4000-8000-000000000000", headers: ADMIN })).statusCode).toBe(404);
  });
});
