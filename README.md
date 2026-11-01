# Relevo

![CI](https://github.com/yoesitooo/Relevo/actions/workflows/ci.yml/badge.svg)
![Node.js](https://img.shields.io/badge/Node.js-26_LTS-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Angular](https://img.shields.io/badge/Angular-22-DD0031?logo=angular&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)

**Relé de webhooks: recibe los webhooks de tus proveedores, verifica que sean auténticos, evita duplicados y los entrega a tus sistemas con reintentos, con un panel para ver qué pasó y reenviar.**

> **🇬🇧 In English — at a glance**
>
> Relevo is a webhook relay. Providers (payment gateways, GitHub, SaaS tools) post to `/in/{source}`; Relevo verifies the signature over the raw body (**Standard Webhooks** and **GitHub**, constant-time, 5-minute replay window), stores the event **once** (deduplicated by provider message ID), answers `202` immediately, and a worker delivers it to every matching destination with **exponential backoff + jitter**, re-signing each request with the destination's own secret. An **Angular 22** panel lists events and their delivery timeline and lets you redeliver.
>
> | What it demonstrates | Where to look |
> |---|---|
> | **PostgreSQL as a queue**: `FOR UPDATE SKIP LOCKED` + a lease, so concurrent workers never deliver the same item (a test with 4 workers proves it, and fails if the lock is removed) | [`api/src/trabajador.ts`](./api/src/trabajador.ts) · [`api/test/trabajador.test.ts`](./api/test/trabajador.test.ts) |
> | Webhook security: HMAC-SHA256 verification checked against published examples, timing-safe compare, replay window, secrets encrypted at rest (AES-256-GCM) | [`api/src/firmas.ts`](./api/src/firmas.ts) · [`api/src/secretos.ts`](./api/src/secretos.ts) |
> | Idempotent ingestion in one transaction (`ON CONFLICT DO NOTHING`) | [`api/src/recepcion.ts`](./api/src/recepcion.ts) |
> | REST admin API (Fastify, schema validation that rejects unknown fields, cursor pagination) + **Postman collection** run by Newman in CI | [`api/src/admin.ts`](./api/src/admin.ts) · [`postman/`](./postman) |
> | Angular 22 panel (standalone components, signals, HTTP interceptor) with a Playwright end-to-end test | [`panel/`](./panel) |
> | Spec-first: requirements with EARS acceptance criteria, design with contracts, task plan — written before the code | [`specs/`](./specs) |
> | CI: 38 API tests on real PostgreSQL, browser e2e, Postman run, and `docker compose up` + demo delivery | [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) |

---

## El problema

Un proveedor (una pasarela de pagos, GitHub, una herramienta SaaS) te avisa de algo enviando un webhook. Si tu sistema está caído en ese momento, el aviso se pierde. Si el proveedor lo reenvía, lo procesas dos veces. Y cuando algo falla, nadie sabe qué llegó ni cuándo.

Relevo se pone en medio:

```mermaid
sequenceDiagram
  participant P as Proveedor
  participant R as Relevo (API)
  participant DB as PostgreSQL
  participant T as Trabajador
  participant D as Tu sistema
  P->>R: POST /in/pagos (firmado)
  R->>R: verifica firma y marca de tiempo
  R->>DB: evento + envíos (1 transacción, sin duplicados)
  R-->>P: 202 en milisegundos
  loop cada segundo
    T->>DB: toma envíos vencidos (SKIP LOCKED)
    T->>D: POST firmado con el secreto del destino
    alt 2xx
      T->>DB: entregado
    else error o más de 10 s
      T->>DB: reintento en 30 s · 2 min · 10 min · 1 h · 6 h
    end
  end
```

## Qué hace

- **Verifica firmas** de [Standard Webhooks](https://www.standardwebhooks.com/) (Svix, Resend, OpenAI y otros) y de **GitHub**, sobre el cuerpo crudo, comparando en tiempo constante. Rechaza marcas de tiempo de hace más de 5 minutos (repeticiones).
- **No procesa dos veces**: el mismo `webhook-id` (o `X-GitHub-Delivery`) se guarda una sola vez por fuente.
- **Entrega con reintentos**: 6 intentos en unas 7 horas con espera exponencial y aleatoriedad; luego queda como fallido y se puede reenviar a mano.
- **Re-firma** cada entrega con el secreto propio del destino, para que tu sistema verifique que viene de Relevo; el `webhook-id` es estable entre reintentos para que puedas deduplicar.
- **Filtra por tipo** de evento por destino (por ejemplo, solo `pago.aprobado`).
- **Panel** para ver eventos, la línea de tiempo de intentos y reenviar.

| Lista de eventos | Detalle con intentos y reenvío |
|---|---|
| ![Lista de eventos](docs/img/panel-eventos.png) | ![Detalle de un evento](docs/img/panel-detalle.png) |

## Probarlo en 2 minutos (Docker)

```bash
git clone https://github.com/yoesitooo/Relevo.git && cd Relevo
cp .env.example .env
docker compose up --build
```

- Panel: http://localhost:4200 (clave: la de `ADMIN_API_KEY` en `.env`)
- API: http://localhost:3000

En otra terminal, envía un webhook firmado de ejemplo:

```bash
docker compose exec api node dist/demo.js
```

Crea una fuente con un destino (un "sistema interno" de ejemplo) y le envía un pago firmado. Lo verás en el panel como **Entregado** y en `docker compose logs receptor-demo`.

### Con Postman

Importa [`postman/relevo.postman_collection.json`](./postman/relevo.postman_collection.json) y ejecútala completa (*Run collection*): crea una fuente y un destino, envía un webhook **firmado por un script previo** igual que lo haría el proveedor, comprueba la deduplicación, el rechazo de firmas falsas y el reenvío manual. Ajusta las variables `base_url` y `admin_key`.

### Conectar GitHub de verdad

1. Expón la API (por ejemplo con `cloudflared tunnel --url http://localhost:3000`) y pon esa URL en `URL_PUBLICA`.
2. Crea la fuente: `POST /api/fuentes {"slug": "mi-repo", "nombre": "Mi repo", "tipo_firma": "github", "secreto": "<un secreto largo>"}`.
3. En GitHub → *Settings → Webhooks*: *Payload URL* = `url_entrada` de la respuesta, *Content type* = `application/json`, *Secret* = el mismo secreto.
4. Agrega tus destinos con `POST /api/fuentes/{id}/destinos`.

## API

Todas las rutas `/api/*` requieren `Authorization: Bearer <ADMIN_API_KEY>`.

| Método y ruta | Qué hace | Respuestas |
|---|---|---|
| `POST /in/{slug}` | Recibe un webhook del proveedor | `202 {evento_id}` · `200 {duplicado}` · `400` · `401 {error: firma_invalida \| marca_de_tiempo_vencida}` · `404` |
| `POST /api/fuentes` | Crea una fuente (`standard`, `github` o `ninguna`) | `201 {id, url_entrada, secreto?}` · `400` · `409 slug_en_uso` |
| `GET /api/fuentes` | Lista fuentes | `200` |
| `POST /api/fuentes/{id}/destinos` | Agrega un destino (`url`, `filtro_tipos?`) | `201 {id, secreto}` · `400` · `404` |
| `GET /api/fuentes/{id}/destinos` | Lista destinos | `200` |
| `PATCH /api/destinos/{id}` | Activa/desactiva o cambia el filtro | `200` · `400` · `404` |
| `GET /api/eventos?fuente=&estado=&cursor=` | Eventos con estado resumido, 50 por página | `200 {items, siguiente}` |
| `GET /api/eventos/{id}` | Detalle: cuerpo, cabeceras y envíos con sus intentos | `200` · `404` |
| `POST /api/envios/{id}/reenviar` | Intento inmediato | `202 {intento}` |
| `GET /salud` | Comprobación de estado | `200` |

Los secretos (`secreto`) solo se muestran al crear; se guardan cifrados.

## Decisiones de diseño

- **PostgreSQL como cola, no Redis ni RabbitMQ.** `FOR UPDATE SKIP LOCKED` reparte el trabajo entre trabajadores sin que dos tomen el mismo envío, y el evento y sus envíos se guardan en la misma transacción. Una pieza menos que operar.
- **Arriendo en vez de transacciones largas.** Al tomar un envío se le corre la hora unos minutos; así no se mantiene una transacción abierta mientras el destino responde. Si un trabajador muere, el arriendo vence y otro lo reintenta: entrega *al menos una vez*, con `webhook-id` estable para deduplicar.
- **Responder antes de reenviar.** Los proveedores reintentan si tardas; la recepción solo verifica y guarda.
- **SQL explícito.** Las consultas que importan (bloqueo, deduplicación con `ON CONFLICT`, paginación por cursor) quedan a la vista y probadas.
- **Campos desconocidos → 400.** Fastify por defecto los borra en silencio; aquí un error como `filtro_tipo` se reporta.

Las especificaciones completas, escritas antes del código, están en [`specs/`](./specs): [requisitos](./specs/requisitos.md) (historias, criterios EARS y casos de uso), [diseño](./specs/diseno.md) (contratos y modelo de datos) y [tareas](./specs/tareas.md).

## Desarrollo sin Docker

```bash
# Requiere Node.js 22+ y PostgreSQL
cd api && npm ci
export DATABASE_URL=postgresql://relevo:relevo@localhost:5432/relevo  # y las variables de .env.example
npm run dev            # API en :3000 (aplica migraciones al arrancar)
npm run trabajador     # en otra terminal
cd ../panel && npm ci && npm start   # panel en :4200
```

## Pruebas

```bash
cd api && DATABASE_URL=postgresql://…/relevo_test npm test   # 38 pruebas contra PostgreSQL real
cd panel && npm run build && RELEVO_API=http://localhost:3000 ADMIN_API_KEY=… npm run e2e
```

- **Firmas:** se comprueban contra ejemplos publicados (el de la documentación de GitHub y el de las pruebas de Svix) y contra cuerpos y firmas alterados.
- **Recepción:** los códigos `202/200/400/401/404`, deduplicación, filtros por tipo y cabeceras sensibles que no se guardan.
- **Trabajador:** entrega firmada que el destino puede verificar, los 6 intentos hasta fallido, tiempo máximo, reenvío manual y **4 trabajadores en paralelo sobre 40 eventos sin una sola entrega duplicada** (si se quita `SKIP LOCKED`, la prueba falla con 50 entregas).
- **Panel:** Playwright entra con clave equivocada y correcta, filtra, abre un evento y lo reenvía hasta verlo entregado.
- **CI** además corre la colección de Postman con Newman y levanta todo con `docker compose` para enviar la demo.

## Licencia

MIT.
