import Link from "next/link";

export default function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-lg font-semibold">Not in this snapshot</h1>
      <p className="mt-2 text-sm text-zinc-500">This read-only demo only contains the October 2026 snapshot.</p>
      <Link href="/" className="mt-4 inline-block text-sm font-medium text-emerald-700 hover:underline dark:text-emerald-400">
        Back to the overview
      </Link>
    </div>
  );
}
