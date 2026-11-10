import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env: { LOG_LEVEL: "silent" }, testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false } });
