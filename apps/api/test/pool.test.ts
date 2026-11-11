import { describe, expect, it } from "vitest";
import { createPool } from "../src/db/pool.js";

describe("createPool", () => {
  it("escucha `error` del pool: una conexión inactiva caída no debe matar el proceso", async () => {
    const pool = createPool("postgres://u:p@127.0.0.1:1/none");
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    // Emitir `error` sin listener lanzaría; con listener solo se registra.
    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    await pool.end();
  });
});
