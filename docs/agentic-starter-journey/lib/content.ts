import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { createHighlighter } from "shiki";
import type { Root } from "mdast";
import type { Root as HastRoot, Element } from "hast";
import { BASE_PATH } from "./site";

const CONTENT_DIR = path.join(process.cwd(), "content");

const LANGS = ["bash", "yaml", "sql", "python", "text"] as const;

// Docusaurus admonition types that appear in the content, mapped to the label
// rendered on the callout. `:::warning` and `:::danger` are the two in use.
const ADMONITIONS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  info: "Info",
  warning: "Warning",
  danger: "Danger",
  caution: "Caution",
};

/**
 * `:::warning` blocks parse as containerDirective nodes. Turn them into a
 * <aside data-callout="warning"> carrying a label, styled in globals.css.
 */
function remarkAdmonitions() {
  return (tree: Root) => {
    visit(tree, "containerDirective", (node: any) => {
      const label = ADMONITIONS[node.name];
      if (!label) return;
      node.data = {
        ...node.data,
        hName: "aside",
        hProperties: { "data-callout": node.name, "data-label": label },
      };
    });
  };
}

/**
 * Highlight fenced code at build time. Shiki runs here rather than in the
 * browser, so no highlighter ships to the client.
 */
function rehypeShiki(highlighter: Awaited<ReturnType<typeof createHighlighter>>) {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "pre" || !parent || index === undefined) return;
      const code = node.children[0];
      if (code?.type !== "element" || code.tagName !== "code") return;

      const className = (code.properties?.className as string[] | undefined) ?? [];
      const lang = className.find((c) => c.startsWith("language-"))?.slice(9) ?? "text";
      const source = code.children
        .map((c) => (c.type === "text" ? c.value : ""))
        .join("")
        .replace(/\n$/, "");

      const html = highlighter.codeToHtml(source, {
        lang: (LANGS as readonly string[]).includes(lang) ? lang : "text",
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });

      // codeToHtml returns a full <pre>; splice it in raw to keep Shiki's spans.
      parent.children[index] = { type: "raw", value: html } as never;
    });
  };
}

let highlighterPromise: ReturnType<typeof createHighlighter> | undefined;
function getHighlighter() {
  highlighterPromise ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [...LANGS],
  });
  return highlighterPromise;
}

/**
 * Next.js prepends basePath to <Link> components but NOT to raw <a> tags
 * emitted from markdown. Internal markdown links are written as
 * `/docs/...` absolute paths (inherited from Docusaurus, which rewrote
 * them itself). Without this plugin those hrefs resolve against the host
 * root and 404 under the `/agentic-starter-journey` basePath.
 *
 * Rewrite `/`, `/#anchor`, and `/docs/...` to `${BASE_PATH}...`.
 * External links, bare anchors, mailto, and already-prefixed hrefs are left alone.
 */
function rehypePrefixBasePath() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string") return;
      const isRoot = href === "/" || href.startsWith("/#");
      if (!isRoot && !href.startsWith("/docs/")) return;
      node.properties!.href = `${BASE_PATH}${href}`;
    });
  };
}

export type Page = {
  slug: string;
  title: string;
  description: string;
  html: string;
};

/** Every content page's slug, e.g. "01-prerequisites/index". */
export function allSlugs(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith(".md")
        ? [path.relative(CONTENT_DIR, full).replace(/\.md$/, "")]
        : [];
    });
  return walk(CONTENT_DIR).sort();
}

export async function getPage(slug: string): Promise<Page> {
  const raw = fs.readFileSync(path.join(CONTENT_DIR, `${slug}.md`), "utf8");
  const { data, content } = matter(raw);

  // The H1 is the page title and is rendered by the layout, so strip it from
  // the body to avoid printing it twice.
  const body = content.replace(/^#\s+(.+)$/m, "").trimStart();
  const title = /^#\s+(.+)$/m.exec(content)?.[1] ?? String(data.sidebar_label ?? slug);

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(remarkAdmonitions)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(rehypeShiki, await getHighlighter())
    .use(rehypePrefixBasePath)
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(body);

  return {
    slug,
    title,
    description: String(data.description ?? ""),
    html: String(file),
  };
}
