# Diseño — Relevo

Un servicio Node.js con dos procesos que comparten la base de datos: la **API** (recibe y administra) y el **trabajador** (entrega). Un panel Angular consume la API de administración. Sin colas externas: PostgreSQL hace de cola con `FOR UPDATE SKIP LOCKED`, que es suficiente para miles de eventos por minuto y evita otra pieza que operar.

## Stack

- **Lenguaje:** TypeScript (estricto) sobre **Node.js 26 LTS**
- **API:** Fastify 5 (validación por esquemas, acceso al cuerpo crudo para verificar firmas)
- **Base de datos:** PostgreSQL 16 con SQL explícito (`pg`) y migraciones SQL versionadas
- **Panel:** Angular 22 (componentes standalone y signals)
- **Pruebas:** Vitest (unitarias e integración contra PostgreSQL real), Playwright para un flujo del panel
- **Entrega:** Docker Compose (api + worker + db + panel), GitHub Actions con servicio PostgreSQL, colección de Postman

## Componentes

| Componente | Responsabilidad |
|---|---|
| `firmas` | Verificar Standard Webhooks y GitHub; firmar envíos salientes (HMAC-SHA256, tiempo constante) |
| `recepcion` | `POST /in/:fuente`: verificar, deduplicar, guardar evento + envíos en una transacción |
| `admin` | API REST de fuentes, destinos, eventos y reenvíos, protegida con clave |
| `trabajador` | Tomar envíos vencidos, entregarlos, registrar intentos y programar reintentos |
| `reintentos` | Calcular la próxima espera (exponencial con aleatoriedad) |
| `secretos` | Generar secretos `whsec_…` y cifrarlos en reposo (AES-256-GCM con clave del entorno) |
| `panel` | Angular: login con clave, lista de eventos, detalle con línea de tiempo, reenviar |

## Modelo de datos

- **fuente**: `id uuid`, `slug text unique`, `nombre`, `tipo_firma ('standard'|'github'|'ninguna')`, `secreto_cifrado`, `activa bool`, `creada_en`
- **destino**: `id`, `fuente_id → fuente`, `url`, `filtro_tipos text[] (vacío = todos)`, `secreto_cifrado`, `activo`, `creado_en`
- **evento**: `id`, `fuente_id`, `id_externo text`, `tipo text`, `cuerpo jsonb`, `cabeceras jsonb`, `recibido_en`; **único (`fuente_id`, `id_externo`)**
- **envio**: `id`, `evento_id`, `destino_id`, `estado ('pendiente'|'entregado'|'fallido')`, `intentos int`, `proximo_intento_en timestamptz`, `actualizado_en`; índice parcial sobre (`proximo_intento_en`) donde `estado = 'pendiente'`
- **intento**: `id`, `envio_id`, `numero`, `codigo_http int null`, `duracion_ms`, `error text null`, `hecho_en`

## Contratos

### Recepción
- `POST /in/{slug}` — cuerpo crudo + cabeceras del proveedor →
  `202 {"evento_id"}` · `200 {"duplicado": true}` · `401 {"error": "firma_invalida" | "marca_de_tiempo_vencida"}` · `404 {"error": "fuente_no_encontrada"}`
- **Standard Webhooks:** cabeceras `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64>`, puede traer varias separadas por espacio). Contenido firmado: `{id}.{timestamp}.{cuerpo}`. Clave: secreto sin `whsec_`, decodificado de base64. Tolerancia: 300 s.
- **GitHub:** `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 del cuerpo; ID = `X-GitHub-Delivery`; tipo = `X-GitHub-Event`.
- **Tipo de evento (Standard):** campo `type` del JSON si existe; si no, `desconocido`.

### Administración (cabecera `Authorization: Bearer <ADMIN_API_KEY>`)
- `POST /api/fuentes {slug, nombre, tipo_firma}` → `201 {id, url_entrada, secreto?}`
- `GET /api/fuentes` → `200 [{id, slug, nombre, tipo_firma, activa, destinos: n}]`
- `POST /api/fuentes/{id}/destinos {url, filtro_tipos?}` → `201 {id, secreto}`
- `PATCH /api/destinos/{id} {activo?, filtro_tipos?}` → `200`
- `GET /api/eventos?fuente=&estado=&cursor=` → `200 {items: [{id, fuente, tipo, recibido_en, estado_resumen}], siguiente}` (paginación por cursor, 50 por página)
- `GET /api/eventos/{id}` → `200 {evento, envios: [{destino, estado, intentos: [...]}]}`
- `POST /api/envios/{id}/reenviar` → `202 {intento}`
- Errores: `400 {"error", "detalle"}` (validación), `401`, `404`.

### Entrega saliente
- `POST <url del destino>` con el cuerpo original y cabeceras Standard Webhooks firmadas con el secreto del destino; `webhook-id` = id del envío (estable entre reintentos, para que el destino deduplique).
- Éxito: cualquier 2xx. Tiempo máximo: 10 s.

### Funciones internas
- `verificarStandard(secreto, cabeceras, cuerpoCrudo, ahora) -> {ok} | {ok:false, motivo}`
- `verificarGithub(secreto, cabeceras, cuerpoCrudo) -> {ok} | {ok:false, motivo}`
- `firmarStandard(secreto, id, timestamp, cuerpo) -> "v1,<base64>"`
- `proximaEspera(intento: number, aleatorio = Math.random) -> ms | null` (null = sin más intentos)
- `tomarEnviosVencidos(db, limite) -> Envio[]` (usa `FOR UPDATE SKIP LOCKED`)

## Estructura de archivos

```
api/src/config.ts
api/src/db/pool.ts
api/src/db/migraciones/001_inicial.sql
api/src/db/migrar.ts
api/src/firmas.ts
api/src/secretos.ts
api/src/reintentos.ts
api/src/recepcion.ts
api/src/admin.ts
api/src/app.ts
api/src/servidor.ts
api/src/trabajador.ts
api/test/firmas.test.ts
api/test/reintentos.test.ts
api/test/recepcion.test.ts
api/test/admin.test.ts
api/test/trabajador.test.ts
panel/src/app/... (login, eventos, detalle-evento, servicio api)
postman/relevo.postman_collection.json
docker-compose.yml
.github/workflows/ci.yml
```

## Comandos

- **instalar:** `npm ci` (en `api/` y `panel/`)
- **probar:** `npm test` (API, requiere `DATABASE_URL` de prueba) · `npm run e2e` (panel)
- **ejecutar:** `docker compose up`

## Decisiones

- **PostgreSQL como cola** — `SKIP LOCKED` da entrega a una sola instancia sin Redis ni RabbitMQ; menos piezas para un MVP y transacción única entre evento y envíos.
- **Responder antes de reenviar** — los proveedores reintentan si tardas; la recepción solo guarda.
- **SQL explícito en vez de ORM** — las consultas clave (bloqueo, deduplicación con `ON CONFLICT`) quedan visibles y probadas.
- **Re-firmar al reenviar** — el destino verifica a Relevo con un secreto propio; los secretos de los proveedores nunca salen de Relevo.
- **ID de envío estable** — el destino puede deduplicar reintentos de Relevo.
