import { describe, expect, it } from "vitest";
import { firmarGithub, firmarStandard, verificarGithub, verificarStandard } from "../src/firmas.js";
import { cifrar, descifrar, generarSecreto } from "../src/secretos.js";

// Vector de las pruebas de las librerías de Svix (creadores de Standard Webhooks)
const VECTOR = {
  secreto: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  cuerpo: '{"test": 2432232314}',
  firma: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const EN_HORA = new Date(VECTOR.timestamp * 1000);

function cabeceras(firma = VECTOR.firma, ts = String(VECTOR.timestamp)) {
  return { "webhook-id": VECTOR.id, "webhook-timestamp": ts, "webhook-signature": firma };
}

describe("Standard Webhooks", () => {
  it("reproduce la firma del vector oficial", () => {
    expect(firmarStandard(VECTOR.secreto, VECTOR.id, VECTOR.timestamp, VECTOR.cuerpo)).toBe(VECTOR.firma);
  });

  it("acepta la firma válida, también entre varias firmas", () => {
    const cuerpo = Buffer.from(VECTOR.cuerpo);
    expect(verificarStandard(VECTOR.secreto, cabeceras(), cuerpo, EN_HORA)).toEqual({ ok: true });
    expect(verificarStandard(VECTOR.secreto, cabeceras(`v1,AAAA ${VECTOR.firma}`), cuerpo, EN_HORA)).toEqual({ ok: true });
  });

  it("rechaza cuerpo alterado, firma alterada o versión desconocida", () => {
    const malo = { ok: false, motivo: "firma_invalida" };
    expect(verificarStandard(VECTOR.secreto, cabeceras(), Buffer.from('{"test": 1}'), EN_HORA)).toEqual(malo);
    expect(verificarStandard(VECTOR.secreto, cabeceras("v1,ZmFsc2E="), Buffer.from(VECTOR.cuerpo), EN_HORA)).toEqual(malo);
    expect(verificarStandard(VECTOR.secreto, cabeceras(VECTOR.firma.replace("v1", "v2")), Buffer.from(VECTOR.cuerpo), EN_HORA)).toEqual(malo);
    expect(verificarStandard(VECTOR.secreto, {}, Buffer.from(VECTOR.cuerpo), EN_HORA)).toEqual(malo);
  });

  it("rechaza marcas de tiempo a más de 5 minutos, en ambos sentidos", () => {
    const cuerpo = Buffer.from(VECTOR.cuerpo);
    const vencida = { ok: false, motivo: "marca_de_tiempo_vencida" };
    expect(verificarStandard(VECTOR.secreto, cabeceras(), cuerpo, new Date(EN_HORA.getTime() + 301_000))).toEqual(vencida);
    expect(verificarStandard(VECTOR.secreto, cabeceras(), cuerpo, new Date(EN_HORA.getTime() - 301_000))).toEqual(vencida);
    expect(verificarStandard(VECTOR.secreto, cabeceras(), cuerpo, new Date(EN_HORA.getTime() + 299_000))).toEqual({ ok: true });
  });
});

describe("GitHub", () => {
  // Ejemplo de la documentación de GitHub para validar entregas de webhooks
  it("reproduce el ejemplo de la documentación", () => {
    expect(firmarGithub("It's a Secret to Everybody", "Hello, World!")).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("verifica y rechaza", () => {
    const cuerpo = Buffer.from('{"action":"opened"}');
    const firma = firmarGithub("s3creto", cuerpo);
    expect(verificarGithub("s3creto", { "x-hub-signature-256": firma }, cuerpo)).toEqual({ ok: true });
    expect(verificarGithub("otro", { "x-hub-signature-256": firma }, cuerpo).ok).toBe(false);
    expect(verificarGithub("s3creto", { "x-hub-signature-256": "sha1=abc" }, cuerpo).ok).toBe(false);
    expect(verificarGithub("s3creto", {}, cuerpo).ok).toBe(false);
  });
});

describe("secretos", () => {
  const clave = Buffer.alloc(32, 7);

  it("genera secretos whsec_ distintos que sirven para firmar", () => {
    const a = generarSecreto();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(a).not.toBe(generarSecreto());
    const f = firmarStandard(a, "msg_1", 1, "{}");
    expect(verificarStandard(a, { "webhook-id": "msg_1", "webhook-timestamp": "1", "webhook-signature": f }, Buffer.from("{}"), new Date(1000)).ok).toBe(true);
  });

  it("cifra y descifra; detecta alteraciones y claves equivocadas", () => {
    const guardado = cifrar("whsec_abc", clave);
    expect(guardado).not.toContain("whsec_abc");
    expect(descifrar(guardado, clave)).toBe("whsec_abc");
    expect(cifrar("whsec_abc", clave)).not.toBe(guardado); // IV aleatorio
    expect(() => descifrar(guardado, Buffer.alloc(32, 8))).toThrow();
    const partes = guardado.split(":");
    partes[3] = Buffer.from("otra cosa").toString("base64");
    expect(() => descifrar(partes.join(":"), clave)).toThrow();
  });
});
