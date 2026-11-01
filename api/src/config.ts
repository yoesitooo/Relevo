/**
 * Configuración leída del entorno. Falla al arrancar si falta algo obligatorio,
 * en vez de fallar a mitad de una petición.
 */

function requerida(nombre: string): string {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example).`);
  return valor;
}

export interface Config {
  databaseUrl: string;
  adminApiKey: string;
  /** Clave AES-256 (32 bytes en base64) para cifrar los secretos en la base de datos. */
  claveCifrado: Buffer;
  urlPublica: string;
  /** Solo para desarrollo y pruebas: permite destinos http:// */
  permitirHttp: boolean;
  puerto: number;
  origenesPanel: string[];
}

export function leerConfig(): Config {
  const clave = Buffer.from(requerida("CLAVE_CIFRADO"), "base64");
  if (clave.length !== 32) {
    throw new Error("CLAVE_CIFRADO debe ser 32 bytes en base64. Genérala con: openssl rand -base64 32");
  }
  const adminApiKey = requerida("ADMIN_API_KEY");
  if (adminApiKey.length < 20) throw new Error("ADMIN_API_KEY debe tener al menos 20 caracteres.");
  return {
    databaseUrl: requerida("DATABASE_URL"),
    adminApiKey,
    claveCifrado: clave,
    urlPublica: (process.env.URL_PUBLICA ?? "http://localhost:3000").replace(/\/$/, ""),
    permitirHttp: process.env.PERMITIR_HTTP === "true",
    puerto: Number(process.env.PORT ?? 3000),
    origenesPanel: (process.env.ORIGENES_PANEL ?? "http://localhost:4200").split(",").map((o) => o.trim()),
  };
}
