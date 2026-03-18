"use client";

import { useState } from "react";
import { trpc } from "@/components/trpc-provider";

const errorCategories = [
  "all",
  "transient",
  "permanent",
  "validation",
  "timeout",
  "no_changes",
  "git_error",
];

const categoryColors: Record<string, { bg: string; color: string }> = {
  transient: { bg: "#1e1b4b", color: "#818cf8" },
  permanent: { bg: "#1c1917", color: "#ef4444" },
  validation: { bg: "#1a1a00", color: "#eab308" },
  timeout: { bg: "#172554", color: "#60a5fa" },
  no_changes: { bg: "#1c1917", color: "#78716c" },
  git_error: { bg: "#1c1917", color: "#f97316" },
};

function timeAgo(date: Date | string | number | null): string {
  if (!date) return "";
  const d = typeof date === "object" ? date : new Date(date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

export default function TracesPage() {
  const [filter, setFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: stats } = trpc.traceStats.useQuery(undefined, {
    refetchInterval: 5000,
  });

  const { data: traces, isLoading } = trpc.traces.useQuery(
    {
      errorCategory: filter === "all" ? undefined : filter,
      status: statusFilter === "all" ? undefined : (statusFilter as any),
      limit: 100,
    },
    { refetchInterval: 5000 },
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Traces</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
            Pipeline run history and error tracking
          </p>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div
            className="rounded-xl border p-4"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
          >
            <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Total Runs
            </p>
            <p className="mt-1 text-2xl font-bold">{stats.totalRuns}</p>
          </div>
          <div
            className="rounded-xl border p-4"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
          >
            <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Failed
            </p>
            <p className="mt-1 text-2xl font-bold" style={{ color: "var(--red, #ef4444)" }}>
              {stats.failedRuns}
            </p>
            <p className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>
              {stats.failureRate.toFixed(1)}% failure rate
            </p>
          </div>
          <div
            className="rounded-xl border p-4"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
          >
            <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Avg Duration
            </p>
            <p className="mt-1 text-2xl font-bold">{formatDuration(stats.avgDurationMs)}</p>
          </div>
          <div
            className="rounded-xl border p-4"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
          >
            <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Error Breakdown
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(stats.byErrorCategory).map(([cat, count]) => (
                <span
                  key={cat}
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={categoryColors[cat] ?? { bg: "#1c1917", color: "#78716c" }}
                >
                  {cat}: {count as number}
                </span>
              ))}
              {Object.keys(stats.byErrorCategory).length === 0 && (
                <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                  No errors
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-1">
          <span className="mr-1 self-center text-xs font-medium" style={{ color: "var(--text-dim)" }}>
            Status:
          </span>
          {["all", "running", "success", "failed"].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
              style={{
                background: statusFilter === s ? "var(--accent)" : "var(--bg-card)",
                color: statusFilter === s ? "#fff" : "var(--text-dim)",
                border: `1px solid ${statusFilter === s ? "var(--accent)" : "var(--border)"}`,
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <span className="mr-1 self-center text-xs font-medium" style={{ color: "var(--text-dim)" }}>
            Error:
          </span>
          {errorCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat)}
              className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
              style={{
                background: filter === cat ? "var(--accent)" : "var(--bg-card)",
                color: filter === cat ? "#fff" : "var(--text-dim)",
                border: `1px solid ${filter === cat ? "var(--accent)" : "var(--border)"}`,
              }}
            >
              {cat.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {/* Traces list */}
      <div className="mt-5">
        {isLoading && (
          <div className="py-8 text-center" style={{ color: "var(--text-dim)" }}>
            Loading...
          </div>
        )}

        {traces?.length === 0 && !isLoading && (
          <div
            className="rounded-xl border p-12 text-center"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)", color: "var(--text-dim)" }}
          >
            No pipeline traces found. Traces are created when the solver runs.
          </div>
        )}

        <div className="space-y-2">
          {traces?.map((t: any) => {
            const isExpanded = expandedId === t.id;
            const statusColor =
              t.status === "success"
                ? "var(--green, #22c55e)"
                : t.status === "failed"
                  ? "var(--red, #ef4444)"
                  : "var(--accent, #818cf8)";

            return (
              <div
                key={t.id}
                className="rounded-xl border transition-colors"
                style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
              >
                <div
                  className="flex cursor-pointer items-center justify-between px-4 py-3"
                  onClick={() => setExpandedId(isExpanded ? null : t.id)}
                >
                  <div className="flex items-center gap-3">
                    {/* Status dot */}
                    <div
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        background: statusColor,
                        animation: t.status === "running" ? "pulse 2s infinite" : "none",
                      }}
                    />

                    <div>
                      <div className="flex items-center gap-2">
                        {t.repoOwner && (
                          <span className="text-sm font-medium" style={{ color: "var(--accent)" }}>
                            {t.repoOwner}/{t.repoName}#{t.issueNumber}
                          </span>
                        )}
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            background: t.status === "success" ? "#052e16" : t.status === "failed" ? "#1c0a0a" : "#1e1b4b",
                            color: statusColor,
                          }}
                        >
                          {t.status}
                        </span>
                        {t.errorCategory && (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={categoryColors[t.errorCategory] ?? { background: "#1c1917", color: "#78716c" }}
                          >
                            {t.errorCategory.replace("_", " ")}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 max-w-lg truncate text-xs" style={{ color: "var(--text-dim)" }}>
                        {t.bountyTitle ?? "Unknown bounty"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {t.traceId && (
                      <span className="font-mono text-[10px]" style={{ color: "var(--text-dim)" }}>
                        {t.traceId}
                      </span>
                    )}
                    {t.rewardCents != null && (
                      <span className="font-mono text-sm font-semibold" style={{ color: "var(--green, #22c55e)" }}>
                        ${(t.rewardCents / 100).toFixed(0)}
                      </span>
                    )}
                    <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
                      {formatDuration(t.durationMs)}
                    </span>
                    <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                      {timeAgo(t.startedAt)}
                    </span>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div
                    className="border-t px-4 py-3"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <div className="grid gap-3 text-xs lg:grid-cols-2">
                      <div>
                        <p className="font-medium" style={{ color: "var(--text)" }}>Details</p>
                        <div className="mt-1 space-y-1" style={{ color: "var(--text-dim)" }}>
                          <p>Stage: {t.stage}</p>
                          <p>Started: {t.startedAt ? new Date(t.startedAt).toLocaleString() : "—"}</p>
                          <p>Completed: {t.completedAt ? new Date(t.completedAt).toLocaleString() : "—"}</p>
                          <p>Duration: {formatDuration(t.durationMs)}</p>
                          {t.traceId && <p>Trace ID: <span className="font-mono">{t.traceId}</span></p>}
                        </div>
                      </div>

                      {t.errorMessage && (
                        <div>
                          <p className="font-medium" style={{ color: "var(--red, #ef4444)" }}>Error</p>
                          <p className="mt-1" style={{ color: "var(--text-dim)" }}>
                            Category: {t.errorCategory ?? "unknown"}
                          </p>
                          <pre
                            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border p-2 font-mono text-[11px]"
                            style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-dim)" }}
                          >
                            {t.errorMessage}
                          </pre>
                        </div>
                      )}
                    </div>

                    {t.logs && (
                      <div className="mt-3">
                        <p className="text-xs font-medium" style={{ color: "var(--text)" }}>Logs</p>
                        <pre
                          className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border p-2 font-mono text-[11px]"
                          style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-dim)" }}
                        >
                          {t.logs}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
