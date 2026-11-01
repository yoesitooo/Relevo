# Plan de tareas — Relevo

## Orden de ejecución

- **Ola 1:** T-1
- **Ola 2** (en paralelo): T-2, T-3
- **Ola 3** (en paralelo): T-4, T-5, T-6
- **Ola 4:** T-7
- **Ola 5:** T-8

## T-1 — Base del proyecto y base de datos

Proyecto TypeScript, configuración, conexión a PostgreSQL y migración inicial con las 5 tablas, índices y la restricción única de deduplicación.

- **Cubre:** base para todas las historias
- **Archivos:** `api/package.json`, `api/tsconfig.json`, `api/src/config.ts`, `api/src/db/*`, `docker-compose.yml`
- **Lista cuando:** `npm run migrar` crea el esquema en una base vacía y es idempotente.

## T-2 — Firmas y secretos

Verificación Standard Webhooks (varias firmas, tolerancia de 300 s) y GitHub; firma saliente; secretos `whsec_` cifrados con AES-256-GCM.

- **Cubre:** CA-1.1, CA-1.2, CA-1.3, CA-3.4
- **Archivos:** `api/src/firmas.ts`, `api/src/secretos.ts`, `api/test/firmas.test.ts`
- **Depende de:** T-1
- **Lista cuando:** pruebas con los vectores de ejemplo de la especificación Standard Webhooks y de GitHub pasan; firma alterada, cuerpo alterado y marca vencida se rechazan.

## T-3 — Política de reintentos

Esperas 30 s, 2 min, 10 min, 1 h, 6 h con aleatoriedad de ±20 %: 6 intentos en total; `null` después del sexto.

- **Cubre:** CA-3.3
- **Archivos:** `api/src/reintentos.ts`, `api/test/reintentos.test.ts`
- **Depende de:** T-1
- **Lista cuando:** pruebas de rangos y del límite pasan.

## T-4 — Recepción de webhooks

`POST /in/:slug` con cuerpo crudo, verificación según la fuente, deduplicación con `ON CONFLICT DO NOTHING` y creación de envíos por destino que coincida con el filtro, en una transacción.

- **Cubre:** CA-1.1, CA-1.2, CA-1.3, CA-1.4, CA-2.1, CA-3.1
- **Archivos:** `api/src/recepcion.ts`, `api/src/app.ts`, `api/test/recepcion.test.ts`
- **Lee:** `api/src/firmas.ts`
- **Depende de:** T-2
- **Lista cuando:** pruebas de integración contra PostgreSQL cubren los 4 códigos de respuesta, la deduplicación y el filtro de tipos.

## T-5 — Trabajador de entregas

Bucle que toma envíos vencidos con `FOR UPDATE SKIP LOCKED`, firma, envía con tiempo máximo de 10 s, registra el intento y reprograma o cierra.

- **Cubre:** CA-3.2, CA-3.3, CA-3.4, CA-3.5
- **Archivos:** `api/src/trabajador.ts`, `api/test/trabajador.test.ts`
- **Lee:** `api/src/firmas.ts`, `api/src/reintentos.ts`
- **Depende de:** T-2, T-3
- **Lista cuando:** con un destino de prueba local: entrega exitosa, reintento tras 500, fallo final tras 6 intentos, y dos trabajadores en paralelo nunca entregan el mismo envío dos veces.

## T-6 — API de administración

Rutas de fuentes, destinos, eventos (paginación por cursor) y reenvío, con clave de administrador y validación por esquemas.

- **Cubre:** CA-4.1, CA-4.2, CA-4.3, CA-5.1, CA-5.2, CA-5.3
- **Archivos:** `api/src/admin.ts`, `api/src/servidor.ts`, `api/test/admin.test.ts`
- **Lee:** `api/src/secretos.ts`
- **Depende de:** T-2
- **Lista cuando:** pruebas de integración de cada ruta, incluidos `400` y `401`.

## T-7 — Panel en Angular

Login con clave, lista de eventos con filtros, detalle con línea de tiempo de intentos y botón "Reenviar".

- **Cubre:** CA-5.1, CA-5.2, CA-5.3
- **Archivos:** `panel/**`
- **Depende de:** T-6 (usa sus contratos)
- **Lista cuando:** prueba de Playwright: entrar, filtrar, abrir un evento y reenviar.

## T-8 — Entrega y documentación

Docker Compose completo, CI con PostgreSQL, colección de Postman con ejemplos firmados y README con diagrama.

- **Cubre:** requisitos no funcionales
- **Archivos:** `.github/workflows/ci.yml`, `postman/relevo.postman_collection.json`, `README.md`
- **Depende de:** T-4, T-5, T-6, T-7
- **Lista cuando:** CI en verde y `docker compose up` deja el sistema funcionando con un evento de ejemplo.
