import type { NextConfig } from "next";
import { BASE_PATH } from "./lib/site";

// Static export to GitHub Pages at https://databricks-solutions.github.io/agentic-starter-journey/.
// basePath must match the repo name; trailingSlash keeps /docs/foo/ resolving to
// out/docs/foo/index.html, which is what Pages serves without a rewrite layer.
// Next only prepends basePath to <Link> components, not to raw <a> tags emitted
// from markdown, so lib/content.ts rewrites /docs/... hrefs by hand using BASE_PATH.
const nextConfig: NextConfig = {
  output: "export",
  basePath: BASE_PATH,
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;
