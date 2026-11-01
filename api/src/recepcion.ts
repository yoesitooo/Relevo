/**
 * Recepción: POST /in/:slug
 *
 * 1. Busca la fuente activa (404 si no existe).
 * 2. Verifica la firma sobre el CUERPO CRUDO (401 si no es válida o está vencida).
 * 3. En una transacción guarda el evento (deduplicado por fuente + ID externo) y
 *    crea un envío pendiente por cada destino activo cuyo filtro de tipos coincida.
 * 4. Responde 202 de inmediato: la entrega la hace el trabajador.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { enTransaccion, type Db } from "./db/pool.js";
import { type Cabeceras, verificarGithub, verificarStandard } from "./firmas.js";
import { descifrar } from "./secretos.js";

interface Fuente {
  id: string;
  tipo_firma: "standard" | "github" | "ninguna";
  secreto_cifrado: string | null;
}

// Cabeceras que no se guardan (credenciales o ruido de infraestructura)
const NO_GUARDAR = new Set(["authorization", "cookie", "x-forwarded-for", "x-real-ip"]);

function uno(c: Cabeceras, nombre: string): string | undefined {
  const v = c[nombre];
  return Array.isArray(v) ? v[0] : v;
}

export function identificar(tipo: Fuente["tipo_firma"], c: Cabeceras, cuerpo: unknown): { idExterno: string; tipo: string } {
  const tipoJson =
    cuerpo && typeof cuerpo === "object" && typeof (cuerpo as { type?: unknown }).type === "string"
      ? (cuerpo as { type: string }).type
      : "desconocido";
  if (tipo === "github") {
    return { idExterno: uno(c, "x-github-delivery") ?? randomUUID(), tipo: uno(c, "x-github-event") ?? "desconocido" };
  }
  // standard y ninguna: webhook-id si viene (en "ninguna" sin ID no hay deduplicación posible)
  return { idExterno: uno(c, "webhook-id") ?? randomUUID(), tipo: tipoJson };
}

export function registrarRecepcion(app: FastifyInstance, db: Db, config: Config): void {
  app.register(async (rutas) => {
    // En este ámbito el cuerpo llega crudo (Buffer): la firma se calcula sobre los bytes exactos
    rutas.removeAllContentTypeParsers();
    rutas.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, cuerpo, hecho) => {
      hecho(null, cuerpo);
    });

    rutas.post<{ Params: { slug: string } }>("/in/:slug", async (req, res) => {
      const { rows } = await db.query<Fuente>(
        "SELECT id, tipo_firma, secreto_cifrado FROM fuente WHERE slug = $1 AND activa",
        [req.params.slug],
      );
      const fuente = rows[0];
      if (!fuente) return res.code(404).send({ error: "fuente_no_encontrada" });

      const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const cabeceras = req.headers as Cabeceras;

      if (fuente.tipo_firma !== "ninguna") {
        const secreto = descifrar(fuente.secreto_cifrado ?? "", config.claveCifrado);
        const v =
          fuente.tipo_firma === "github"
            ? verificarGithub(secreto, cabeceras, crudo)
            : verificarStandard(secreto, cabeceras, crudo);
        if (!v.ok) {
          req.log.warn({ fuente: req.params.slug, motivo: v.motivo }, "webhook rechazado");
          return res.code(401).send({ error: v.motivo });
        }
      }

      let cuerpo: unknown;
      try {
        cuerpo = JSON.parse(crudo.toString("utf8"));
      } catch {
        return res.code(400).send({ error: "cuerpo_invalido", detalle: "El cuerpo debe ser JSON." });
      }

      const { idExterno, tipo } = identificar(fuente.tipo_firma, cabeceras, cuerpo);
      const guardar = Object.fromEntries(Object.entries(cabeceras).filter(([k]) => !NO_GUARDAR.has(k)));

      const eventoId = await enTransaccion(db, async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO evento (fuente_id, id_externo, tipo, cuerpo, cabeceras)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ON CONSTRAINT ux_evento_fuente_externo DO NOTHING
           RETURNING id`,
          [fuente.id, idExterno, tipo, JSON.stringify(cuerpo), JSON.stringify(guardar)],
        );
        const id = ins.rows[0]?.id;
        if (!id) return null; // duplicado
        await c.query(
          `INSERT INTO envio (evento_id, destino_id)
           SELECT $1, d.id FROM destino d
           WHERE d.fuente_id = $2 AND d.activo
             AND (cardinality(d.filtro_tipos) = 0 OR $3 = ANY (d.filtro_tipos))`,
          [id, fuente.id, tipo],
        );
        return id;
      });

      if (!eventoId) return res.code(200).send({ duplicado: true });
      return res.code(202).send({ evento_id: eventoId });
    });
  });
}
