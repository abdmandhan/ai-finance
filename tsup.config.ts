import { defineConfig } from "tsup";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

// Keep all dependencies as externals — only bundle @/* internal imports
const external = Object.keys(pkg.dependencies || {});

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: "esm",
  clean: true,
  target: "es2024",
  dts: false,
  sourcemap: true,
  external,
});
