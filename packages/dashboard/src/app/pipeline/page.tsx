"use client";

import { useState } from "react";
import { trpc } from "@/components/trpc-provider";
import { StatusBadge } from "@/components/status-badge";
import { LogViewer } from "@/components/log-viewer";

const stages = [
  { key: "analyzing", label: "Analyze" },
  { key: "selected", label: "Select" },
  { key: "attempting", label: "Claim" },
  { key: "solving", label: "Solve" },
  { key: "pr_created", label: "PR" },
  { key: "in_review", label: "Review" },
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

function elapsed(date: Date | string | number | null): string {
  if (!date) return "";
  const d = typeof date === "object" ? date : new Date(date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m ${s}s`;
}

export default function PipelinePage() {
  const { data: bounties, isLoading, refetch } = trpc.bounties.useQuery(
    { status: undefined },
    { refetchInterval: 3000 },
  );
  const { data: solverStatus } = trpc.solverStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const approveMutation = trpc.approve.useMutation({ onSuccess: () => refetch() });
  const forceResetBountyMutation = trpc.forceResetBounty.useMutation({ onSuccess: () => refetch() });
  const forceStopMutation = trpc.forceStop.useMutation({ onSuccess: () => refetch() });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const activeStatuses = stages.map((s) => s.key);

  const active = bounties?.filter((b: any) =>
    activeStatuses.includes(b.status),
  );

  const recent = bounties
    ?.filter((b: any) =>
      ["merged", "rejected", "failed"].includes(b.status),
    )
    .slice(0, 5);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pipeline</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
            {active?.length ?? 0} active — refreshes every 3s
          </p>
        </div>
        {active && active.length > 0 && (
          <div className="flex items-center gap-2">
            <div
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--green)", animation: "pulse 2s infinite" }}
            />
            <span className="text-sm" style={{ color: "var(--green)" }}>
              Processing
            </span>
          </div>
        )}
      </div>

      {isLoading && (
        <div className="mt-8 text-center" style={{ color: "var(--text-dim)" }}>
          Loading...
        </div>
      )}

      {active?.length === 0 && !isLoading && (
        <div
          className="mt-8 rounded-xl border p-12 text-center"
          style={{
            background: "var(--bg-card)",
            borderColor: "var(--border)",
            color: "var(--text-dim)",
          }}
        >
          No active pipeline items. The analyzer runs every 2 minutes, solver every 3 minutes.
        </div>
      )}

      <div className="mt-6 space-y-4">
        {active?.map((b: any) => {
          const currentIdx = activeStatuses.indexOf(b.status);
          let notes: any = null;
          try {
            notes = b.analysisNotes ? JSON.parse(b.analysisNotes) : null;
          } catch {}

          const isSolving = b.status === "solving";
          const isExpanded = expandedId === b.id;

          return (
            <div
              key={b.id}
              className="rounded-xl border p-5"
              style={{
                background: "var(--bg-card)",
                borderColor: isSolving ? "var(--accent-dim)" : "var(--border)",
              }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <a
                    href={b.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    {b.repoOwner}/{b.repoName}#{b.issueNumber}
                  </a>
                  <p className="mt-1 text-sm">{b.title}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className="font-mono font-semibold"
                    style={{ color: "var(--green)" }}
                  >
                    ${(b.rewardCents / 100).toFixed(0)}
                  </span>
                  <StatusBadge status={b.status} />
                  {b.attemptedAt && (
                    <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
                      {elapsed(b.attemptedAt)} elapsed
                    </span>
                  )}
                  {!b.attemptedAt && (
                    <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                      {timeAgo(b.updatedAt)}
                    </span>
                  )}
                </div>
              </div>

              {/* Stage progress */}
              <div className="mt-4 flex gap-1">
                {stages.map((stage, idx) => (
                  <div key={stage.key} className="flex-1">
                    <div
                      className="h-1.5 rounded-full transition-all"
                      style={{
                        background:
                          idx < currentIdx
                            ? "var(--green)"
                            : idx === currentIdx
                              ? "var(--accent)"
                              : "var(--border)",
                      }}
                    />
                    <p
                      className="mt-1 text-center text-[10px]"
                      style={{
                        color: idx <= currentIdx ? "var(--text)" : "var(--text-dim)",
                        fontWeight: idx === currentIdx ? 600 : 400,
                      }}
                    >
                      {stage.label}
                    </p>
                  </div>
                ))}
              </div>

              {/* Details row */}
              <div className="mt-3 flex items-center gap-4">
                {b.feasibilityScore != null && (
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                    Feasibility: {(b.feasibilityScore * 100).toFixed(0)}%
                  </span>
                )}
                {b.priorityScore != null && (
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                    Score: {(b.priorityScore / 100).toFixed(0)} pts
                  </span>
                )}
                {b.language && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ background: "var(--bg-hover)", color: "var(--text-dim)" }}
                  >
                    {b.language}
                  </span>
                )}
                {notes?.approach && (
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : b.id)}
                    className="text-xs hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    {isExpanded ? "Hide details" : "Show approach"}
                  </button>
                )}
              </div>

              {/* Expanded approach */}
              {isExpanded && notes?.approach && (
                <div
                  className="mt-3 rounded-lg border p-3 text-xs"
                  style={{ background: "var(--bg)", borderColor: "var(--border)", color: "var(--text-dim)" }}
                >
                  <p className="font-medium" style={{ color: "var(--text)" }}>Approach:</p>
                  <p className="mt-1">{notes.approach}</p>
                  {notes.riskFactors?.length > 0 && (
                    <>
                      <p className="mt-2 font-medium" style={{ color: "var(--text)" }}>Risks:</p>
                      <ul className="mt-1 list-disc pl-4">
                        {notes.riskFactors.map((r: string, i: number) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}

              {/* Live log viewer for solving bounties */}
              {isSolving && (
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <div
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--green)", animation: "pulse 2s infinite" }}
                    />
                    <span className="text-xs font-medium" style={{ color: "var(--text-dim)" }}>
                      Live Output
                    </span>
                  </div>
                  <LogViewer bountyId={b.id} />
                </div>
              )}

              {/* Actions */}
              <div className="mt-3 flex items-center gap-2">
                {b.status === "selected" && (
                  <button
                    onClick={() => approveMutation.mutate(b.id)}
                    disabled={approveMutation.isPending}
                    className="rounded-md px-4 py-1.5 text-sm font-medium"
                    style={{ background: "var(--accent)", color: "#fff" }}
                  >
                    Approve & Start Solving
                  </button>
                )}
                {["solving", "attempting"].includes(b.status) && (
                  <button
                    onClick={() => forceStopMutation.mutate()}
                    disabled={forceStopMutation.isPending}
                    className="rounded-md px-4 py-1.5 text-sm font-medium"
                    style={{ background: "#450a0a", color: "#ef4444", border: "1px solid #7f1d1d" }}
                  >
                    {forceStopMutation.isPending ? "Stopping..." : "Force Stop"}
                  </button>
                )}
                {["analyzing", "solving", "attempting"].includes(b.status) && (
                  <button
                    onClick={() => forceResetBountyMutation.mutate(b.id)}
                    disabled={forceResetBountyMutation.isPending}
                    className="rounded-md px-4 py-1.5 text-sm font-medium"
                    style={{ background: "#1c1917", color: "#f59e0b", border: "1px solid #78350f" }}
                  >
                    {forceResetBountyMutation.isPending ? "Resetting..." : "Reset Bounty"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recently completed */}
      {recent && recent.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
            Recently Completed
          </h2>
          <div className="mt-3 space-y-2">
            {recent.map((b: any) => (
              <div
                key={b.id}
                className="flex items-center justify-between rounded-lg border px-4 py-3"
                style={{
                  background: "var(--bg-card)",
                  borderColor: "var(--border)",
                }}
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={b.status} />
                  <a
                    href={b.prUrl ?? b.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    {b.repoOwner}/{b.repoName}#{b.issueNumber}
                  </a>
                  <span className="max-w-xs truncate text-xs" style={{ color: "var(--text-dim)" }}>
                    {b.title}
                  </span>
                </div>
                <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                  {timeAgo(b.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
