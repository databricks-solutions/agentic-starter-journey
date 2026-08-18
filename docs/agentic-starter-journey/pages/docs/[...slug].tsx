import Head from "next/head";
import Link from "next/link";
import type { GetStaticPaths, GetStaticProps } from "next";
import { allSlugs, getPage, type Page } from "@/lib/content";
import { hrefFor, nextOf } from "@/lib/nav";

type Props = {
  page: Page;
  next: { label: string; href: string } | null;
};

export default function DocPage({ page, next }: Props) {
  return (
    <>
      <Head>
        <title>{`${page.title} - Agentic Starter Journey`}</title>
        {page.description && <meta name="description" content={page.description} />}
      </Head>
      {/* max-w-3xl, not 2xl: nearly every page carries a dense input or
          failure-mode table that reads as cramped at prose width. */}
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {page.title}
        </h1>
        <div
          className="markdown mt-10"
          dangerouslySetInnerHTML={{ __html: page.html }}
        />

        <nav
          aria-label="Page navigation"
          className="mt-20 flex flex-col gap-3 border-t border-neutral-200 pt-8 dark:border-neutral-800"
        >
          {next && (
            <Link href={next.href} className="text-base no-underline hover:underline">
              <span className="text-neutral-400 dark:text-neutral-600">Next: </span>
              <span className="text-neutral-900 dark:text-neutral-100">{next.label}</span>
            </Link>
          )}
          <Link
            href="/"
            className="text-base text-neutral-500 no-underline hover:underline dark:text-neutral-400"
          >
            Back to contents
          </Link>
        </nav>
      </main>
    </>
  );
}

export const getStaticPaths: GetStaticPaths = () => ({
  // "foo/index" serves at /docs/foo/, so the trailing "index" segment is dropped.
  paths: allSlugs().map((slug) => ({
    params: { slug: slug.replace(/\/index$/, "").split("/") },
  })),
  fallback: false,
});

export const getStaticProps: GetStaticProps<Props> = async ({ params }) => {
  const parts = (params!.slug as string[]).join("/");
  // A directory route maps back to its index file on disk.
  const slug = allSlugs().includes(parts) ? parts : `${parts}/index`;
  const page = await getPage(slug);
  const n = nextOf(slug);

  return {
    props: {
      page,
      next: n ? { label: n.label, href: hrefFor(n.slug) } : null,
    },
  };
};
