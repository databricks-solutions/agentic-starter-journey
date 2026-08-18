// Internal link check over the static export. Docusaurus did this via
// onBrokenLinks: 'throw'; Next has no equivalent, so this replaces it.
// Walks out/, resolves every internal href and #anchor, exits 1 on any miss.

import fs from "node:fs";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "..", "out");
// Mirror of BASE_PATH in lib/site.ts. This script is plain ESM and cannot
// import the TS module; keep the two in sync on repo rename.
const BASE_PATH = "/agentic-starter-journey";

if (!fs.existsSync(OUT)) {
  console.error("out/ not found. Run `npm run build` first.");
  process.exit(1);
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });

const htmlFiles = walk(OUT).filter((f) => f.endsWith(".html"));

// Map every served URL path to the set of element ids on that page.
const idsByPath = new Map();
for (const file of htmlFiles) {
  const rel = path.relative(OUT, file);
  const urlPath = "/" + rel.replace(/index\.html$/, "").replace(/\.html$/, "");
  const html = fs.readFileSync(file, "utf8");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  idsByPath.set(urlPath.replace(/\/$/, "") || "/", ids);
}

const known = (p) => idsByPath.has(p.replace(/\/$/, "") || "/");

let broken = 0;
for (const file of htmlFiles) {
  const rel = path.relative(OUT, file);
  const html = fs.readFileSync(file, "utf8");

  for (const [, href] of html.matchAll(/<a[^>]+href="([^"]+)"/g)) {
    if (!href.startsWith("/")) continue; // external, mailto, or in-page handled below
    const [rawPath, anchor] = href.split("#");

    // Every internal link must carry the basePath prefix. Markdown links
    // are rewritten by rehypePrefixBasePath in lib/content.ts; <Link>
    // components get it from Next. A bare `/docs/...` href here means the
    // rewriter missed it and the browser will 404 under the basePath.
    if (!rawPath.startsWith(BASE_PATH)) {
      console.error(`${rel}: internal link missing basePath prefix -> ${href}`);
      broken++;
      continue;
    }

    const target = rawPath.slice(BASE_PATH.length) || "/";

    if (!known(target)) {
      console.error(`${rel}: broken link -> ${href}`);
      broken++;
      continue;
    }
    if (anchor && !idsByPath.get(target.replace(/\/$/, "") || "/").has(anchor)) {
      console.error(`${rel}: broken anchor -> ${href}`);
      broken++;
    }
  }
}

console.log(
  broken === 0
    ? `OK: ${htmlFiles.length} pages, no broken internal links or anchors.`
    : `FAIL: ${broken} broken internal link(s).`
);
process.exit(broken === 0 ? 0 : 1);
