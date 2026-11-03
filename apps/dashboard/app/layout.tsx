import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { THEME_SCRIPT, ThemeToggle } from "@/components/theme-toggle";
import { dateLabel } from "@/lib/format";
import { snapshot } from "@/lib/snapshot";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CloseLoop · Month-end reconciliation", template: "%s · CloseLoop" },
  description: "Read-only demo of CloseLoop: deterministic reconciliation of gateway settlements, bank statement and ledger, with a constrained AI layer. Synthetic data.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-emerald-600" />
        <path d="M21.5 11.5a7 7 0 1 0 0 9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <circle cx="22" cy="16" r="2.2" fill="#fff" />
      </svg>
      CloseLoop
    </Link>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const s = snapshot();
  return (
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen flex-col">
        <div className="sticky top-0 z-40">
          <div role="note" className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:bg-amber-900/60 dark:text-amber-100">
            Synthetic demo data · Read-only · Run the full agent with approvals locally: <code className="font-mono">npx closeloop-mcp</code>
          </div>
          <header className="border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
              <Logo />
              <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">
                <Nav />
              </div>
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </div>
          </header>
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        <footer className="border-t border-zinc-200 py-6 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <div className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-1 px-4 sm:px-6">
            <span>
              Snapshot generated {dateLabel(s.generated_at)}
              {s.commit ? ` from commit ${s.commit}` : ""} · seed {s.dataset.seed}, {s.dataset.payments.toLocaleString("en-IN")} synthetic payments
            </span>
            <span>Static site: no database, API routes or LLM calls at runtime.</span>
            {s.repo_url && (
              <a className="underline hover:text-zinc-800 dark:hover:text-zinc-200" href={s.repo_url}>
                Source
              </a>
            )}
          </div>
        </footer>
      </body>
    </html>
  );
}
