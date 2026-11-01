import { describe, expect, it } from "vitest";
import { ESPERAS_MS, MAX_INTENTOS, proximaEspera } from "../src/reintentos.js";

describe("proximaEspera", () => {
  it("sigue 30 s, 2 min, 10 min, 1 h, 6 h sin aleatoriedad", () => {
    const sinVariacion = () => 0.5;
    expect([1, 2, 3, 4, 5].map((n) => proximaEspera(n, sinVariacion))).toEqual([...ESPERAS_MS]);
  });

  it("varía como máximo ±20 %", () => {
    expect(proximaEspera(1, () => 0)).toBe(24_000);
    expect(proximaEspera(1, () => 0.999999)).toBeCloseTo(36_000, -1);
  });

  it("no hay más intentos después del sexto", () => {
    expect(MAX_INTENTOS).toBe(6);
    expect(proximaEspera(6)).toBeNull();
    expect(proximaEspera(0)).toBeNull();
  });
});
