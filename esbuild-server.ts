import * as esbuild from "esbuild";

esbuild.build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "server.js",
  external: ["express", "vite", "@google/genai", "multer", "ws"],
}).catch(() => process.exit(1));
