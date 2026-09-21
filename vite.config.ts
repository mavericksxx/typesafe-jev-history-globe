import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
    // Multi-page build: "ask" is a real second page at ask/index.html, not
    // a client-side route — Vite preserves that input's directory
    // structure in the output (dist/ask/index.html), which is what lets
    // Cloudflare Pages serve it at the clean URL /ask.
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        ask: resolve(__dirname, "ask/index.html"),
      },
    },
  },
});
