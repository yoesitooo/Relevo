/**
 * Secretos de firma: se generan con formato "whsec_<base64>" (Standard Webhooks)
 * y se guardan cifrados con AES-256-GCM. La clave de cifrado vive solo en el entorno.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function generarSecreto(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

/** Devuelve "v1:<iv>:<tag>:<cifrado>" en base64. */
export function cifrar(texto: string, clave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", clave, iv);
  const cifrado = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), cifrado.toString("base64")].join(":");
}

export function descifrar(guardado: string, clave: Buffer): string {
  const [version, iv, tag, cifrado] = guardado.split(":");
  if (version !== "v1" || !iv || !tag || !cifrado) throw new Error("Secreto cifrado con formato desconocido");
  const d = createDecipheriv("aes-256-gcm", clave, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(cifrado, "base64")), d.final()]).toString("utf8");
}
