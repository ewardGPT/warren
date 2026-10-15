// OPR.0.4.1.11.1 (FR-5) — dev-only twin build target. Builds the REAL @openrig/ui App
// (twin/ entry) into ONE self-contained, double-clickable `intent.html`. Separate config so
// it never disturbs the product build. The single-file inline plugin below is the same
// generateBundle technique vite-plugin-singlefile uses, kept dependency-free (the worktree
// shares node_modules with main; this target adds no installed dependency).

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Inline the single JS chunk + the CSS asset into the HTML, then emit it as intent.html.
// Binary assets (fonts) are already inlined as base64 data: URLs via assetsInlineLimit, so
// the emitted HTML is fully self-contained — no sibling asset folder needed to open it.
function singleFileInline(): Plugin {
  return {
    name: "twin-single-file-inline",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlEntry = Object.values(bundle).find(
        (b) => b.type === "asset" && b.fileName.endsWith(".html"),
      );
      if (!htmlEntry || htmlEntry.type !== "asset") return;
      let html = String(htmlEntry.source);

      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          const scriptTag = new RegExp(
            `<script[^>]*\\ssrc="[^"]*${escapeRe(item.fileName)}"[^>]*></script>`,
            "g",
          );
          // Function replacer (NOT a string) — the bundled JS contains `$&`/`$1` patterns
          // (e.g. React's key-escaping `.replace(B,"$&/")`) that String.replace would
          // expand into the matched tag, corrupting the inlined code.
          html = html.replace(scriptTag, () => `<script type="module">\n${item.code}\n</script>`);
          delete bundle[item.fileName];
        } else if (item.fileName.endsWith(".css")) {
          const linkTag = new RegExp(
            `<link[^>]*\\shref="[^"]*${escapeRe(item.fileName)}"[^>]*>`,
            "g",
          );
          html = html.replace(linkTag, () => `<style>\n${String(item.source)}\n</style>`);
          delete bundle[item.fileName];
        }
      }

      delete bundle[htmlEntry.fileName];
      this.emitFile({ type: "asset", fileName: "intent.html", source: html });
    },
  };
}

// The surface this build's intent.html lands on. Per-slice authoring sets it, e.g.
// `TWIN_ROUTE=/topology/rig/rig_delivery npm run twin:build`. Default = Dashboard.
const twinRoute = process.env.TWIN_ROUTE && process.env.TWIN_ROUTE.length > 0 ? process.env.TWIN_ROUTE : "/";

// 0.4.3.29 theming — optional palette seed for the built twin (dark|light|system).
const twinTheme =
  process.env.TWIN_THEME && /^(dark|light|system)$/.test(process.env.TWIN_THEME) ? process.env.TWIN_THEME : "";

export default defineConfig({
  root: path.resolve(__dirname, "twin"),
  define: {
    __TWIN_ROUTE__: JSON.stringify(twinRoute),
    __TWIN_THEME__: JSON.stringify(twinTheme),
  },
  plugins: [react(), singleFileInline()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(__dirname, "twin-out"),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // inline all binary assets (fonts) as base64 data: URLs
    cssCodeSplit: false,
    chunkSizeWarningLimit: 100_000, // heavy single file is acceptable per founder
    rollupOptions: {
      output: {
        inlineDynamicImports: true, // collapse to ONE JS chunk for clean single-file inline
        entryFileNames: "twin.js",
        assetFileNames: "twin.[ext]",
      },
    },
  },
});
