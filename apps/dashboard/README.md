# CloseLoop dashboard (read-only demo)

A static Next.js export of one reconciliation snapshot. It reads only `data/snapshot.json`; there is no database, no API route and no LLM call at runtime, and no secret is needed to build it.

```bash
pnpm snapshot                   # from the repo root: regenerate data/snapshot.json (uses .env for LLM explanations, optional)
pnpm --filter dashboard dev     # http://localhost:3000
pnpm --filter dashboard build   # static site in apps/dashboard/out/
```

`data/snapshot.json` is committed: it is synthetic data, recorded from the real MCP tool outputs. Gateway names in the synthetic narrations are replaced with a neutral "Gateway" for display. Add a screenshot or GIF of the agent at `public/demo.gif` (or `.png` / `.webp`) and it appears on the How it works page.

## Deploy to Vercel (Hobby plan)

1. Push the repository to GitHub.
2. In Vercel, choose **Add New… → Project** and import the repository.
3. Set **Root Directory** to `apps/dashboard`. Leave "Include files outside the root directory in the Build Step" enabled (the default): pnpm needs the workspace lockfile at the repo root.
4. Everything else comes from `apps/dashboard/vercel.json`. If you prefer to set it in the UI instead:
   - **Framework Preset:** Other
   - **Install Command:** `pnpm install --frozen-lockfile --filter dashboard`
   - **Build Command:** `pnpm build`
   - **Output Directory:** `out`
5. *(Recommended)* Under **Settings → Environment Variables**, add `ENABLE_EXPERIMENTAL_COREPACK=1`. Vercel then uses the exact pnpm version pinned in the root `package.json` (`packageManager`). No other environment variables are needed, and none should be added: the site needs no secrets.
6. Click **Deploy**. Later pushes to the default branch redeploy automatically; regenerate the snapshot locally (`pnpm snapshot`), commit it, and push.

The install only pulls the dashboard's dependencies (Next.js, React, Tailwind). The engine, SQLite and the MCP server are not installed or run on Vercel.
