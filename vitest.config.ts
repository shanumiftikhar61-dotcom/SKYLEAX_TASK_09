import { randomBytes } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const testBootstrapToken = randomBytes(32).toString("base64url");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_EMAIL: "shanumiftikhar61@gmail.com",
          ADMIN_BOOTSTRAP_TOKEN: testBootstrapToken,
        },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"] },
});
