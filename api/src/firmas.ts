/**
 * Firmas de webhooks (HMAC-SHA256), siempre comparadas en tiempo constante.
 *
 * Standard Webhooks (Svix, Resend, OpenAI…): cabeceras webhook-id, webhook-timestamp y
 * webhook-signature ("v1,<base64>", puede traer varias separadas por espacio).
 * Contenido firmado: "{id}.{timestamp}.{cuerpo}". Clave: secreto sin "whsec_", en base64.
 *
 * GitHub: X-Hub-Signature-256 = "sha256=<hex>" del cuerpo crudo.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOLERANCIA_SEGUNDOS = 300;

export type Cabeceras = Record<string, string | string[] | undefined>;
export type Verificacion = { ok: true } | { ok: false; motivo: "firma_invalida" | "marca_de_tiempo_vencida" };

function cabecera(c: Cabeceras, nombre: string): string | undefined {
  const v = c[nombre.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function iguales(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function claveStandard(secreto: string): Buffer {
  return Buffer.from(secreto.startsWith("whsec_") ? secreto.slice(6) : secreto, "base64");
}

export function firmarStandard(secreto: string, id: string, timestamp: number, cuerpo: string | Buffer): string {
  const hmac = createHmac("sha256", claveStandard(secreto));
  hmac.update(`${id}.${timestamp}.`);
  hmac.update(cuerpo);
  return `v1,${hmac.digest("base64")}`;
}

export function verificarStandard(
  secreto: string,
  cabeceras: Cabeceras,
  cuerpo: Buffer,
  ahora: Date = new Date(),
): Verificacion {
  const id = cabecera(cabeceras, "webhook-id");
  const ts = cabecera(cabeceras, "webhook-timestamp");
  const firmas = cabecera(cabeceras, "webhook-signature");
  if (!id || !ts || !firmas || !/^\d+$/.test(ts)) return { ok: false, motivo: "firma_invalida" };

  const timestamp = Number(ts);
  if (Math.abs(ahora.getTime() / 1000 - timestamp) > TOLERANCIA_SEGUNDOS) {
    return { ok: false, motivo: "marca_de_tiempo_vencida" };
  }

  const esperada = Buffer.from(firmarStandard(secreto, id, timestamp, cuerpo).slice(3), "base64");
  const valida = firmas.split(" ").some((f) => {
    const [version, valor] = f.split(",", 2);
    return version === "v1" && !!valor && iguales(Buffer.from(valor, "base64"), esperada);
  });
  return valida ? { ok: true } : { ok: false, motivo: "firma_invalida" };
}

export function firmarGithub(secreto: string, cuerpo: string | Buffer): string {
  return `sha256=${createHmac("sha256", secreto).update(cuerpo).digest("hex")}`;
}

export function verificarGithub(secreto: string, cabeceras: Cabeceras, cuerpo: Buffer): Verificacion {
  const firma = cabecera(cabeceras, "x-hub-signature-256");
  if (!firma?.startsWith("sha256=")) return { ok: false, motivo: "firma_invalida" };
  const recibida = Buffer.from(firma.slice(7), "hex");
  const esperada = Buffer.from(firmarGithub(secreto, cuerpo).slice(7), "hex");
  return iguales(recibida, esperada) ? { ok: true } : { ok: false, motivo: "firma_invalida" };
}
