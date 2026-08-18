import Head from "next/head";
import Link from "next/link";
import { HOW_TO_USE, SECTIONS, hrefFor } from "@/lib/nav";

const DESCRIPTION =
  "Machine-readable runbooks that take a coding agent from an empty Databricks account to a deployed, bundle-defined project.";

export default function LandingPage() {
  return (
    <>
      <Head>
        <title>Agentic Starter Journey</title>
        <meta name="description" content={DESCRIPTION} />
      </Head>
      <main className="mx-auto max-w-2xl px-6 py-20 sm:py-28">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Agentic Starter Journey
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-neutral-600 dark:text-neutral-400">
          {DESCRIPTION}
        </p>

        <p className="mt-8 text-sm text-neutral-600 dark:text-neutral-400">
          Page contract:{" "}
          <Link href={hrefFor(HOW_TO_USE.slug)} className="underline">
            {HOW_TO_USE.label}
          </Link>
        </p>

        <nav aria-label="Contents" className="mt-10">
          <ul className="divide-y divide-neutral-200 border-t border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {SECTIONS.map((s) => (
              <li key={s.slug} className="py-5">
                <Link href={hrefFor(s.slug)} className="group flex items-baseline gap-4 no-underline">
                  <span className="w-6 shrink-0 text-right font-mono text-sm text-neutral-400 dark:text-neutral-600">
                    {s.number}
                  </span>
                  <span className="text-lg text-neutral-900 group-hover:underline dark:text-neutral-100">
                    {s.label}
                  </span>
                </Link>
                <p className="mt-1 pl-10 text-sm text-neutral-600 dark:text-neutral-400">
                  Pick if: {s.pickIf}
                </p>
              </li>
            ))}
          </ul>
        </nav>
      </main>
    </>
  );
}
