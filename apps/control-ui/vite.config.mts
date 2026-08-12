import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": process.env.QQCB_API_ORIGIN ?? "http://127.0.0.1:3100"
    }
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist/apps/control-ui", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true
  }
});
