"use client";

import { useState } from "react";
import { trpc } from "@/components/trpc-provider";
import { StatusBadge } from "@/components/status-badge";
import { LogViewer } from "@/components/log-viewer";

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="rounded-xl border p-5"
      style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
    >
      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
        {label}
      </p>
      <p
        className="mt-1.5 text-2xl font-bold tracking-tight"
        style={color ? { color } : undefined}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>
          {sub}
        </p>
      )}
    </div>
  );
}

function timeAgo(date: Date | string | number | null): string {
  if (!date) return "";
  const d = typeof date === "object" ? date : new Date(date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function elapsed(startedAt: string | number): string {
  const start = typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
  const secs = Math.floor((Date.now() - start) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

const stages = [
  { key: "analyzing", label: "Analyze" },
  { key: "selected", label: "Select" },
  { key: "attempting", label: "Claim" },
  { key: "solving", label: "Solve" },
  { key: "pr_created", label: "PR" },
  { key: "in_review", label: "Review" },
];

const statusVerb: Record<string, string> = {
  discovered: "Discovered",
  analyzing: "Analyzing",
  selected: "Selected",
  attempting: "Claiming",
  solving: "Solving",
  pr_created: "PR submitted",
  in_review: "In review",
  merged: "Merged",
  rejected: "Rejected",
  skipped: "Skipped",
  failed: "Failed",
};

export default function Home() {
  const { data: stats, isLoading } = trpc.stats.useQuery(undefined, {
    refetchInterval: 3000,
  });
  const { data: activity } = trpc.activity.useQuery(undefined, {
    refetchInterval: 3000,
  });
  const { data: config } = trpc.config.useQuery();
  const { data: solverStatus } = trpc.solverStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: analyzeStatus } = trpc.analyzeAllStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: selectedBounties, refetch: refetchSelected } = trpc.bounties.useQuery(
    { status: "selected", limit: 10 },
    { refetchInterval: 5000 },
  );

  const utils = trpc.useUtils();
  const discoverMutation = trpc.discoverNow.useMutation({
    onSuccess: () => utils.stats.invalidate(),
  });
  const analyzeAllMutation = trpc.analyzeAll.useMutation({
    onSuccess: () => utils.analyzeAllStatus.invalidate(),
  });
  const stopAnalyzeMutation = trpc.stopAnalyzeAll.useMutation({
    onSuccess: () => {
      utils.analyzeAllStatus.invalidate();
      utils.stats.invalidate();
      utils.bounties.invalidate();
    },
  });
  const reassessMutation = trpc.reassessAll.useMutation({
    onSuccess: () => {
      utils.stats.invalidate();
      utils.bounties.invalidate();
      utils.activity.invalidate();
    },
  });
  const forceStopMutation = trpc.forceStop.useMutation({
    onSuccess: () => {
      utils.solverStatus.invalidate();
      utils.stats.invalidate();
      utils.bounties.invalidate();
      utils.analyzeAllStatus.invalidate();
      utils.activity.invalidate();
    },
  });
  const forceResetMutation = trpc.forceReset.useMutation({
    onSuccess: () => {
      utils.solverStatus.invalidate();
      utils.stats.invalidate();
      utils.bounties.invalidate();
      utils.analyzeAllStatus.invalidate();
      utils.activity.invalidate();
    },
  });
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [autoSolveError, setAutoSolveError] = useState<string | null>(null);
  const autoSolveMutation = trpc.startAutoSolve.useMutation({
    onSuccess: (data: any) => {
      utils.solverStatus.invalidate();
      if (!data.started) {
        setAutoSolveError(
          data.reason === "already running"
            ? "Auto-solve is already running"
            : data.reason === "solver busy"
              ? "Solver is busy with another bounty"
              : data.reason ?? "Unknown error",
        );
      } else {
        setAutoSolveError(null);
      }
    },
  });
  if (isLoading || !stats) {
    return (
      <div
        className="flex h-64 items-center justify-center"
        style={{ color: "var(--text-dim)" }}
      >
        Loading...
      </div>
    );
  }

  const earned = (stats.totalEarnedCents / 100).toFixed(2);
  const isAgentActive = solverStatus?.active === true;
  const isAnalyzing = analyzeStatus?.running === true || stats?.pipelinePhase === "analyzing";
  const discoveredCount = stats.byStatus["discovered"] ?? 0;
  const selectedCount = stats.byStatus["selected"] ?? 0;
  const isBusy = isAgentActive || isAnalyzing;
  const assessedCount = stats.analyzedCount ?? 0;

  return (
    <div>
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight">Command Center</h1>
          <button
            onClick={() => discoverMutation.mutate()}
            disabled={discoverMutation.isPending}
            className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              background: "var(--bg-card)",
              color: discoverMutation.isPending ? "var(--text-dim)" : "var(--accent)",
              border: "1px solid var(--border)",
            }}
          >
            {discoverMutation.isPending ? "Discovering..." : "Discover New"}
          </button>
        </div>
        <div className="flex items-center gap-3">
          {/* Emergency Reset — always visible */}
          {showResetConfirm ? (
            <div
              className="flex items-center gap-2 rounded-lg border px-3 py-2"
              style={{ background: "#450a0a", borderColor: "#7f1d1d" }}
            >
              <span className="text-xs" style={{ color: "#fca5a5" }}>Reset everything?</span>
              <button
                onClick={() => {
                  forceResetMutation.mutate();
                  setShowResetConfirm(false);
                }}
                className="rounded px-2 py-1 text-xs font-bold"
                style={{ background: "#dc2626", color: "#fff" }}
              >
                Confirm
              </button>
              <button
                onClick={() => setShowResetConfirm(false)}
                className="rounded px-2 py-1 text-xs"
                style={{ color: "#fca5a5" }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowResetConfirm(true)}
              disabled={forceResetMutation.isPending}
              className="rounded-lg px-3 py-2 text-xs font-medium transition-colors"
              style={{ background: "#1c1917", color: "#ef4444", border: "1px solid #7f1d1d" }}
              title="Emergency reset: kill all processes, clear all stuck state"
            >
              {forceResetMutation.isPending ? "Resetting..." : "Emergency Reset"}
            </button>
          )}

          <div
            className="flex items-center gap-3 rounded-lg border px-4 py-2"
            style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
          >
            <div
              className="h-2.5 w-2.5 rounded-full"
              style={{
                background: isAgentActive ? "var(--green)" : isAnalyzing ? "var(--accent)" : "var(--yellow)",
                boxShadow: isAgentActive
                  ? "0 0 8px var(--green)"
                  : isAnalyzing
                    ? "0 0 8px var(--accent)"
                    : "0 0 8px var(--yellow)",
                animation: isAgentActive || isAnalyzing ? "pulse 2s infinite" : "none",
              }}
            />
            <span className="text-sm font-medium">
              {isAgentActive ? "Solving" : isAnalyzing ? "Analyzing" : "Idle"}
            </span>
            {config && (
              <span
                className="rounded-full px-2 py-0.5 text-xs"
                style={{
                  background: config.claudeBackend === "cli" ? "#052e16" : "#1e1b4b",
                  color: config.claudeBackend === "cli" ? "#4ade80" : "#818cf8",
                }}
              >
                {config.claudeBackend === "cli" ? "Max" : "API"} / {isAnalyzing ? config.analysisModel : config.claudeModel}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Active solve hero card */}
      {isAgentActive && solverStatus && (
        <div
          className="mt-5 rounded-xl border-2 p-5"
          style={{ background: "var(--bg-card)", borderColor: "var(--accent-dim)" }}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div
                  className="h-2 w-2 rounded-full"
                  style={{ background: "var(--green)", animation: "pulse 2s infinite" }}
                />
                <span className="text-xs font-medium uppercase tracking-wider" style={{ color: "var(--green)" }}>
                  Solving Now
                </span>
              </div>
              <a
                href={`https://github.com/${solverStatus.repo}/issues/${solverStatus.issueNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block text-lg font-semibold hover:underline"
                style={{ color: "var(--accent)" }}
              >
                {solverStatus.repo}#{solverStatus.issueNumber}
              </a>
              <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
                {solverStatus.title}
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <span className="font-mono text-xl font-bold" style={{ color: "var(--green)" }}>
                  ${((solverStatus.rewardCents ?? 0) / 100).toFixed(0)}
                </span>
                <p className="text-xs" style={{ color: "var(--text-dim)" }}>
                  {solverStatus.startedAt ? `${elapsed(solverStatus.startedAt)} / ${solverStatus.timeoutMinutes}m max` : ""}
                </p>
                {(solverStatus as any).linesOutput != null && (
                  <p className="text-[10px] font-mono" style={{ color: "var(--text-dim)" }}>
                    {(solverStatus as any).linesOutput} lines output
                    {(solverStatus as any).lastActivity
                      ? ` · active ${elapsed((solverStatus as any).lastActivity)} ago`
                      : ""}
                  </p>
                )}
              </div>
              <button
                onClick={() => forceStopMutation.mutate()}
                disabled={forceStopMutation.isPending}
                className="rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
                style={{ background: "#450a0a", color: "#ef4444", border: "1px solid #7f1d1d" }}
              >
                {forceStopMutation.isPending ? "Stopping..." : "Force Stop"}
              </button>
            </div>
          </div>

          {/* Stage progress bar */}
          <div className="mt-4 flex gap-1">
            {stages.map((stage, idx) => {
              const currentIdx = stages.findIndex((s) => s.key === solverStatus.stage);
              return (
                <div key={stage.key} className="flex-1">
                  <div
                    className="h-1.5 rounded-full"
                    style={{
                      background:
                        idx < currentIdx
                          ? "var(--green)"
                          : idx === currentIdx
                            ? "var(--accent)"
                            : "var(--border)",
                      transition: "background 0.3s",
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
              );
            })}
          </div>

          {/* Live output */}
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium" style={{ color: "var(--text-dim)" }}>
                Live Output
              </span>
              <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                auto-scrolling
              </span>
            </div>
            <LogViewer bountyId={solverStatus.bountyId!} />
          </div>
        </div>
      )}

      {/* ── Action Cards ── */}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/* Card 1: Analyze All */}
        <div
          className="rounded-xl border p-5"
          style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Analyze Bounties
            </h2>
            <span className="font-mono text-lg font-bold" style={{ color: discoveredCount > 0 ? "var(--accent)" : "var(--text-dim)" }}>
              {discoveredCount}
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--text-dim)" }}>
            {discoveredCount > 0
              ? `${discoveredCount} discovered bounties awaiting analysis`
              : "No bounties to analyze — click Discover New"}
          </p>

          {/* Progress bar when running */}
          {isAnalyzing && analyzeStatus && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-dim)" }}>
                <span>
                  {analyzeStatus.completed}/{analyzeStatus.total} done
                </span>
                <span>{analyzeStatus.startedAt ? elapsed(analyzeStatus.startedAt) : ""}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    background: "var(--accent)",
                    width: `${analyzeStatus.total > 0 ? (analyzeStatus.completed / analyzeStatus.total) * 100 : 0}%`,
                  }}
                />
              </div>
              {analyzeStatus.currentBountyTitle && (
                <p className="mt-1.5 truncate text-xs" style={{ color: "var(--text-dim)" }}>
                  Analyzing: {analyzeStatus.currentBountyTitle}
                </p>
              )}
              {analyzeStatus.errors.length > 0 && (
                <p className="mt-1 text-xs" style={{ color: "var(--red)" }}>
                  {analyzeStatus.errors.length} error{analyzeStatus.errors.length > 1 ? "s" : ""}
                </p>
              )}
            </div>
          )}

          <div className="mt-4 flex gap-2">
            {isAnalyzing ? (
              <button
                onClick={() => stopAnalyzeMutation.mutate()}
                className="flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors"
                style={{ background: "#1c1917", color: "#ef4444", border: "1px solid #7f1d1d" }}
              >
                Stop Analysis
              </button>
            ) : (
              <button
                onClick={() => analyzeAllMutation.mutate()}
                disabled={discoveredCount === 0 || isAgentActive}
                className="flex-1 rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:opacity-40"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                Analyze {discoveredCount} Bount{discoveredCount === 1 ? "y" : "ies"}
              </button>
            )}
            <button
              onClick={() => reassessMutation.mutate()}
              disabled={assessedCount === 0 || isBusy || reassessMutation.isPending}
              className="rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40"
              style={{
                background: "var(--bg-card)",
                color: "var(--yellow)",
                border: "1px solid var(--border)",
              }}
              title="Reset all assessments and re-analyze from scratch"
            >
              {reassessMutation.isPending ? "Resetting..." : "Reassess"}
            </button>
          </div>
        </div>

        {/* Card 2: Auto Solve */}
        <div
          className="rounded-xl border p-5"
          style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
              Auto Solve
            </h2>
            <span className="font-mono text-lg font-bold" style={{ color: selectedCount > 0 ? "var(--green)" : "var(--text-dim)" }}>
              {selectedCount}
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: "var(--text-dim)" }}>
            {selectedCount > 0
              ? `${selectedCount} bounties ready — will solve by highest priority`
              : discoveredCount > 0
                ? "Analyze bounties first to find solvable ones"
                : "No bounties available yet"}
          </p>

          {/* Show top pick if available */}
          {selectedBounties && selectedBounties.length > 0 && (
            <div
              className="mt-3 rounded-lg border p-2.5"
              style={{ borderColor: "var(--border)", background: "var(--bg-hover)" }}
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--green)" }}>
                  Top Pick
                </span>
                <span className="font-mono text-sm font-bold" style={{ color: "var(--green)" }}>
                  ${((selectedBounties[0] as any).rewardCents / 100).toFixed(0)}
                </span>
              </div>
              <p className="mt-1 truncate text-xs font-medium">
                {(selectedBounties[0] as any).repoOwner}/{(selectedBounties[0] as any).repoName}#{(selectedBounties[0] as any).issueNumber}
              </p>
              <div className="mt-1 flex gap-3 text-[10px]" style={{ color: "var(--text-dim)" }}>
                <span>
                  {(selectedBounties[0] as any).feasibilityScore != null
                    ? `${((selectedBounties[0] as any).feasibilityScore * 100).toFixed(0)}% feasible`
                    : ""}
                </span>
                <span>
                  {(selectedBounties[0] as any).priorityScore != null
                    ? `${((selectedBounties[0] as any).priorityScore / 100).toFixed(0)} pts`
                    : ""}
                </span>
              </div>
            </div>
          )}

          <div className="mt-4">
            <button
              onClick={() => {
                setAutoSolveError(null);
                autoSolveMutation.mutate();
              }}
              disabled={isBusy || selectedCount === 0}
              className="w-full rounded-lg py-2.5 text-sm font-semibold transition-colors disabled:opacity-40"
              style={{ background: "var(--green)", color: "#000" }}
            >
              {isAgentActive ? "Solving..." : "Start Auto Solve"}
            </button>
            {autoSolveError && (
              <p className="mt-2 text-center text-xs" style={{ color: "var(--red)" }}>
                {autoSolveError}
              </p>
            )}
          </div>
        </div>

      </div>

      {/* Stats row */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total Earned"
          value={`$${earned}`}
          sub={`${stats.byStatus["merged"] ?? 0} merged`}
          color="var(--green)"
        />
        <StatCard
          label="Success Rate"
          value={
            (stats.byStatus["merged"] ?? 0) + (stats.byStatus["rejected"] ?? 0) > 0
              ? `${Math.round(
                  ((stats.byStatus["merged"] ?? 0) /
                    ((stats.byStatus["merged"] ?? 0) + (stats.byStatus["rejected"] ?? 0))) *
                    100,
                )}%`
              : "--"
          }
          sub={`${stats.byStatus["failed"] ?? 0} failed, ${stats.byStatus["rejected"] ?? 0} rejected`}
        />
        <StatCard
          label="Pipeline"
          value={stats.activePipeline}
          sub={`${stats.byStatus["solving"] ?? 0} solving, ${stats.byStatus["analyzing"] ?? 0} analyzing`}
          color={stats.activePipeline > 0 ? "var(--accent)" : undefined}
        />
        <StatCard
          label="Analyzed"
          value={stats.analyzedCount ?? 0}
          sub={`${stats.totalBounties} total, ${stats.byStatus["discovered"] ?? 0} pending`}
        />
      </div>

      {/* Recent activity */}
      <div className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
          Recent Activity
        </h2>
        <div
          className="mt-3 rounded-xl border"
          style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
        >
          {activity?.length === 0 && (
            <p className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>
              No activity yet.
            </p>
          )}
          {activity?.slice(0, 12).map((b: any, i: number) => (
            <div
              key={b.id}
              className="flex items-center justify-between px-4 py-2.5"
              style={{
                borderBottom:
                  i < Math.min((activity?.length ?? 0), 12) - 1
                    ? "1px solid var(--border)"
                    : "none",
              }}
            >
              <div className="flex items-center gap-3">
                <StatusBadge status={b.status} />
                <div>
                  <a
                    href={b.githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    {b.repoOwner}/{b.repoName}#{b.issueNumber}
                  </a>
                  <p className="max-w-lg truncate text-xs" style={{ color: "var(--text-dim)" }}>
                    {statusVerb[b.status] ?? b.status} — {b.title}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className="font-mono text-sm font-semibold" style={{ color: "var(--green)" }}>
                  ${(b.rewardCents / 100).toFixed(0)}
                </span>
                <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
                  {timeAgo(b.updatedAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
