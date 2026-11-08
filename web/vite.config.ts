import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // Older TV browsers: stay conservative.
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // `vite` dev server on a workstation, proxying the API to a running backend.
    proxy: { "/api": process.env.SOFARR_API ?? "http://127.0.0.1:5656" },
  },
});
