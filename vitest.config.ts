import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // `as any`: vitest 2.x types its config against its own nested vite 5
  // (node_modules/vitest/node_modules/vite), while @vitejs/plugin-react is
  // typed against the repo's vite 7 — the two Plugin shapes are nominally
  // incompatible under tsc but identical at runtime.
  plugins: [react() as any],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
