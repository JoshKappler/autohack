"use client";

import { trpc } from "@/components/trpc-provider";

export default function EarningsPage() {
  const { data: earnings, isLoading } = trpc.earnings.useQuery();

  const totalCents = earnings?.reduce(
    (sum: number, b: any) => sum + (b.earnedCents ?? 0),
    0,
  ) ?? 0;

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Earnings</h1>

      <div
        className="mt-6 rounded-xl border p-8"
        style={{
          background: "var(--bg-card)",
          borderColor: "var(--border)",
        }}
      >
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Total Earned
        </p>
        <p
          className="mt-2 text-5xl font-bold tracking-tight"
          style={{ color: "var(--green)" }}
        >
          ${(totalCents / 100).toFixed(2)}
        </p>
        <p className="mt-2 text-sm" style={{ color: "var(--text-dim)" }}>
          From {earnings?.length ?? 0} merged bounties
        </p>
      </div>

      {isLoading && (
        <div className="mt-8 text-center" style={{ color: "var(--text-dim)" }}>
          Loading...
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-lg font-semibold">Completed Bounties</h2>
        <div className="mt-4 space-y-2">
          {earnings?.map((b: any) => (
            <div
              key={b.id}
              className="flex items-center justify-between rounded-lg border px-4 py-3"
              style={{
                background: "var(--bg-card)",
                borderColor: "var(--border)",
              }}
            >
              <div>
                <a
                  href={b.prUrl ?? b.githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium hover:underline"
                  style={{ color: "var(--accent)" }}
                >
                  {b.repoOwner}/{b.repoName}#{b.issueNumber}
                </a>
                <p
                  className="mt-0.5 max-w-lg truncate text-xs"
                  style={{ color: "var(--text-dim)" }}
                >
                  {b.title}
                </p>
              </div>
              <span
                className="font-mono text-lg font-bold"
                style={{ color: "var(--green)" }}
              >
                +${((b.earnedCents ?? 0) / 100).toFixed(0)}
              </span>
            </div>
          ))}
          {earnings?.length === 0 && (
            <p className="py-8 text-center text-sm" style={{ color: "var(--text-dim)" }}>
              No earnings yet. Bounties will appear here once PRs are merged.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
