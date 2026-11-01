/**
 * Política de reintentos: espera exponencial con ±20 % de aleatoriedad (para que
 * muchos envíos fallidos a la vez no reintenten todos en el mismo instante).
 *
 * Intento 1 inmediato; si falla, reintentos tras 30 s, 2 min, 10 min, 1 h y 6 h.
 * Total: 6 intentos en ~7 horas; después el envío queda como fallido.
 */
export const ESPERAS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const MAX_INTENTOS = ESPERAS_MS.length + 1;
const VARIACION = 0.2;

/**
 * @param intentosHechos cuántos intentos fallidos van (1 = falló el primero)
 * @returns milisegundos hasta el siguiente intento, o null si no hay más
 */
export function proximaEspera(intentosHechos: number, aleatorio: () => number = Math.random): number | null {
  const base = ESPERAS_MS[intentosHechos - 1];
  if (base === undefined) return null;
  const factor = 1 + (aleatorio() * 2 - 1) * VARIACION;
  return Math.round(base * factor);
}
