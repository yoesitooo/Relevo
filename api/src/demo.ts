/**
 * Demo: crea una fuente "demo" con un destino y le envía un webhook firmado.
 * Con Docker:  docker compose exec api node dist/demo.js
 */
import { leerConfig } from "./config.js";
import { firmarStandard } from "./firmas.js";

const config = leerConfig();
const base = `http://127.0.0.1:${config.puerto}`; // IPv4: en Alpine "localhost" es ::1 primero
const destino = process.env.DESTINO_DEMO ?? "http://receptor-demo:8080/webhook";
const auth = { authorization: `Bearer ${config.adminApiKey}`, "content-type": "application/json" };

const slug = `demo-${Date.now().toString(36)}`;
const fuente = (await (await fetch(`${base}/api/fuentes`, {
  method: "POST", headers: auth, body: JSON.stringify({ slug, nombre: "Demo", tipo_firma: "standard" }),
})).json()) as { id: string; secreto: string; url_entrada: string };
await fetch(`${base}/api/fuentes/${fuente.id}/destinos`, { method: "POST", headers: auth, body: JSON.stringify({ url: destino }) });

const cuerpo = JSON.stringify({ type: "pago.aprobado", data: { referencia: "DEMO-001", monto: 50000, moneda: "COP" } });
const id = `msg_demo_${Date.now()}`;
const ts = Math.floor(Date.now() / 1000);
const r = await fetch(`${base}/in/${slug}`, {
  method: "POST",
  headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": firmarStandard(fuente.secreto, id, ts, cuerpo) },
  body: cuerpo,
});
console.log(`Fuente: ${fuente.url_entrada}`);
console.log(`Webhook enviado → ${r.status} ${await r.text()}`);
console.log("Míralo en el panel: http://localhost:4200 (el trabajador lo entrega en ~1 s)");
