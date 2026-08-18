// Single source of truth for the static-export basePath.
// Used by next.config.ts, the markdown link rewriter in lib/content.ts,
// and the link checker in scripts/check-links.mjs. Keeping it here means a
// repo rename only changes one line.
export const BASE_PATH = "/agentic-starter-journey";
