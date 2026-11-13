import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_EMAIL: "shanumiftikhar61@gmail.com",
          ADMIN_BOOTSTRAP_TOKEN: "test-bootstrap-secret",
        },
      },
    }),
  ],
  test: { include: ["tests/**/*.test.ts"] },
});
