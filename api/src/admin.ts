/**
 * API de administración (/api/*), protegida con `Authorization: Bearer <ADMIN_API_KEY>`.
 * Fuentes, destinos, eventos (paginación por cursor) y reenvío manual.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import type { Db } from "./db/pool.js";
import { cifrar, generarSecreto } from "./secretos.js";
import { entregar, type EnvioReservado } from "./trabajador.js";

const TAMANO_PAGINA = 50;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const paramId = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: UUID } } } as const;

export function claveValida(recibida: string | undefined, esperada: string): boolean {
  if (!recibida?.startsWith("Bearer ")) return false;
  const a = Buffer.from(recibida.slice(7));
  const b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validarUrlDestino(url: string, permitirHttp: boolean): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "La URL no es válida.";
  }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && permitirHttp) return null;
  return permitirHttp ? "La URL debe ser http o https." : "La URL debe usar https.";
}

// Cursor opaco: "recibido_en|id" en base64url
const codificar = (fecha: Date, id: string) => Buffer.from(`${fecha.toISOString()}|${id}`).toString("base64url");
function decodificar(cursor: string): [string, string] | null {
  const [fecha, id] = Buffer.from(cursor, "base64url").toString().split("|");
  return fecha && id && !Number.isNaN(Date.parse(fecha)) && new RegExp(UUID).test(id) ? [fecha, id] : null;
}

export function registrarAdmin(app: FastifyInstance, db: Db, config: Config): void {
  app.register(
    async (api) => {
      api.addHook("onRequest", async (req: FastifyRequest, res: FastifyReply) => {
        if (!claveValida(req.headers.authorization, config.adminApiKey)) {
          return res.code(401).send({ error: "no_autorizado" });
        }
      });

      // ── Fuentes ──────────────────────────────────────────────────────────
      api.post<{ Body: { slug: string; nombre: string; tipo_firma: "standard" | "github" | "ninguna"; secreto?: string } }>(
        "/fuentes",
        {
          schema: {
            body: {
              type: "object",
              required: ["slug", "nombre", "tipo_firma"],
              additionalProperties: false,
              properties: {
                slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,48}$" },
                nombre: { type: "string", minLength: 1, maxLength: 100 },
                tipo_firma: { enum: ["standard", "github", "ninguna"] },
                // GitHub no genera el secreto: lo eliges tú y lo pegas en GitHub y aquí
                secreto: { type: "string", minLength: 16, maxLength: 200 },
              },
            },
          },
        },
        async (req, res) => {
          const { slug, nombre, tipo_firma } = req.body;
          if (tipo_firma === "github" && !req.body.secreto) {
            return res.code(400).send({ error: "validacion", detalle: "Para GitHub envía el 'secreto' que configuraste en el webhook." });
          }
          const secreto = tipo_firma === "standard" ? generarSecreto() : tipo_firma === "github" ? req.body.secreto! : null;
          try {
            const { rows } = await db.query<{ id: string }>(
              "INSERT INTO fuente (slug, nombre, tipo_firma, secreto_cifrado) VALUES ($1, $2, $3, $4) RETURNING id",
              [slug, nombre, tipo_firma, secreto ? cifrar(secreto, config.claveCifrado) : null],
            );
            return res.code(201).send({
              id: rows[0]!.id,
              url_entrada: `${config.urlPublica}/in/${slug}`,
              ...(tipo_firma === "standard" ? { secreto } : {}), // solo se muestra esta vez
            });
          } catch (e) {
            if ((e as { code?: string }).code === "23505") return res.code(409).send({ error: "slug_en_uso" });
            throw e;
          }
        },
      );

      api.get("/fuentes", async () => {
        const { rows } = await db.query(
          `SELECT f.id, f.slug, f.nombre, f.tipo_firma, f.activa, f.creada_en,
                  count(d.id)::int AS destinos
           FROM fuente f LEFT JOIN destino d ON d.fuente_id = f.id
           GROUP BY f.id ORDER BY f.creada_en DESC`,
        );
        return rows.map((r) => ({ ...r, url_entrada: `${config.urlPublica}/in/${r.slug}` }));
      });

      // ── Destinos ─────────────────────────────────────────────────────────
      api.post<{ Params: { id: string }; Body: { url: string; filtro_tipos?: string[] } }>(
        "/fuentes/:id/destinos",
        {
          schema: {
            params: paramId,
            body: {
              type: "object",
              required: ["url"],
              additionalProperties: false,
              properties: {
                url: { type: "string", maxLength: 2000 },
                filtro_tipos: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } },
              },
            },
          },
        },
        async (req, res) => {
          const error = validarUrlDestino(req.body.url, config.permitirHttp);
          if (error) return res.code(400).send({ error: "validacion", detalle: error });
          const existe = await db.query("SELECT 1 FROM fuente WHERE id = $1", [req.params.id]);
          if (!existe.rowCount) return res.code(404).send({ error: "fuente_no_encontrada" });
          const secreto = generarSecreto();
          const { rows } = await db.query<{ id: string }>(
            "INSERT INTO destino (fuente_id, url, filtro_tipos, secreto_cifrado) VALUES ($1, $2, $3, $4) RETURNING id",
            [req.params.id, req.body.url, req.body.filtro_tipos ?? [], cifrar(secreto, config.claveCifrado)],
          );
          return res.code(201).send({ id: rows[0]!.id, secreto });
        },
      );

      api.get<{ Params: { id: string } }>("/fuentes/:id/destinos", { schema: { params: paramId } }, async (req) => {
        const { rows } = await db.query(
          "SELECT id, url, filtro_tipos, activo, creado_en FROM destino WHERE fuente_id = $1 ORDER BY creado_en",
          [req.params.id],
        );
        return rows;
      });

      api.patch<{ Params: { id: string }; Body: { activo?: boolean; filtro_tipos?: string[] } }>(
        "/destinos/:id",
        {
          schema: {
            params: paramId,
            body: {
              type: "object",
              additionalProperties: false,
              minProperties: 1,
              properties: {
                activo: { type: "boolean" },
                filtro_tipos: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 100 } },
              },
            },
          },
        },
        async (req, res) => {
          const { rows } = await db.query(
            `UPDATE destino SET activo = COALESCE($2, activo), filtro_tipos = COALESCE($3, filtro_tipos)
             WHERE id = $1 RETURNING id, url, filtro_tipos, activo`,
            [req.params.id, req.body.activo ?? null, req.body.filtro_tipos ?? null],
          );
          return rows[0] ?? res.code(404).send({ error: "destino_no_encontrado" });
        },
      );

      // ── Eventos ──────────────────────────────────────────────────────────
      api.get<{ Querystring: { fuente?: string; estado?: string; cursor?: string } }>(
        "/eventos",
        {
          schema: {
            querystring: {
              type: "object",
              additionalProperties: false,
              properties: {
                fuente: { type: "string", maxLength: 50 },
                estado: { enum: ["pendiente", "entregado", "fallido", "sin_destinos"] },
                cursor: { type: "string", maxLength: 200 },
              },
            },
          },
        },
        async (req, res) => {
          const { fuente, estado, cursor } = req.query;
          const desde = cursor ? decodificar(cursor) : null;
          if (cursor && !desde) return res.code(400).send({ error: "validacion", detalle: "cursor inválido" });
          // estado_resumen: fallido si alguno falló; pendiente si alguno sigue; entregado si todos llegaron
          const { rows } = await db.query<{ id: string; recibido_en: Date }>(
            `SELECT * FROM (
               SELECT ev.id, f.slug AS fuente, ev.tipo, ev.recibido_en,
                      CASE WHEN count(e.id) = 0 THEN 'sin_destinos'
                           WHEN bool_or(e.estado = 'fallido') THEN 'fallido'
                           WHEN bool_or(e.estado = 'pendiente') THEN 'pendiente'
                           ELSE 'entregado' END AS estado_resumen
               FROM evento ev
               JOIN fuente f ON f.id = ev.fuente_id
               LEFT JOIN envio e ON e.evento_id = ev.id
               WHERE ($1::text IS NULL OR f.slug = $1)
                 AND ($2::timestamptz IS NULL OR (ev.recibido_en, ev.id) < ($2::timestamptz, $3::uuid))
               GROUP BY ev.id, f.slug
             ) x
             WHERE ($4::text IS NULL OR x.estado_resumen = $4)
             ORDER BY x.recibido_en DESC, x.id DESC
             LIMIT ${TAMANO_PAGINA + 1}`,
            [fuente ?? null, desde?.[0] ?? null, desde?.[1] ?? null, estado ?? null],
          );
          const items = rows.slice(0, TAMANO_PAGINA);
          const ultimo = items[items.length - 1];
          return { items, siguiente: rows.length > TAMANO_PAGINA && ultimo ? codificar(ultimo.recibido_en, ultimo.id) : null };
        },
      );

      api.get<{ Params: { id: string } }>("/eventos/:id", { schema: { params: paramId } }, async (req, res) => {
        const ev = await db.query(
          `SELECT ev.id, f.slug AS fuente, ev.id_externo, ev.tipo, ev.cuerpo, ev.cabeceras, ev.recibido_en
           FROM evento ev JOIN fuente f ON f.id = ev.fuente_id WHERE ev.id = $1`,
          [req.params.id],
        );
        if (!ev.rows[0]) return res.code(404).send({ error: "evento_no_encontrado" });
        const envios = await db.query(
          `SELECT e.id, e.estado, e.intentos, e.proximo_intento_en, d.id AS destino_id, d.url AS destino_url,
                  COALESCE(json_agg(json_build_object(
                    'numero', i.numero, 'manual', i.manual, 'codigo_http', i.codigo_http,
                    'duracion_ms', i.duracion_ms, 'error', i.error, 'hecho_en', i.hecho_en)
                    ORDER BY i.numero) FILTER (WHERE i.id IS NOT NULL), '[]') AS intentos_detalle
           FROM envio e JOIN destino d ON d.id = e.destino_id
           LEFT JOIN intento i ON i.envio_id = e.id
           WHERE e.evento_id = $1 GROUP BY e.id, d.id ORDER BY d.url`,
          [req.params.id],
        );
        return { evento: ev.rows[0], envios: envios.rows };
      });

      // ── Reenvío manual ───────────────────────────────────────────────────
      api.post<{ Params: { id: string } }>("/envios/:id/reenviar", { schema: { params: paramId } }, async (req, res) => {
        const { rows } = await db.query<EnvioReservado>(
          `SELECT e.id, e.intentos, d.url, d.secreto_cifrado, ev.cuerpo
           FROM envio e JOIN destino d ON d.id = e.destino_id JOIN evento ev ON ev.id = e.evento_id
           WHERE e.id = $1`,
          [req.params.id],
        );
        if (!rows[0]) return res.code(404).send({ error: "envio_no_encontrado" });
        const intento = await entregar(db, rows[0], config, true);
        return res.code(202).send({ intento });
      });
    },
    { prefix: "/api" },
  );
}
