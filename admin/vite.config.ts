import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (/react|scheduler/.test(id)) return "react";
            if (/viem|noble|abitype|ox\//.test(id)) return "evm";
            return undefined;
          }
        },
      },
    },
  },
  server: {
    proxy: {
      "/api":
        loadEnv(mode, process.cwd()).VITE_API_TARGET || "http://127.0.0.1:4000",
    },
  },
}));
