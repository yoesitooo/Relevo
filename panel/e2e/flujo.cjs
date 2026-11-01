/**
 * Prueba de punta a punta del panel (Playwright).
 * Requiere la API corriendo (RELEVO_API, ADMIN_API_KEY) y el panel compilado (npm run build).
 *
 *   node e2e/flujo.cjs
 *
 * Siembra datos por la API, sirve el panel compilado y recorre: entrar → filtrar →
 * abrir un evento → reenviar → ver el intento entregado.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const API = process.env.RELEVO_API ?? "http://localhost:3000";
const CLAVE = process.env.ADMIN_API_KEY;
if (!CLAVE) throw new Error("Falta ADMIN_API_KEY");
const DIST = path.join(__dirname, "..", "dist", "panel", "browser");

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(API + ruta, {
    method: metodo,
    headers: { authorization: `Bearer ${CLAVE}`, "content-type": "application/json" },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const datos = await r.json();
  if (!r.ok) throw new Error(`${metodo} ${ruta}: ${r.status} ${JSON.stringify(datos)}`);
  return datos;
}

function escuchar(handler) {
  return new Promise((ok) => {
    const s = http.createServer(handler).listen(0, "127.0.0.1", () => ok(s));
  });
}

async function main() {
  // Destino que falla la primera vez y luego acepta
  let llamadas = 0;
  const destino = await escuchar((req, res) => { req.resume(); llamadas++; res.writeHead(llamadas === 1 ? 500 : 200).end(); });
  // Panel compilado, con config.js apuntando a la API
  const panel = await escuchar((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/config.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(`window.RELEVO_API=${JSON.stringify(API)};`);
    const archivo = path.join(DIST, url);
    const existe = archivo.startsWith(DIST) && fs.existsSync(archivo) && fs.statSync(archivo).isFile();
    const tipo = { ".js": "text/javascript", ".css": "text/css", ".ico": "image/x-icon" }[path.extname(archivo)] ?? "text/html";
    res.writeHead(200, { "content-type": existe ? tipo : "text/html" }).end(fs.readFileSync(existe ? archivo : path.join(DIST, "index.html")));
  });
  const urlPanel = `http://127.0.0.1:${panel.address().port}`;
  const urlDestino = `http://127.0.0.1:${destino.address().port}/hook`;

  // Datos de prueba
  const slug = `e2e-${Date.now().toString(36)}`;
  const f = await api("POST", "/api/fuentes", { slug, nombre: "Pagos E2E", tipo_firma: "standard" });
  await api("POST", `/api/fuentes/${f.id}/destinos`, { url: urlDestino });
  const cuerpo = JSON.stringify({ type: "pago.aprobado", monto: 12345 });
  const ts = Math.floor(Date.now() / 1000);
  const firma = "v1," + crypto.createHmac("sha256", Buffer.from(f.secreto.slice(6), "base64")).update(`msg_e2e.${ts}.${cuerpo}`).digest("base64");
  const r = await fetch(`${API}/in/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": "msg_e2e", "webhook-timestamp": String(ts), "webhook-signature": firma },
    body: cuerpo,
  });
  assert.equal(r.status, 202, "el webhook firmado debe aceptarse");

  const navegador = await chromium.launch();
  const pagina = await navegador.newPage();
  try {
    // 1. Clave incorrecta
    await pagina.goto(urlPanel + "/eventos");
    await pagina.waitForURL(/\/entrar/);
    await pagina.getByLabel("Clave de administración").fill("clave-equivocada-123456789");
    await pagina.getByRole("button", { name: "Entrar" }).click();
    await pagina.getByText("Clave incorrecta.").waitFor();

    // 2. Clave correcta → lista de eventos
    await pagina.getByLabel("Clave de administración").fill(CLAVE);
    await pagina.getByRole("button", { name: "Entrar" }).click();
    await pagina.waitForURL(/\/eventos$/);

    // 3. Filtrar por la fuente de la prueba
    await pagina.getByLabel("Fuente").selectOption(slug);
    const fila = pagina.locator("tbody tr").filter({ hasText: "pago.aprobado" });
    await fila.first().waitFor();
    assert.equal(await pagina.locator("tbody tr").count(), 1);
    assert.match(await fila.first().innerText(), /Pendiente/);

    // 4. Abrir el detalle y reenviar dos veces (falla, luego entrega)
    await fila.first().getByRole("link").click();
    await pagina.getByRole("heading", { name: "Entregas" }).waitFor();
    await pagina.getByText('"monto": 12345').waitFor();
    await pagina.getByRole("button", { name: "Reenviar" }).click();
    await pagina.getByText("Intento 1").waitFor();
    assert.match(await pagina.locator(".linea li").first().innerText(), /500/);
    await pagina.getByRole("button", { name: "Reenviar" }).click();
    await pagina.getByText("Intento 2").waitFor();
    await pagina.locator(".envio .estado.entregado").waitFor();
    if (process.env.CAPTURAS) await pagina.screenshot({ path: path.join(process.env.CAPTURAS, "panel-detalle.png") });

    // 5. Volver: el evento aparece entregado
    await pagina.getByRole("link", { name: "← Eventos" }).click();
    await pagina.getByLabel("Fuente").selectOption(slug);
    await pagina.locator("tbody .estado.entregado").waitFor();
    if (process.env.CAPTURAS) await pagina.screenshot({ path: path.join(process.env.CAPTURAS, "panel-eventos.png") });
    console.log("✓ Flujo del panel completo: entrar, filtrar, detalle, reenviar.");
  } finally {
    await navegador.close();
    destino.close();
    panel.close();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
