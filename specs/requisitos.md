# Requisitos — Relevo (relé de webhooks)

Relevo recibe webhooks de servicios externos (pasarelas de pago, GitHub, herramientas SaaS), **verifica que sean auténticos**, los guarda y los **reenvía con garantía** a los sistemas internos, con reintentos, sin duplicados y con un panel para ver qué pasó y reenviar a mano.

Problema que resuelve: si un sistema interno está caído cuando llega un webhook, el evento se pierde; si el proveedor lo reenvía, se procesa dos veces; y nadie sabe qué llegó ni cuándo.

## Historias de usuario

### HU-1 · prioridad alta — Recibir webhooks auténticos

**Como** integrador, **quiero** que Relevo reciba webhooks y verifique su firma, **para** procesar solo eventos que de verdad envió el proveedor.

- **CA-1.1** CUANDO llega un POST a `/in/{fuente}` con firma válida (Standard Webhooks o GitHub) EL SISTEMA DEBE guardarlo y responder `202` en menos de 200 ms (sin esperar el reenvío).
- **CA-1.2** SI la firma no es válida o falta EL SISTEMA DEBE responder `401` y no guardar el evento.
- **CA-1.3** SI la marca de tiempo del webhook (Standard Webhooks) difiere más de 5 minutos de la hora del servidor EL SISTEMA DEBE responder `401` (protección contra repetición).
- **CA-1.4** SI la fuente no existe o está desactivada EL SISTEMA DEBE responder `404`.

### HU-2 · prioridad alta — No procesar dos veces

**Como** integrador, **quiero** que un webhook repetido no se reenvíe de nuevo, **para** no cobrar ni registrar algo dos veces.

- **CA-2.1** CUANDO llega un webhook con un ID que ya existe para esa fuente (`webhook-id` o `X-GitHub-Delivery`) EL SISTEMA DEBE responder `200` sin crear un evento nuevo ni nuevos envíos.

### HU-3 · prioridad alta — Reenviar con reintentos

**Como** dueño de un sistema interno, **quiero** que cada evento llegue a mis destinos aunque estén caídos un rato, **para** no perder información.

- **CA-3.1** CUANDO se guarda un evento EL SISTEMA DEBE crear un envío por cada destino activo de la fuente cuyo filtro de tipo coincida.
- **CA-3.2** CUANDO un destino responde 2xx EL SISTEMA DEBE marcar el envío como entregado y registrar código, duración y fecha.
- **CA-3.3** SI un destino falla (no 2xx, error de red o más de 10 s) EL SISTEMA DEBE reintentar con espera exponencial y aleatoriedad (30 s, 2 min, 10 min, 1 h, 6 h) y, tras el último intento, marcarlo como fallido.
- **CA-3.4** CUANDO Relevo reenvía EL SISTEMA DEBE firmar la petición con el secreto propio del destino (Standard Webhooks), para que el destino pueda verificar que viene de Relevo.
- **CA-3.5** MIENTRAS haya varias instancias del trabajador EL SISTEMA DEBE garantizar que un envío pendiente lo tome una sola instancia.

### HU-4 · prioridad media — Configurar fuentes y destinos

**Como** administrador, **quiero** crear fuentes y destinos por API, **para** conectar proveedores nuevos sin tocar código.

- **CA-4.1** CUANDO el administrador crea una fuente EL SISTEMA DEBE devolver su URL de entrada y, si es Standard Webhooks, el secreto para configurarlo en el proveedor (solo se muestra al crearla).
- **CA-4.2** CUANDO el administrador crea un destino EL SISTEMA DEBE validar que la URL sea `https` (o `http` solo en desarrollo) y devolver su secreto de firma.
- **CA-4.3** SI la petición a la API de administración no trae una clave válida EL SISTEMA DEBE responder `401`.

### HU-5 · prioridad media — Ver y reenviar desde un panel

**Como** administrador, **quiero** ver los eventos y sus intentos y reenviar los fallidos, **para** diagnosticar sin entrar a la base de datos.

- **CA-5.1** CUANDO el administrador abre el panel EL SISTEMA DEBE listar los eventos más recientes con fuente, tipo, fecha y estado de entrega, filtrables por fuente y estado.
- **CA-5.2** CUANDO abre un evento EL SISTEMA DEBE mostrar el cuerpo recibido y, por destino, la línea de tiempo de intentos (código, duración, error).
- **CA-5.3** CUANDO el administrador pulsa "Reenviar" en un envío fallido o entregado EL SISTEMA DEBE crear un nuevo intento inmediato y mostrar su resultado.

## Casos de uso

### CU-1 — Recibir un webhook

- **Actor:** proveedor externo · **Historias:** HU-1, HU-2, HU-3
- **Precondiciones:** la fuente existe y está activa.

**Flujo principal**
1. El proveedor envía `POST /in/{fuente}` con su firma.
2. Relevo verifica la firma sobre el cuerpo crudo y la marca de tiempo.
3. Relevo guarda el evento y un envío pendiente por destino, en una sola transacción.
4. Relevo responde `202`.

**Alterno — firma inválida o vencida:** Relevo responde `401` y no guarda nada.
**Alterno — ID repetido:** Relevo responde `200` y no crea nada.

- **Postcondiciones:** el evento y sus envíos quedan guardados.

### CU-2 — Entregar a un destino

- **Actor:** trabajador de entregas · **Historias:** HU-3

**Flujo principal**
1. El trabajador toma envíos pendientes cuya hora de reintento ya pasó (bloqueándolos para otras instancias).
2. Firma y envía el evento al destino.
3. Registra el intento; si fue 2xx, marca el envío como entregado.

**Alterno — el destino falla:** registra el error y programa el siguiente intento; si era el último, lo marca como fallido.

### CU-3 — Reenviar a mano

- **Actor:** administrador · **Historias:** HU-5
1. Abre el evento en el panel y pulsa "Reenviar" en un destino.
2. Relevo crea un intento inmediato y muestra el resultado.

## Requisitos no funcionales

- La recepción no depende de que los destinos respondan (se responde antes de reenviar).
- Secretos guardados cifrados en reposo; nunca aparecen en logs ni en el panel después de crearlos.
- Comparación de firmas en tiempo constante.
- Pruebas automáticas en CI con una base PostgreSQL real.
