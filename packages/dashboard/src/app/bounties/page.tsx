"use client";

import { useState } from "react";
import { trpc } from "@/components/trpc-provider";
import { StatusBadge } from "@/components/status-badge";

const statuses = [
  "all",
  "discovered",
  "analyzing",
  "selected",
  "attempting",
  "solving",
  "pr_created",
  "in_review",
  "merged",
  "rejected",
  "failed",
];

function timeAgo(date: Date | string | number | null): string {
  if (!date) return "";
  const d = typeof date === "object" ? date : new Date(date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function SortHeader({
  label,
  field,
  sortBy,
  sortDir,
  setSortBy,
  setSortDir,
}: {
  label: string;
  field: string;
  sortBy: string;
  sortDir: "asc" | "desc";
  setSortBy: (f: string) => void;
  setSortDir: (d: "asc" | "desc") => void;
}) {
  const active = sortBy === field;
  return (
    <th
      className="pb-3 font-medium cursor-pointer select-none"
      style={{ color: active ? "var(--accent)" : "var(--text-dim)" }}
      onClick={() => {
        if (active) setSortDir(sortDir === "desc" ? "asc" : "desc");
        else { setSortBy(field); setSortDir("desc"); }
      }}
    >
      {label} {active ? (sortDir === "desc" ? "\u2193" : "\u2191") : ""}
    </th>
  );
}

export default function BountiesPage() {
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<string>("priorityScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const { data: bounties, isLoading, refetch } = trpc.bounties.useQuery(
    {
      ...(filter !== "all" ? { status: filter } : {}),
      sortBy: sortBy as any,
      sortDir,
    },
    { refetchInterval: 5000 },
  );
  const approveMutation = trpc.approve.useMutation({ onSuccess: () => refetch() });
  const retryMutation = trpc.retry.useMutation({ onSuccess: () => refetch() });
  const dismissMutation = trpc.dismiss.useMutation({ onSuccess: () => refetch() });
  const solveMutation = trpc.solveSpecificBounty.useMutation({ onSuccess: () => refetch() });

  const statusCounts: Record<string, number> = {};
  bounties?.forEach((b: any) => {
    statusCounts[b.status] = (statusCounts[b.status] ?? 0) + 1;
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Bounties</h1>
        <span className="text-xs" style={{ color: "var(--text-dim)" }}>
          {bounties?.length ?? 0} shown — auto-refreshes
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-1">
        {statuses.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
            style={{
              background: filter === s ? "var(--accent)" : "var(--bg-card)",
              color: filter === s ? "#fff" : "var(--text-dim)",
              border: `1px solid ${filter === s ? "var(--accent)" : "var(--border)"}`,
            }}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Bounty</th>
              <SortHeader label="Reward" field="rewardCents" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
              <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Status</th>
              <SortHeader label="Feasibility" field="feasibilityScore" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
              <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Comp.</th>
              <SortHeader label="Score" field="priorityScore" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
              <SortHeader label="Updated" field="updatedAt" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
              <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={8} className="py-8 text-center" style={{ color: "var(--text-dim)" }}>
                  Loading...
                </td>
              </tr>
            )}
            {bounties?.map((b: any) => (
              <tr
                key={b.id}
                className="transition-colors"
                style={{ borderBottom: "1px solid var(--border)" }}
                onMouseOver={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <td className="py-3 pr-4">
                  <a
                    href={b.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    {b.repoOwner}/{b.repoName}#{b.issueNumber}
                  </a>
                  <p className="mt-0.5 max-w-md truncate text-xs" style={{ color: "var(--text-dim)" }}>
                    {b.title}
                  </p>
                </td>
                <td className="py-3 pr-4 font-mono font-semibold" style={{ color: "var(--green)" }}>
                  ${(b.rewardCents / 100).toFixed(0)}
                </td>
                <td className="py-3 pr-4">
                  <StatusBadge status={b.status} />
                  {b.retryCount > 0 && (
                    <span className="ml-1 text-xs" style={{ color: "var(--text-dim)" }}>
                      (retry {b.retryCount})
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">
                  {b.feasibilityScore != null
                    ? `${(b.feasibilityScore * 100).toFixed(0)}%`
                    : "—"}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">
                  {(() => {
                    try {
                      if (!b.analysisNotes) return "—";
                      const notes = JSON.parse(b.analysisNotes);
                      return (notes.attempts ?? 0) + (notes.existingPRs ?? 0);
                    } catch { return "—"; }
                  })()}
                </td>
                <td className="py-3 pr-4 font-mono text-xs">
                  {b.priorityScore != null ? `${b.priorityScore.toFixed(1)} pts` : "—"}
                </td>
                <td className="py-3 pr-4 text-xs" style={{ color: "var(--text-dim)" }}>
                  {timeAgo(b.updatedAt)}
                </td>
                <td className="py-3">
                  <div className="flex gap-2">
                    {b.status === "selected" && (
                      <>
                        <button
                          onClick={() => solveMutation.mutate(b.id)}
                          disabled={solveMutation.isPending}
                          className="rounded-md px-3 py-1 text-xs font-medium"
                          style={{ background: "var(--green)", color: "#000" }}
                        >
                          Solve Now
                        </button>
                        <button
                          onClick={() => approveMutation.mutate(b.id)}
                          disabled={approveMutation.isPending}
                          className="rounded-md px-3 py-1 text-xs font-medium"
                          style={{ background: "var(--accent)", color: "#fff" }}
                        >
                          Approve
                        </button>
                      </>
                    )}
                    {b.status === "failed" && (
                      <button
                        onClick={() => retryMutation.mutate(b.id)}
                        disabled={retryMutation.isPending}
                        className="rounded-md px-3 py-1 text-xs font-medium"
                        style={{ background: "#1e1b4b", color: "#818cf8" }}
                      >
                        Retry
                      </button>
                    )}
                    {["discovered", "selected", "failed"].includes(b.status) && (
                      <button
                        onClick={() => dismissMutation.mutate(b.id)}
                        disabled={dismissMutation.isPending}
                        className="rounded-md px-3 py-1 text-xs font-medium"
                        style={{ background: "#1c1917", color: "#78716c" }}
                      >
                        Dismiss
                      </button>
                    )}
                    {b.prUrl && (
                      <a
                        href={b.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md px-3 py-1 text-xs font-medium"
                        style={{ background: "#172554", color: "#60a5fa" }}
                      >
                        View PR
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {bounties?.length === 0 && (
              <tr>
                <td colSpan={8} className="py-8 text-center" style={{ color: "var(--text-dim)" }}>
                  No bounties found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
