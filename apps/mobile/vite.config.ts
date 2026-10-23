import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@swms/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts")
    }
  },
  server: {
    port: 5174,
    host: true
  }
});
