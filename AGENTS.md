# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this repo is

A Next.js 16 + Tailwind 4 static site at `docs/agentic-starter-journey/` (not the repo root, so all `npm` commands run from there). See [README.md](README.md) for the layout and how it differs from [Starter Journey](https://databricks-solutions.github.io/starter-journey/), from which it was structurally cloned.

The audience is a coding agent, not a human. That is the constraint behind almost every content decision below.

Deliberately plain, modelled on [agents.md](https://github.com/agentsmd/agents.md): single column, no sidebar, no navbar, no search, no theme switcher, no hero.
The landing page is a title, a tagline, a one-line pointer to `/docs/how-to-use/`, and a numbered section table with a `pickIf` criterion per row.
No contract table and no child pages on the landing; section indexes own leaf routing.
Hard token budgets for visible landing text: ≤150 tokens at the current section count, ≤220 at full scale.
Every other page ends with next-page and back-to-contents.
Do not reintroduce site chrome.

## Writing rules for doc pages

Every page follows the same nine-block contract, documented for readers in `docs/agentic-starter-journey/content/how-to-use.md`: **Mental Model**, **Goal**, **Prerequisites**, **Skill**, **Inputs** (with a `Source` column saying human-provided vs agent-derived), **Run**, **Verify**, **Where this fails**, **Next**.

- Verification is a runnable command plus its expected output. Never "confirm it looks right in the UI".
- Prefer a check that would catch a *silent* failure over one that only catches an error: row counts and freshness over exit status, a masked-principal query over `SHOW POLICIES`, a metric-view-vs-raw-SQL reconciliation over "the view exists".
- No screenshots, video embeds, click-by-click walkthroughs, or motivational framing. Short imperative sentences and command blocks.
- Where no agentic path exists, link the equivalent Starter Journey page and say plainly that the step is manual. Do not invent a skill.
- No em dashes or en dashes anywhere (per the user's global instruction). One sentence per line in Markdown.

## Never cite an unverified skill

Both skill libraries are referenced by name and URL only, never vendored. Before citing a skill, confirm it exists upstream and read its `SKILL.md` frontmatter so the prose matches what it actually does:

```bash
gh api "repos/databricks/databricks-agent-skills/git/trees/HEAD?recursive=1" \
  --jq '.tree[] | select(.path | test("plugins/databricks/claude/skills/[^/]+/SKILL.md$")) | .path'
gh api "repos/databricks-solutions/ai-platform-kit/git/trees/HEAD?recursive=1" \
  --jq '.tree[] | select(.path | test("^.claude/skills/[^/]+/SKILL.md$")) | .path'
```

ai-platform-kit skills are cited by their frontmatter `name` (`databricks-platform-provisioning`), which differs from the directory name (`platform-provisioning`). Both forms appear in the docs and both are legitimate.

## How the site is wired

Four files carry the whole build. Read them before changing rendering or navigation:

| File | Role |
|---|---|
| `lib/nav.ts` | The only source of reading order. Section list with `pickIf` for the landing table, `HOW_TO_USE` prepended to `READING_ORDER`, and `nextOf()` for per-page next links. |
| `lib/site.ts` | The single source of truth for the static-export `basePath`. Imported by `next.config.ts` and `lib/content.ts`; mirrored in `scripts/check-links.mjs`. Change it here on a repo rename. |
| `lib/content.ts` | Markdown to HTML at build time: gray-matter frontmatter, remark-gfm, remark-directive for admonitions, Shiki for highlighting, and `rehypePrefixBasePath` to rewrite internal `/docs/...` links with the basePath. |
| `pages/docs/[...slug].tsx` | Catch-all that renders every content page and its two nav links. |
| `scripts/check-links.mjs` | Link check over `out/`. Replaces Docusaurus `onBrokenLinks: 'throw'`. Fails if any internal link is missing the basePath prefix. |

Content lives in `content/` as plain `.md`. Adding a page means adding the file **and** its entry in `lib/nav.ts`; a file with no nav entry still builds and still gets a URL, but nothing links to it and it has no next link.

## Sharp edges

- **Routes are `/docs/<path>` on purpose.** The content's internal links are all absolute `/docs/...`, inherited from Docusaurus. `pages/docs/[...slug].tsx` plus `trailingSlash: true` reproduces those exact paths. **Next.js only prepends `basePath` to `<Link>` components, not to raw `<a>` tags emitted from markdown**, so `rehypePrefixBasePath` in `lib/content.ts` rewrites every `/docs/...` href to `${BASE_PATH}/docs/...` at build time. Without it, table and inline links in markdown resolve against the host root and 404 under the `/agentic-starter-journey` basePath. `scripts/check-links.mjs` fails the build if any internal link is missing the prefix, so this regression cannot ship silently. Changing the route shape means rewriting links in all 37 files.
- **`content/foo/index.md` serves at `/docs/foo/`.** The `index` segment is stripped in `hrefFor()` and in `getStaticPaths`, and mapped back to disk in `getStaticProps`. A slug that is both a page and a directory would break that mapping.
- **Anchors depend on `rehype-slug`,** which uses github-slugger, the same algorithm Docusaurus used. That is why deep links like `#3-is-the-grain-what-you-think-it-is` still resolve. Swapping the slugger silently breaks cross-page anchors; `check-links.mjs` catches it.
- **`npm run build` includes the link check** and fails on any broken internal link or anchor. That is the replacement for `onBrokenLinks: 'throw'`. Never split the check out of `build` to get a green run.
- **`.markdown table` uses `overflow-x: auto`.** Wide tables must stay reachable by scrolling on narrow viewports rather than being clipped, and nearly every page here has a wide input or failure-mode table.
- **Code blocks wrap rather than scroll** (`white-space: pre-wrap` on `pre.shiki`). These are long CLI pipelines the reader must see in full; a horizontal scrollbar hides the tail of a verification command.
- **Doc pages use `max-w-3xl`, the landing page `max-w-2xl`.** Prose width alone leaves the dense three- and four-column tables cramped.
- **Shiki emits both themes as CSS variables** (`--shiki-light` / `--shiki-dark`) and `globals.css` picks one per `prefers-color-scheme`. There is no theme switcher; dark mode follows the OS.

## Verification before calling doc work done

From `docs/agentic-starter-journey/`:

```bash
npm run build       # static export plus the internal link and anchor check
npm run typecheck
```

Then check: every `lib/nav.ts` slug resolves to a real file in `content/` and every file has a nav entry; no `starter-journey` strings outside intentional external fallback links; no references to assets not in `public/img/` (only the favicons are kept); every cited skill name resolves upstream.

To walk the built site: `npm run serve`, which serves `out/` (note the site lives under the `/agentic-starter-journey/` base path, so the useful URL is `http://localhost:3000/agentic-starter-journey/`).

## Decisions carried from the initial build

- **Plain markdown, not MDX.** The content uses no imports, no JSX, and no components, so MDX bought nothing and cost a compile step. A useful consequence: `<name>`-style placeholders are ordinary text rather than JSX tags that must be escaped, which was a standing sharp edge under MDX.
- **`StarterJourneyProgress` and its CSS tokens were dropped**, not ported. A visual progress ladder is human scaffolding; it carries no information an agent can act on.
- **No content images.** Only `databricks.ico` and `databricks-logo-orange.png` (favicon) are kept. No architecture diagram earned its place: prose plus a code block said it better for a machine reader.
- **Analytics were dropped entirely**, not re-pointed. Starter Journey's gtag block and `gtag-shim` client module carry its tracking ID.
- **Genie Agents live in section 8, not section 10.** They read the metric views built there. Section 10 covers document and retrieval surfaces.
- **Section 10 (Agents) scope is a judgement call**, since the source plan did not specify it. Flagged as such on the section index page itself.
- **Per-cloud workspace pages were kept** because the auth inputs genuinely differ (AWS needs an account-admin SP with an OAuth secret, Azure uses `azure-cli` auth with `azure_tenant_id` on every provider block, GCP needs SA impersonation with `auth_type = "google-id"`). The manual/terraform/SRA triple collapsed to the agentic path plus a Starter Journey pointer.
- **Metric views ship as a SQL task in a bundle job**, since they are not a DABs resource type, while dashboards and Genie Agents are native resources. Verified against `databricks/bundle-examples` `knowledge_base/`.

## Writing a new section or leaf

For authoring (new or substantially rewritten pages), stay in this file: nine-block contract, skill citation via `gh api`, `content/` file plus `lib/nav.ts` entry, then `npm run build` and `npm run typecheck` from `docs/agentic-starter-journey/`.

Authoring checklist:

1. Pick section from `lib/nav.ts` (or add a section row with `pickIf`).
2. Add `content/<section>/<leaf>.md` with all nine blocks from `how-to-use.md`.
3. Add the child to `lib/nav.ts` in reading order.
4. Verify every cited skill exists upstream and matches frontmatter `name`.
5. Build and typecheck. Serve `out/` before asking anyone to eval.

## Section eval cycle (Captain)

For cold-start testing a published page, fanning out Crew, collecting feedback, rewriting from that feedback, destroying eval stacks, or a “Captain, …” session, follow [SECTION-EVAL.md](SECTION-EVAL.md) and load the Captain skill from `.cursor/skills/captain/` (Cursor) or `.claude/skills/captain/` (Claude Code).
Captain must preflight auth (named profiles plus matching account ids; workspace id when the page requires it) and must not fan out Crew until preflight is green.
Do not start Captain for blank-page authorship.
Do not expand that workflow here.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
