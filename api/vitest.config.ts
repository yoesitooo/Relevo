import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Las pruebas de integración comparten una base PostgreSQL: un archivo a la vez.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      ADMIN_API_KEY: "clave-de-prueba-admin-123456",
      CLAVE_CIFRADO: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      PERMITIR_HTTP: "true",
      URL_PUBLICA: "http://relevo.test",
    },
  },
});
