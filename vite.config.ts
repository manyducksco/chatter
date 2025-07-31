import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
    minify: true,

    lib: {
      entry: {
        index: resolve(__dirname, "src/core/index.ts"),
        http: resolve(__dirname, "src/http/index.ts"),
        i18n: resolve(__dirname, "src/i18n/index.ts"),
        router: resolve(__dirname, "src/router/index.ts"),
        "jsx-runtime": resolve(__dirname, "src/jsx-runtime.js"),
        "jsx-dev-runtime": resolve(__dirname, "src/jsx-dev-runtime.js"),
      },
      name: "Dolla",
      formats: ["es"],
    },
  },
});
