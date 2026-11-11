import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors.js";
import { httpRagClient } from "../src/routes/query.js";

describe("httpRagClient", () => {
  it("convierte el tiempo agotado en un 504 claro, no en «error interno»", async () => {
    const server = createServer(() => undefined); // acepta la petición y nunca responde
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const client = httpRagClient(`http://127.0.0.1:${port}`, 80);
      const err = await client.query("t", { question: "hola" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(504);
      expect((err as ApiError).code).toBe("rag_timeout");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
