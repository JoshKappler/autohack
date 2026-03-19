"use client";

import { useState, useEffect, Fragment } from "react";
import { trpc } from "@/components/trpc-provider";
import { StatusBadge, displayLabels } from "@/components/status-badge";
import { useSecurityStatus } from "@/components/use-security-status";
import { SecurityLogViewer } from "@/components/log-viewer";

const findingStatusGroups: Record<string, string[]> = {
  all: [],
  "in progress": ["discovered", "scanning", "analyzing", "validated", "drafting"],
  "ready": ["report_ready", "reviewing"],
  "submitted": ["submitted", "triaged", "accepted"],
  "rewarded": ["rewarded"],
  "bot rejected": ["bot_rejected"],
  "closed": ["duplicate", "not_applicable", "informative", "failed", "dismissed"],
};
const findingStatuses = Object.keys(findingStatusGroups);

const severityColors: Record<string, { bg: string; text: string }> = {
  critical: { bg: "#450a0a", text: "#f87171" },
  high: { bg: "#431407", text: "#fb923c" },
  medium: { bg: "#422006", text: "#fbbf24" },
  low: { bg: "#172554", text: "#60a5fa" },
  informational: { bg: "#1e293b", text: "#94a3b8" },
};

function SeverityBadge({ severity }: { severity: string | null }) {
  if (!severity) return <span style={{ color: "var(--text-dim)" }}>--</span>;
  const colors = severityColors[severity] ?? { bg: "#1e293b", text: "#94a3b8" };
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-xs font-medium uppercase"
      style={{ background: colors.bg, color: colors.text }}
    >
      {severity}
    </span>
  );
}

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

function SeverityBar({ bySeverity }: { bySeverity: Record<string, number> }) {
  const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const order = ["critical", "high", "medium", "low", "informational"];
  return (
    <div className="flex gap-0.5 overflow-hidden rounded-full" style={{ height: 8 }}>
      {order.map((sev) => {
        const count = bySeverity[sev] ?? 0;
        if (count === 0) return null;
        return (
          <div
            key={sev}
            title={`${sev}: ${count}`}
            style={{
              width: `${(count / total) * 100}%`,
              background: severityColors[sev]?.text ?? "#94a3b8",
              minWidth: 4,
            }}
          />
        );
      })}
    </div>
  );
}

function timeAgo(date: Date | string | number | null): string {
  if (!date) return "";
  const d = typeof date === "object" ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (secs < 86400) return remMins > 0 ? `${hrs}h ${remMins}m ago` : `${hrs}h ago`;
  const days = Math.floor(secs / 86400);
  const remHrs = Math.floor((secs % 86400) / 3600);
  return remHrs > 0 ? `${days}d ${remHrs}h ago` : `${days}d ago`;
}

function elapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function RecentHunts() {
  const { data: history } = trpc.securityHuntHistory.useQuery(undefined, {
    refetchInterval: 5000,
  });

  if (!history || history.length === 0) return null;

  return (
    <div
      className="mt-4 rounded-xl border p-5"
      style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
        Recent Hunts
      </h3>
      <div className="mt-3">
        {history.slice(0, 10).map((h: any, i: number) => (
          <div
            key={`${h.programId}-${h.timestamp}`}
            className="flex items-center justify-between py-2 text-xs"
            style={{ borderBottom: i < Math.min(history.length, 10) - 1 ? "1px solid var(--border)" : "none" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  background: h.strategyUsed === "failed"
                    ? "var(--red, #ef4444)"
                    : h.findingsReported > 0
                      ? "var(--green)"
                      : "var(--text-dim)",
                }}
              />
              <span className="font-medium">{h.programName}</span>
            </div>
            <div className="flex items-center gap-3">
              {h.findingsReported > 0 && (
                <span className="font-mono font-semibold" style={{ color: "var(--green)" }}>
                  {h.findingsReported} found
                </span>
              )}
              {h.strategyUsed === "failed" && (
                <span style={{ color: "var(--red, #ef4444)" }}>failed</span>
              )}
              {h.findingsReported === 0 && h.strategyUsed !== "failed" && (
                <span style={{ color: "var(--text-dim)" }}>no findings</span>
              )}
              <span className="tabular-nums" style={{ color: "var(--text-dim)" }}>
                {timeAgo(h.timestamp)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
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
      className="pb-3 pr-6 font-medium cursor-pointer select-none whitespace-nowrap"
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

function parseAssessment(scopeSummary: string | null): {
  scopes: any[];
  assessment: { opportunityScore: number; targetCount: number; topTargets: any[]; techStack: string[]; attackSurface: string; assessedAt?: string } | null;
} {
  if (!scopeSummary) return { scopes: [], assessment: null };
  try {
    const parsed = JSON.parse(scopeSummary);
    if (parsed.assessment) {
      return { scopes: parsed.scopes ?? [], assessment: parsed.assessment };
    }
    // Legacy format: just an array of scopes
    if (Array.isArray(parsed)) {
      return { scopes: parsed, assessment: null };
    }
    return { scopes: [], assessment: null };
  } catch {
    return { scopes: [], assessment: null };
  }
}

interface AdversarialReviewData {
  verdict: "approve" | "reject";
  issues: Array<{ category: string; severity: string; description: string }>;
  reasoning: string;
  adjustedConfidence: number;
  reviewedAt?: string;
}

function parseFindingNotes(analysisNotes: string | null): {
  difficulty?: number;
  approach?: string;
  riskFactors?: string[];
  estimatedRewardCents?: number;
  adversarialReview?: AdversarialReviewData;
} {
  if (!analysisNotes) return {};
  try {
    return JSON.parse(analysisNotes);
  } catch {
    return {};
  }
}

type Tab = "overview" | "programs" | "findings";

export default function SecurityPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<string>("discoveredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [programSort, setProgramSort] = useState<string>("score");
  const [programSortDir, setProgramSortDir] = useState<"asc" | "desc">("desc");
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  // Force periodic re-renders so relative timestamps (timeAgo) stay fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const serverSortable = ["rewardMaxCents", "name", "updatedAt"];
  const { data: rawPrograms, isLoading: programsLoading } = trpc.securityPrograms.useQuery(
    {
      sortBy: (serverSortable.includes(programSort) ? programSort : "rewardMaxCents") as any,
      sortDir: serverSortable.includes(programSort) ? programSortDir : "desc",
      limit: 250,
    },
    { refetchInterval: 5000 },
  );

  // Compute opportunity score and combined score for each program, then sort client-side
  const programs = (() => {
    if (!rawPrograms) return rawPrograms;
    const enriched = rawPrograms.map((p: any) => {
      const { assessment } = parseAssessment(p.scopeSummary);
      const opportunity = assessment?.opportunityScore ?? 0;
      const rewardDollars = (p.rewardMaxCents ?? 0) / 100;
      const score = 100 * opportunity * opportunity * Math.log10(rewardDollars + 1);
      return { ...p, _opportunity: opportunity, _score: score };
    });

    // Always push hunted programs to the bottom, then sort by selected column
    const sortKey = serverSortable.includes(programSort)
      ? programSort
      : programSort === "opportunity" ? "_opportunity" : "_score";

    enriched.sort((a: any, b: any) => {
      const aHunted = a.lastHuntedAt ? 1 : 0;
      const bHunted = b.lastHuntedAt ? 1 : 0;
      if (aHunted !== bHunted) return aHunted - bHunted;

      const aVal = a[sortKey] ?? 0;
      const bVal = b[sortKey] ?? 0;
      if (typeof aVal === "string") {
        return programSortDir === "desc"
          ? bVal.localeCompare(aVal)
          : aVal.localeCompare(bVal);
      }
      return programSortDir === "desc" ? bVal - aVal : aVal - bVal;
    });
    return enriched;
  })();

  const { data: findings, isLoading: findingsLoading, refetch } = trpc.securityFindings.useQuery(
    {
      ...(filter !== "all" && findingStatusGroups[filter]?.length ? { statuses: findingStatusGroups[filter] } : {}),
      sortBy: sortBy as any,
      sortDir,
    },
    { refetchInterval: 5000 },
  );

  const { data: detailedStats } = trpc.securityDetailedStats.useQuery(undefined, { refetchInterval: 5000 });
  const { data: analyzeStatus } = trpc.securityAnalyzeStatus.useQuery(undefined, { refetchInterval: 2000 });
  const securityStatus = useSecurityStatus();

  const utils = trpc.useUtils();

  const discoverMutation = trpc.securityDiscoverNow.useMutation({
    onSuccess: () => {
      utils.securityPrograms.invalidate();
      utils.securityDetailedStats.invalidate();
    },
  });
  const analyzeProgramsMutation = trpc.securityAnalyzePrograms.useMutation({
    onSuccess: () => utils.securityAnalyzeStatus.invalidate(),
  });
  const stopAnalyzeMutation = trpc.securityStopAnalyze.useMutation({
    onSuccess: () => {
      utils.securityAnalyzeStatus.invalidate();
      utils.securityDetailedStats.invalidate();
      utils.securityFindings.invalidate();
    },
  });
  const reassessMutation = trpc.securityReassessPrograms.useMutation({
    onSuccess: () => {
      utils.securityPrograms.invalidate();
      utils.securityFindings.invalidate();
      utils.securityDetailedStats.invalidate();
    },
  });
  const acceptMutation = trpc.securityAccept.useMutation({ onSuccess: () => refetch() });
  const rejectMutation = trpc.securityReject.useMutation({ onSuccess: () => refetch() });
  const undoRejectMutation = trpc.securityUndoReject.useMutation({ onSuccess: () => refetch() });
  const retryMutation = trpc.securityRetry.useMutation({ onSuccess: () => refetch() });
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const approveReportMutation = trpc.securityApproveReport.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        setSubmitError(null);
      } else {
        setSubmitError(data.error ?? "Submission failed");
      }
      refetch();
    },
    onError: (err) => {
      setSubmitError(err.message);
    },
  });
  const deleteFindingMutation = trpc.securityDeleteFinding.useMutation({
    onSuccess: () => {
      refetch();
      utils.securityDetailedStats.invalidate();
    },
  });
  const deleteAllFindingsMutation = trpc.securityDeleteAllFindings.useMutation({
    onSuccess: () => {
      refetch();
      utils.securityDetailedStats.invalidate();
    },
  });
  const reassessFindingsMutation = trpc.securityReassessFindings.useMutation({
    onSuccess: () => {
      refetch();
      utils.securityDetailedStats.invalidate();
      utils.securityAdversarialStatus.invalidate();
    },
  });
  const resetFindingMutation = trpc.securityForceResetFinding.useMutation({
    onSuccess: () => {
      refetch();
      utils.securityDetailedStats.invalidate();
    },
  });
  const solveFindingMutation = trpc.securitySolveFinding.useMutation({
    onSuccess: () => {
      refetch();
      utils.securitySolverStatus.invalidate();
      utils.securityDetailedStats.invalidate();
    },
  });
  const autoSolveMutation = trpc.securityAutoSolve.useMutation({
    onSuccess: () => {
      utils.securitySolverStatus.invalidate();
      utils.securityDetailedStats.invalidate();
      refetch();
    },
  });
  const huntProgramMutation = trpc.securityHuntProgram.useMutation({
    onSuccess: () => {
      utils.securitySolverStatus.invalidate();
      utils.securityDetailedStats.invalidate();
      utils.securityFindings.invalidate();
    },
  });
  const autoHuntMutation = trpc.securityAutoHunt.useMutation({
    onSuccess: () => {
      utils.securitySolverStatus.invalidate();
      utils.securityDetailedStats.invalidate();
      utils.securityFindings.invalidate();
    },
  });
  const forceStopMutation = trpc.securityForceStopSolver.useMutation({
    onSuccess: () => {
      utils.securitySolverStatus.invalidate();
      utils.securityDetailedStats.invalidate();
      refetch();
    },
  });
  const killAllMutation = trpc.securityKillAll.useMutation({
    onSuccess: () => {
      utils.securitySolverStatus.invalidate();
      utils.securityAdversarialStatus.invalidate();
      utils.securityAnalyzeStatus.invalidate();
      utils.securityDetailedStats.invalidate();
      refetch();
    },
  });
  const { data: autoHuntEnabled } = trpc.securityAutoHuntEnabled.useQuery(undefined, { refetchInterval: 5000 });
  const setAutoHuntMutation = trpc.securitySetAutoHunt.useMutation({
    onSuccess: () => {
      utils.securityAutoHuntEnabled.invalidate();
    },
  });


  const { isAnalyzing, isSolving, isReviewing, solver: solverStatus, adversarial: adversarialProgress } = securityStatus;
  const isBusy = isAnalyzing || isSolving || isReviewing;

  const ds = detailedStats;
  const unassessedCount = (ds?.activePrograms ?? 0) - (ds?.assessedPrograms ?? 0);
  const validatedFindingCount = ds?.validatedFindings ?? 0;
  const reportReadyCount = ds?.reportReadyFindings ?? 0;

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "programs", label: `Bounties${programs ? ` (${programs.length})` : ""}` },
    { key: "findings", label: `Findings${findings ? ` (${findings.length})` : ""}` },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight">Security Bounties</h1>
          {securityStatus.active && (
            <div className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 rounded-full"
                style={{
                  background: securityStatus.color,
                  boxShadow: `0 0 8px ${securityStatus.color}`,
                  animation: "pulse 2s infinite",
                }}
              />
              <span className="text-sm font-medium" style={{ color: securityStatus.color }}>
                {securityStatus.label}
                {isReviewing && adversarialProgress ? ` (${adversarialProgress.completed}/${adversarialProgress.total})` : ""}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
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
            {discoverMutation.isPending ? "Discovering..." : "Discover Bounties"}
          </button>
          {isBusy && (
            <button
              onClick={() => killAllMutation.mutate()}
              disabled={killAllMutation.isPending}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
              style={{ background: "#450a0a", color: "#ef4444", border: "1px solid #7f1d1d" }}
            >
              {killAllMutation.isPending ? "Killing..." : "Kill All"}
            </button>
          )}
          <div className="flex gap-2 text-xs" style={{ color: "var(--text-dim)" }}>
            {ds && (
              <>
                <span>{ds.totalPrograms} bounties</span>
                <span>{ds.totalFindings} findings</span>
                {ds.totalRewardedCents > 0 && (
                  <span style={{ color: "var(--green)" }}>
                    ${(ds.totalRewardedCents / 100).toFixed(0)} earned
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tab nav */}
      <div className="mt-4 flex gap-1" style={{ borderBottom: "1px solid var(--border)" }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="relative px-4 py-2.5 text-sm font-medium transition-colors"
            style={{
              color: tab === t.key ? "var(--accent)" : "var(--text-dim)",
            }}
          >
            {t.label}
            {tab === t.key && (
              <div
                className="absolute bottom-0 left-0 right-0 h-0.5"
                style={{ background: "var(--accent)" }}
              />
            )}
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {tab === "overview" && ds && (
        <div className="mt-5">
          {/* Stats row */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Total Earned"
              value={ds.totalRewardedCents > 0 ? `$${(ds.totalRewardedCents / 100).toFixed(0)}` : "$0"}
              sub={`${ds.byStatus["rewarded"] ?? 0} rewarded`}
              color="var(--green)"
            />
            <StatCard
              label="Available Bounties"
              value={ds.activePrograms}
              sub={`${ds.assessedPrograms} assessed, ${unassessedCount} pending`}
              color={unassessedCount > 0 ? "var(--accent)" : undefined}
            />
            <StatCard
              label="Pipeline"
              value={ds.activePipeline}
              sub={`${ds.byStatus["analyzing"] ?? 0} analyzing, ${ds.byStatus["validated"] ?? 0} validated`}
              color={ds.activePipeline > 0 ? "var(--accent)" : undefined}
            />
            <StatCard
              label="Findings"
              value={ds.totalFindings}
              sub={`${ds.discoveredFindings} discovered, ${ds.validatedFindings} validated`}
            />
          </div>

          {/* Pipeline Status — unified card */}
          {(() => {
            const activeProgramId = solverStatus?.programId;
            const activeProgramName = solverStatus?.programName;
            const activeFindingTitle = solverStatus?.findingTitle;

            // Look up the current bounty's actual data
            const currentProgram = activeProgramId && programs
              ? programs.find((p: any) => p.id === activeProgramId)
              : null;
            const currentAssessment = currentProgram
              ? parseAssessment(currentProgram.scopeSummary).assessment
              : null;
            const currentRewardMax = currentProgram?.rewardMaxCents
              ? `$${(currentProgram.rewardMaxCents / 100).toLocaleString()}`
              : null;
            const currentRewardMin = currentProgram?.rewardMinCents && currentProgram.rewardMinCents > 0
              ? `$${(currentProgram.rewardMinCents / 100).toFixed(0)}`
              : null;
            const currentFeasibility = currentAssessment?.opportunityScore;

            // Finding counts by status
            const reportReady = ds.awaitingReview ?? 0;
            const alreadyReviewed = ds.reviewed ?? 0;
            const readyToSubmit = ds.byStatus["reviewing"] ?? 0;
            const submitted = ds.byStatus["submitted"] ?? 0;
            const rewarded = ds.byStatus["rewarded"] ?? 0;

            return (
              <div
                className="mt-4 rounded-xl border p-5"
                style={{
                  background: "var(--bg-card)",
                  borderColor: isSolving ? "var(--accent-dim, var(--accent))" : isReviewing ? "#fbbf24" : isAnalyzing ? "var(--accent)" : "var(--border)",
                  borderWidth: isSolving || isReviewing || isAnalyzing ? 2 : 1,
                }}
              >
                {/* Header with status + force stop */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
                      Pipeline Status
                    </h3>
                    {(isSolving || isReviewing || isAnalyzing) && (
                      <span
                        className="flex items-center gap-1.5 text-xs font-medium"
                        style={{ color: securityStatus.color }}
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{ background: securityStatus.color, animation: "pulse 2s infinite" }}
                        />
                        {securityStatus.label}
                      </span>
                    )}
                  </div>
                  {(isSolving || isReviewing || isAnalyzing) && (
                    <div className="flex items-center gap-3">
                      <div className="text-right text-xs" style={{ color: "var(--text-dim)" }}>
                        {isSolving && solverStatus?.startedAt && (
                          <span>{elapsed(new Date(solverStatus.startedAt).getTime())} / {solverStatus?.timeoutMinutes}m max</span>
                        )}
                        {isSolving && solverStatus?.linesOutput != null && (
                          <p className="font-mono text-[10px]">{solverStatus.linesOutput} lines output</p>
                        )}
                        {isReviewing && adversarialProgress && (
                          <span className="font-mono" style={{ color: "#fbbf24" }}>
                            {adversarialProgress.completed}/{adversarialProgress.total} reviewed
                          </span>
                        )}
                        {isAnalyzing && analyzeStatus && (
                          <span className="font-mono" style={{ color: "var(--accent)" }}>
                            {analyzeStatus.completed}/{analyzeStatus.total} {analyzeStatus.mode === "programs" ? "analyzed" : "assessed"}
                          </span>
                        )}
                      </div>
                      {isSolving && (
                        <button
                          onClick={() => forceStopMutation.mutate()}
                          disabled={forceStopMutation.isPending}
                          className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
                          style={{ background: "#450a0a", color: "#ef4444", border: "1px solid #7f1d1d" }}
                        >
                          {forceStopMutation.isPending ? "Stopping..." : "Force Stop"}
                        </button>
                      )}
                      {isAnalyzing && (
                        <button
                          onClick={() => stopAnalyzeMutation.mutate()}
                          className="rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
                          style={{ background: "#450a0a", color: "#ef4444", border: "1px solid #7f1d1d" }}
                        >
                          Stop
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Active bounty details when solving or reviewing */}
                {(isSolving || isReviewing) && activeProgramName && (
                  <div className="mt-3">
                    <div className="flex items-center gap-2">
                      <p className="text-lg font-semibold">{activeProgramName}</p>
                      {solverStatus?.severity && <SeverityBadge severity={solverStatus.severity} />}
                    </div>
                    {isSolving && activeFindingTitle && (
                      <p className="mt-0.5 text-sm" style={{ color: "var(--accent)" }}>{activeFindingTitle}</p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-4 text-xs">
                      {currentFeasibility != null && (
                        <span>
                          <span style={{ color: "var(--text-dim)" }}>Feasibility </span>
                          <span className="font-mono font-semibold" style={{
                            color: currentFeasibility >= 0.7 ? "var(--green)" : currentFeasibility >= 0.4 ? "var(--yellow, #eab308)" : "var(--text-dim)",
                          }}>
                            {(currentFeasibility * 100).toFixed(0)}%
                          </span>
                        </span>
                      )}
                      {currentRewardMax && (
                        <span>
                          <span style={{ color: "var(--text-dim)" }}>Reward </span>
                          <span className="font-mono font-semibold" style={{ color: "var(--green)" }}>
                            {currentRewardMin ? `${currentRewardMin} – ${currentRewardMax}` : currentRewardMax}
                          </span>
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Unified pipeline progress — always visible */}
                {(() => {
                  const stages = ["analyzing", "hunting", "reviewing", "done"] as const;
                  const solverStage = securityStatus.solverStage ?? "hunting";
                  const currentIdx = isAnalyzing ? 0
                    : isSolving ? stages.indexOf(solverStage as any)
                    : isReviewing ? 4
                    : -1;
                  const stageColor = isReviewing ? "#fbbf24" : isAnalyzing ? "var(--accent)" : "var(--accent)";
                  return (
                    <div className="mt-3 flex gap-1">
                      {stages.map((stage, idx) => (
                        <div key={stage} className="flex-1">
                          <div
                            className="h-1.5 rounded-full"
                            style={{
                              background:
                                currentIdx < 0 ? "var(--border)"
                                  : idx < currentIdx ? "var(--green)"
                                    : idx === currentIdx ? stageColor
                                      : "var(--border)",
                              transition: "background 0.3s",
                            }}
                          />
                          <p
                            className="mt-1 text-center text-[10px] capitalize"
                            style={{
                              color: currentIdx >= 0 && idx <= currentIdx ? "var(--text)" : "var(--text-dim)",
                              fontWeight: idx === currentIdx ? 600 : 400,
                            }}
                          >
                            {stage}
                          </p>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Analysis progress details */}
                {isAnalyzing && analyzeStatus && (
                  <div className="mt-3 rounded-lg p-3" style={{ background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.2)" }}>
                    <div className="flex items-center justify-between text-xs">
                      <span style={{ color: "var(--accent)" }}>
                        {analyzeStatus.mode === "programs" ? "Analyzing" : "Assessing"} {analyzeStatus.completed}/{analyzeStatus.total}
                      </span>
                      {analyzeStatus.currentName && (
                        <span className="max-w-[300px] truncate font-medium" style={{ color: "var(--text)" }}>
                          {analyzeStatus.currentName}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          background: "var(--accent)",
                          width: `${analyzeStatus.total > 0 ? (analyzeStatus.completed / analyzeStatus.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    {analyzeStatus.errors.length > 0 && (
                      <div className="mt-1 text-xs" style={{ color: "var(--red, #ef4444)" }}>
                        <p>{analyzeStatus.errors.length} error{analyzeStatus.errors.length > 1 ? "s" : ""}</p>
                        {analyzeStatus.errors.slice(-3).map((e, i) => (
                          <p key={i} className="mt-0.5 truncate opacity-75">{e.error}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Review progress details */}
                {isReviewing && adversarialProgress && (
                  <div className="mt-3 rounded-lg p-3" style={{ background: "rgba(251, 191, 36, 0.08)", border: "1px solid rgba(251, 191, 36, 0.2)" }}>
                    <div className="flex items-center justify-between text-xs">
                      <span style={{ color: "#fbbf24" }}>
                        Reviewing {adversarialProgress.completed}/{adversarialProgress.total} findings
                      </span>
                      {adversarialProgress.currentFindingTitle && (
                        <span className="max-w-[250px] truncate font-medium" style={{ color: "var(--text)" }}>
                          {adversarialProgress.currentFindingTitle}
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          background: "#fbbf24",
                          width: `${adversarialProgress.total > 0 ? (adversarialProgress.completed / adversarialProgress.total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Live Output */}
                {isSolving && (
                  <div className="mt-4">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-medium" style={{ color: "var(--text-dim)" }}>
                        Live Output
                      </span>
                      <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                        auto-scrolling
                      </span>
                    </div>
                    <SecurityLogViewer
                      programId={solverStatus?.programId}
                      findingId={solverStatus?.findingId}
                    />
                  </div>
                )}

                {/* Idle state */}
                {!isSolving && !isReviewing && !isAnalyzing && (
                  <div className="mt-3 text-xs" style={{ color: "var(--text-dim)" }}>
                    No active pipeline — launch a hunt to get started
                  </div>
                )}
              </div>
            );
          })()}

          {/* Action Cards */}
          {(() => {
            // Compute unassessed and prioritized bounty lists from programs data
            const unassessedBounties = (programs ?? []).filter((p: any) => {
              const { assessment } = parseAssessment(p.scopeSummary);
              return !assessment?.opportunityScore;
            });

            const assessedBounties = (programs ?? [])
              .map((p: any) => {
                const { assessment } = parseAssessment(p.scopeSummary);
                const opportunity = assessment?.opportunityScore ?? 0;
                const rewardMax = (p.rewardMaxCents ?? 0) / 100;
                const efficiency = p.responseEfficiency ?? 0.5;
                const missStreak = p.huntMissStreak ?? 0;
                const score = 100 * opportunity * opportunity * Math.log10(rewardMax + 1) * efficiency / (1 + missStreak);
                return { ...p, _opportunity: opportunity, _score: score };
              })
              .filter((p: any) => {
                if (p._opportunity <= 0) return false;
                // Exclude all previously hunted bounties
                if (p.lastHuntedAt) return false;
                return true;
              })
              .sort((a: any, b: any) => b._score - a._score);

            return (
              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                {/* Card 1: Analyze Bounties */}
                <div
                  className="rounded-xl border p-5"
                  style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
                      Analyze Bounties
                    </h2>
                    <span
                      className="font-mono text-lg font-bold"
                      style={{ color: unassessedCount > 0 ? "var(--accent)" : "var(--text-dim)" }}
                    >
                      {unassessedCount}
                    </span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    {isAnalyzing && analyzeStatus?.mode === "programs" ? (
                      <button
                        onClick={() => stopAnalyzeMutation.mutate()}
                        className="flex-1 rounded-lg py-2 text-sm font-semibold transition-colors"
                        style={{ background: "#1c1917", color: "#ef4444", border: "1px solid #7f1d1d" }}
                      >
                        Stop Analysis
                      </button>
                    ) : (
                      <button
                        onClick={() => analyzeProgramsMutation.mutate()}
                        disabled={unassessedCount === 0 || isBusy}
                        className="flex-1 rounded-lg py-2 text-sm font-semibold transition-colors disabled:opacity-40"
                        style={{ background: "var(--accent)", color: "#fff" }}
                      >
                        {isBusy && !isAnalyzing ? "Busy" : `Analyze ${unassessedCount} Bount${unassessedCount === 1 ? "y" : "ies"}`}
                      </button>
                    )}
                    <button
                      onClick={() => reassessMutation.mutate()}
                      disabled={ds.assessedPrograms === 0 || isBusy || reassessMutation.isPending}
                      className="rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-40"
                      style={{
                        background: "var(--bg-card)",
                        color: "var(--yellow, #eab308)",
                        border: "1px solid var(--border)",
                      }}
                      title="Clear all assessments and re-analyze from scratch"
                    >
                      {reassessMutation.isPending ? "Resetting..." : "Reassess"}
                    </button>
                  </div>

                  {/* Unassessed bounties list */}
                  {unassessedBounties.length > 0 ? (
                    <div className="mt-3 max-h-[260px] overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
                      {unassessedBounties.map((p: any, i: number) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between px-3 py-2 text-xs"
                          style={{ borderBottom: i < unassessedBounties.length - 1 ? "1px solid var(--border)" : "none" }}
                        >
                          <span className="truncate font-medium" style={{ maxWidth: "70%" }}>{p.name}</span>
                          <span className="font-mono" style={{ color: "var(--text-dim)" }}>
                            {p.rewardMaxCents ? `$${(p.rewardMaxCents / 100).toLocaleString()}` : "--"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs" style={{ color: "var(--text-dim)" }}>
                      All bounties assessed
                    </p>
                  )}
                </div>

                {/* Card 2: Auto Hunt */}
                <div
                  className="rounded-xl border p-5"
                  style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
                >
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
                      Auto Hunt
                    </h2>
                    <span
                      className="font-mono text-lg font-bold"
                      style={{ color: ds.assessedPrograms > 0 ? "var(--green)" : "var(--text-dim)" }}
                    >
                      {assessedBounties.length}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-3">
                    <button
                      onClick={() => {
                        if (autoHuntEnabled?.enabled) {
                          setAutoHuntMutation.mutate({ enabled: false });
                        } else {
                          setAutoHuntMutation.mutate({ enabled: true });
                          if (!isBusy && ds.assessedPrograms > 0) {
                            autoHuntMutation.mutate();
                          }
                        }
                      }}
                      disabled={ds.assessedPrograms === 0}
                      className="flex-1 rounded-lg py-2 text-sm font-semibold transition-colors disabled:opacity-40"
                      style={{
                        background: autoHuntEnabled?.enabled ? "#450a0a" : "var(--green)",
                        color: autoHuntEnabled?.enabled ? "#ef4444" : "#000",
                        border: autoHuntEnabled?.enabled ? "1px solid #7f1d1d" : "none",
                      }}
                    >
                      {autoHuntEnabled?.enabled ? "Stop Auto Hunt" : "Start Auto Hunt"}
                    </button>
                  </div>
                  {validatedFindingCount > 0 && (
                    <button
                      onClick={() => autoSolveMutation.mutate()}
                      disabled={isBusy}
                      className="mt-2 w-full rounded-lg py-2 text-xs font-semibold transition-colors disabled:opacity-40"
                      style={{
                        background: "var(--bg-card)",
                        color: "var(--accent)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      Draft Report for Best Finding ({validatedFindingCount} validated)
                    </button>
                  )}
                  {(autoHuntMutation.data && !autoHuntMutation.data.started) && (
                    <p className="mt-2 text-center text-xs" style={{ color: "var(--red, #ef4444)" }}>
                      {autoHuntMutation.data.reason}
                    </p>
                  )}

                  {/* Prioritized bounty queue */}
                  {assessedBounties.length > 0 ? (
                    <div className="mt-3 max-h-[260px] overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border)" }}>
                      {assessedBounties.map((p: any, i: number) => (
                        <div
                          key={p.id}
                          className="flex items-center justify-between px-3 py-2 text-xs"
                          style={{ borderBottom: i < assessedBounties.length - 1 ? "1px solid var(--border)" : "none" }}
                        >
                          <div className="flex items-center gap-2 truncate" style={{ maxWidth: "55%" }}>
                            <span className="font-mono text-[10px]" style={{ color: "var(--text-dim)" }}>
                              {i + 1}
                            </span>
                            <span className="truncate font-medium">{p.name}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono" style={{ color: "var(--text-dim)" }}>
                              {(p._opportunity * 100).toFixed(0)}%
                            </span>
                            <span className="font-mono" style={{ color: "var(--green)" }}>
                              {p.rewardMaxCents ? `$${(p.rewardMaxCents / 100).toLocaleString()}` : "--"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs" style={{ color: "var(--text-dim)" }}>
                      {unassessedCount > 0
                        ? "Analyze bounties first to build the hunt queue"
                        : "No bounties available — discover new ones"}
                    </p>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Recent Hunts */}
          <RecentHunts />

          {/* Avg scores summary */}
          {ds.assessedPrograms > 0 && (
            <div className="mt-4 text-xs" style={{ color: "var(--text-dim)" }}>
              Average feasibility across {ds.assessedPrograms} assessed bounties:{" "}
              <span className="font-mono font-semibold" style={{ color: "var(--accent)" }}>
                {(ds.avgOpportunityScore * 100).toFixed(0)}%
              </span>
              {ds.avgConfidence > 0 && (
                <>
                  {" | "}Average finding confidence:{" "}
                  <span className="font-mono font-semibold">
                    {(ds.avgConfidence * 100).toFixed(0)}%
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Bounties Tab ── */}
      {tab === "programs" && (
        <div className="mt-5">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <SortHeader label="Name" field="name" sortBy={programSort} sortDir={programSortDir} setSortBy={setProgramSort} setSortDir={setProgramSortDir} />
                  <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Provider</th>
                  <SortHeader label="Max Reward" field="rewardMaxCents" sortBy={programSort} sortDir={programSortDir} setSortBy={setProgramSort} setSortDir={setProgramSortDir} />
                  <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Scope</th>
                  <SortHeader label="Confidence" field="opportunity" sortBy={programSort} sortDir={programSortDir} setSortBy={setProgramSort} setSortDir={setProgramSortDir} />
                  <SortHeader label="Score" field="score" sortBy={programSort} sortDir={programSortDir} setSortBy={setProgramSort} setSortDir={setProgramSortDir} />
                  <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Status</th>
                  <th className="pb-3 font-medium" style={{ color: "var(--text-dim)" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {programsLoading && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center" style={{ color: "var(--text-dim)" }}>
                      Loading...
                    </td>
                  </tr>
                )}
                {programs?.map((p: any, idx: number) => {
                  // Insert a separator row before the first hunted program
                  const prevProgram = idx > 0 ? programs[idx - 1] : null;
                  const showHuntedSeparator = p.lastHuntedAt && (!prevProgram || !prevProgram.lastHuntedAt);

                  const { scopes, assessment } = parseAssessment(p.scopeSummary);
                  const scopeCount = scopes.length;
                  const scopePreview = scopes.slice(0, 2).map((s: any) => s.assetIdentifier).join(", ");
                  const rewardMax = p.rewardMaxCents ? `$${(p.rewardMaxCents / 100).toLocaleString()}` : "--";

                  return (
                    <Fragment key={p.id}>
                    {showHuntedSeparator && (
                      <tr>
                        <td colSpan={8} className="py-3 pt-6">
                          <div className="flex items-center gap-3">
                            <div className="h-px flex-1" style={{ background: "var(--border)" }} />
                            <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-dim)" }}>
                              Already Hunted
                            </span>
                            <div className="h-px flex-1" style={{ background: "var(--border)" }} />
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr
                      className="transition-colors"
                      style={{
                        borderBottom: "1px solid var(--border)",
                        opacity: p.lastHuntedAt ? 0.5 : 1,
                      }}
                      onMouseOver={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                      onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          {p.url ? (
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium hover:underline"
                              style={{ color: "var(--accent)" }}
                            >
                              {p.name}
                            </a>
                          ) : (
                            <span className="font-medium">{p.name}</span>
                          )}
                          {p.lastHuntedAt && (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              style={{ background: "#14532d", color: "#4ade80" }}
                              title={`Last hunted: ${timeAgo(p.lastHuntedAt)}`}
                            >
                              Hunted
                            </span>
                          )}
                        </div>
                        {assessment?.attackSurface && (
                          <p className="mt-0.5 max-w-md truncate text-xs" style={{ color: "var(--text-dim)" }}>
                            {assessment.attackSurface}
                          </p>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-xs" style={{ color: "var(--text-dim)" }}>
                        {p.provider === "hackerone" ? "HackerOne" : p.provider === "bugcrowd" ? "Bugcrowd" : p.provider}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="font-mono font-semibold" style={{ color: "var(--green)" }}>
                          {rewardMax}
                        </span>
                        {p.rewardMinCents != null && p.rewardMinCents > 0 && (
                          <span className="ml-1 text-xs" style={{ color: "var(--text-dim)" }}>
                            (min ${(p.rewardMinCents / 100).toFixed(0)})
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4 text-xs" style={{ color: "var(--text-dim)" }}>
                        {scopeCount > 0 ? (
                          <span title={scopePreview}>
                            <span className="font-mono">{scopeCount}</span> assets
                            {assessment?.targetCount != null && assessment.targetCount > 0 && (
                              <span className="ml-1" style={{ color: "var(--accent)" }}>
                                ({assessment.targetCount} targets)
                              </span>
                            )}
                          </span>
                        ) : (
                          "--"
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {assessment?.opportunityScore != null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: "var(--border)" }}>
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${assessment.opportunityScore * 100}%`,
                                  background:
                                    assessment.opportunityScore >= 0.7
                                      ? "var(--green)"
                                      : assessment.opportunityScore >= 0.4
                                        ? "var(--yellow, #eab308)"
                                        : "var(--text-dim)",
                                }}
                              />
                            </div>
                            <span className="font-mono text-xs">
                              {(assessment.opportunityScore * 100).toFixed(0)}%
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--text-dim)" }}>Not assessed</span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {p._score > 0 ? (
                          <span className="font-mono font-semibold" style={{
                            color: p._score >= 150 ? "var(--green)" : p._score >= 50 ? "var(--accent)" : "var(--text-dim)",
                          }}>
                            {Math.round(p._score)}
                          </span>
                        ) : (
                          <span className="text-xs" style={{ color: "var(--text-dim)" }}>--</span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="py-3">
                        {p.status === "active" && (
                          <button
                            onClick={() => huntProgramMutation.mutate(p.id)}
                            disabled={huntProgramMutation.isPending || isBusy}
                            className="rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40"
                            style={{ background: "var(--green)", color: "#000" }}
                          >
                            {isSolving && solverStatus?.programId === p.id ? "Hunting..." : isBusy ? "Busy" : "Hunt"}
                          </button>
                        )}
                      </td>
                    </tr>
                    </Fragment>
                  );
                })}
                {programs?.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-6 text-center" style={{ color: "var(--text-dim)" }}>
                      No bounties found -- click Discover Bounties
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Findings Tab ── */}
      {tab === "findings" && (
        <div className="mt-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-wrap gap-1">
              {findingStatuses.map((s) => (
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
                {displayLabels[s] ?? s.replace(/_/g, " ")}
              </button>
            ))}
            </div>
            <div className="flex items-center gap-2">
              {findings && findings.length > 0 && (
                <button
                  onClick={() => reassessFindingsMutation.mutate()}
                  disabled={reassessFindingsMutation.isPending || isBusy}
                  className="shrink-0 rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40"
                  style={{
                    background: "var(--bg-card)",
                    color: "var(--yellow, #eab308)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {reassessFindingsMutation.isPending ? "Reassessing..." : "Reassess Findings"}
                </button>
              )}
              {findings && findings.length > 0 && (
                <button
                  onClick={() => {
                    if (confirm("Delete all findings? This cannot be undone.")) {
                      deleteAllFindingsMutation.mutate();
                    }
                  }}
                  disabled={deleteAllFindingsMutation.isPending}
                  className="shrink-0 rounded-md px-3 py-1 text-xs font-medium"
                  style={{ background: "#450a0a", color: "#f87171" }}
                >
                  {deleteAllFindingsMutation.isPending ? "Clearing..." : "Clear All Findings"}
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th className="pb-3 pr-6 font-medium" style={{ color: "var(--text-dim)" }}>Finding</th>
                  <th className="pb-3 pr-6 font-medium" style={{ color: "var(--text-dim)" }}>Bounty</th>
                  <SortHeader label="Severity" field="severity" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
                  <SortHeader label="Confidence" field="confidenceScore" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
                  <SortHeader label="Discovered" field="discoveredAt" sortBy={sortBy} sortDir={sortDir} setSortBy={setSortBy} setSortDir={setSortDir} />
                  <th className="pb-3 pl-4 font-medium" style={{ color: "var(--text-dim)" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {findingsLoading && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center" style={{ color: "var(--text-dim)" }}>
                      Loading...
                    </td>
                  </tr>
                )}
                {(() => {
                  const submittedStatuses = new Set(["submitted", "rewarded", "closed", "rejected"]);
                  const sorted = findings ? [...findings].sort((a: any, b: any) => {
                    const aSubmitted = submittedStatuses.has(a.status) ? 1 : 0;
                    const bSubmitted = submittedStatuses.has(b.status) ? 1 : 0;
                    return aSubmitted - bSubmitted;
                  }) : [];
                  return sorted;
                })().map((f: any) => {
                  const notes = parseFindingNotes(f.analysisNotes);
                  const confidence = notes.adversarialReview?.adjustedConfidence ?? f.confidenceScore;
                  return (
                    <Fragment key={f.id}>
                    <tr
                      className="transition-colors"
                      style={{ borderBottom: "1px solid var(--border)" }}
                      onMouseOver={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                      onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-start gap-2">
                          <span className="font-medium">{f.title}</span>
                          {f.reportBody && (
                            <button
                              onClick={() => setExpandedFinding(expandedFinding === f.id ? null : f.id)}
                              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-mono"
                              style={{ background: "var(--bg-card)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
                              title={expandedFinding === f.id ? "Collapse report" : "View full report"}
                            >
                              {expandedFinding === f.id ? "▼" : "▶"} Report
                            </button>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs" style={{ color: "var(--text-dim)" }}>
                          {f.vulnerabilityType && <span>{f.vulnerabilityType}</span>}
                          {f.vulnerabilityType && f.updatedAt && <span>·</span>}
                          <span>{timeAgo(f.updatedAt)}</span>
                        </div>
                        {f.targetAsset && (
                          <p className="mt-0.5 text-xs font-mono" style={{ color: "var(--text-dim)", opacity: 0.7 }}>
                            {f.targetAsset}
                          </p>
                        )}
                        {expandedFinding === f.id && f.reportBody && (
                          <div
                            className="mt-3 rounded-md border p-4 text-xs"
                            style={{
                              borderColor: "var(--border)",
                              background: "var(--bg-card)",
                              maxHeight: "600px",
                              overflow: "auto",
                            }}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-medium text-sm" style={{ color: "var(--text-dim)" }}>
                                Full Report ({f.reportBody.length.toLocaleString()} chars)
                              </span>
                            </div>
                            <pre
                              className="whitespace-pre-wrap font-mono leading-relaxed"
                              style={{ color: "var(--text-secondary, var(--text-dim))" }}
                            >
                              {f.reportBody}
                            </pre>
                          </div>
                        )}
                        {notes.adversarialReview && (
                          <div className="mt-2">
                            <button
                              onClick={() => setExpandedReview(expandedReview === f.id ? null : f.id)}
                              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium uppercase"
                              style={{
                                background: notes.adversarialReview.verdict === "approve" ? "rgba(34,197,94,0.1)" : "rgba(248,113,113,0.1)",
                                color: notes.adversarialReview.verdict === "approve" ? "var(--green)" : "#f87171",
                                border: `1px solid ${notes.adversarialReview.verdict === "approve" ? "var(--green)" : "#f87171"}`,
                              }}
                            >
                              <span>{expandedReview === f.id ? "▼" : "▶"}</span>
                              Review: {notes.adversarialReview.verdict}
                              <span className="font-mono normal-case" style={{ color: "var(--text-dim)" }}>
                                ({(notes.adversarialReview.adjustedConfidence * 100).toFixed(0)}%)
                              </span>
                            </button>
                            {expandedReview === f.id && (
                              <div
                                className="mt-2 rounded-md border p-2 text-xs"
                                style={{
                                  borderColor: notes.adversarialReview.verdict === "approve" ? "var(--green)" : "#f87171",
                                  background: notes.adversarialReview.verdict === "approve" ? "rgba(34,197,94,0.05)" : "rgba(248,113,113,0.05)",
                                }}
                              >
                                <p style={{ color: "var(--text-secondary, var(--text-dim))" }}>
                                  {notes.adversarialReview.reasoning}
                                </p>
                                {notes.adversarialReview.issues.length > 0 && (
                                  <ul className="mt-1 space-y-0.5">
                                    {notes.adversarialReview.issues.map((issue: any, idx: number) => (
                                      <li key={idx} style={{
                                        color: issue.severity === "fatal" ? "#f87171" : issue.severity === "warning" ? "#fbbf24" : "var(--text-dim)",
                                      }}>
                                        <span className="font-mono">[{issue.severity}]</span> {issue.description}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                        {/* Actions below finding details */}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {/* Accept — available on bot-rejected, discovered, validated, failed (not dismissed — user must undo reject first) */}
                          {["bot_rejected", "discovered", "validated", "failed"].includes(f.status) && (
                            <button
                              onClick={() => acceptMutation.mutate(f.id)}
                              disabled={acceptMutation.isPending}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "var(--green)", color: "#000" }}
                            >
                              Accept
                            </button>
                          )}
                          {/* Reject — available on bot-rejected, discovered, validated, failed, report_ready, reviewing */}
                          {["bot_rejected", "discovered", "validated", "failed", "report_ready", "reviewing"].includes(f.status) && (
                            <button
                              onClick={() => rejectMutation.mutate(f.id)}
                              disabled={rejectMutation.isPending}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#450a0a", color: "#f87171" }}
                            >
                              Reject
                            </button>
                          )}
                          {/* Undo Reject — only for user-rejected (dismissed) findings */}
                          {f.status === "dismissed" && (
                            <button
                              onClick={() => undoRejectMutation.mutate(f.id)}
                              disabled={undoRejectMutation.isPending}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#1e1b4b", color: "#818cf8" }}
                            >
                              Undo Reject
                            </button>
                          )}
                          {/* Solve Now — validated findings */}
                          {f.status === "validated" && (
                            <button
                              onClick={() => solveFindingMutation.mutate(f.id)}
                              disabled={solveFindingMutation.isPending || isBusy}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#172554", color: "#60a5fa" }}
                            >
                              {isBusy ? "Busy" : "Solve Now"}
                            </button>
                          )}
                          {/* Submit Report — report_ready or reviewing */}
                          {(f.status === "reviewing" || f.status === "report_ready") && (
                            <>
                              <button
                                onClick={() => { setSubmitError(null); approveReportMutation.mutate(f.id); }}
                                disabled={approveReportMutation.isPending}
                                className="rounded-md px-3 py-1 text-xs font-medium"
                                style={{ background: "var(--green)", color: "#000" }}
                              >
                                {approveReportMutation.isPending ? "Submitting…" : "Submit Report"}
                              </button>
                              {f.reportBody && (
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(f.reportBody!);
                                    setCopiedId(f.id);
                                    setTimeout(() => setCopiedId((prev) => prev === f.id ? null : prev), 2000);
                                  }}
                                  className="rounded-md px-3 py-1 text-xs font-medium"
                                  style={{ background: "#1e1b4b", color: "#818cf8" }}
                                >
                                  {copiedId === f.id ? "Copied!" : "Copy Report"}
                                </button>
                              )}
                              {submitError && (
                                <span className="text-xs" style={{ color: "var(--red, #ef4444)" }}>
                                  {submitError}
                                </span>
                              )}
                            </>
                          )}
                          {/* Reviewing indicator */}
                          {f.status === "report_ready" &&
                            isReviewing && adversarialProgress?.currentFindingId === f.id && (
                              <span className="flex items-center gap-1.5 text-xs" style={{ color: "#fbbf24" }}>
                                <span
                                  className="inline-block h-1.5 w-1.5 rounded-full"
                                  style={{ background: "#fbbf24", animation: "pulse 2s infinite" }}
                                />
                                Reviewing...
                              </span>
                            )}
                          {/* Retry — failed findings */}
                          {f.status === "failed" && (
                            <button
                              onClick={() => retryMutation.mutate(f.id)}
                              disabled={retryMutation.isPending}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#1e1b4b", color: "#818cf8" }}
                            >
                              Retry
                            </button>
                          )}
                          {/* Reset — scanning/analyzing */}
                          {["scanning", "analyzing"].includes(f.status) && (
                            <button
                              onClick={() => resetFindingMutation.mutate(f.id)}
                              disabled={resetFindingMutation.isPending}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#422006", color: "#fbbf24" }}
                            >
                              Reset
                            </button>
                          )}
                          {/* Delete — available on non-terminal statuses */}
                          {!["submitted", "triaged", "accepted", "rewarded"].includes(f.status) && (
                            <button
                              onClick={() => deleteFindingMutation.mutate(f.id)}
                              disabled={deleteFindingMutation.isPending}
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#1c1917", color: "#78716c" }}
                              title="Delete finding permanently"
                            >
                              Delete
                            </button>
                          )}
                          {f.reportUrl && (
                            <a
                              href={f.reportUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-md px-3 py-1 text-xs font-medium"
                              style={{ background: "#172554", color: "#60a5fa" }}
                            >
                              View Report
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-xs align-top" style={{ color: "var(--text-dim)" }}>
                        <div className="flex items-center gap-1.5">
                          {f.programName ?? "--"}
                          {f.programLastHuntedAt && (
                            <span
                              className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase"
                              style={{ background: "#14532d", color: "#4ade80" }}
                              title={`Last hunted: ${timeAgo(f.programLastHuntedAt)}`}
                            >
                              Hunted
                            </span>
                          )}
                        </div>
                        {f.programProvider && (
                          <p className="mt-0.5 text-[10px]" style={{ color: "var(--text-dim)", opacity: 0.7 }}>
                            {f.programProvider === "hackerone" ? "HackerOne" : f.programProvider === "bugcrowd" ? "Bugcrowd" : f.programProvider}
                          </p>
                        )}
                      </td>
                      <td className="py-3 pr-6 align-top">
                        <SeverityBadge severity={f.severity} />
                      </td>
                      <td className="py-3 pr-6 align-top font-mono text-xs">
                        {confidence != null ? (
                          <span style={{
                            color: confidence >= 0.7 ? "var(--green)" : confidence >= 0.4 ? "var(--yellow, #eab308)" : "#f87171",
                          }}>
                            {(confidence * 100).toFixed(0)}%
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-dim)" }}>--</span>
                        )}
                      </td>
                      <td className="py-3 pr-6 align-top text-xs whitespace-nowrap" style={{ color: "var(--text-dim)" }}>
                        {timeAgo(f.discoveredAt)}
                      </td>
                      <td className="py-3 pl-4 align-top">
                        <StatusBadge status={f.status} />
                        {f.retryCount > 0 && (
                          <span className="ml-1 text-xs" style={{ color: "var(--text-dim)" }}>
                            (retry {f.retryCount})
                          </span>
                        )}
                      </td>
                    </tr>
                    {/* Manual Submission Guide — shown when API submission failed */}
                    {(() => {
                      try {
                        const notes = JSON.parse(f.analysisNotes || "{}");
                        if (!notes.manualSubmission) return null;
                        const ms = notes.manualSubmission;
                        const cvss = ms.cvss;
                        return (
                          <tr>
                            <td colSpan={7} className="px-4 pb-4">
                              <div
                                className="rounded-lg p-4"
                                style={{ background: "#1a1625", border: "1px solid #7c3aed44" }}
                              >
                                <div className="flex items-center justify-between mb-3">
                                  <span className="text-sm font-semibold" style={{ color: "#c4b5fd" }}>
                                    Manual Submission Required
                                  </span>
                                  {notes.submissionUrl && (
                                    <a
                                      href={notes.submissionUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="rounded-md px-3 py-1.5 text-xs font-semibold"
                                      style={{ background: "#7c3aed", color: "#fff" }}
                                    >
                                      Open Submission Form →
                                    </a>
                                  )}
                                </div>
                                {notes.submissionError && (
                                  <p className="text-xs mb-3" style={{ color: "#ef4444" }}>
                                    API Error: {notes.submissionError}
                                  </p>
                                )}
                                <div className="space-y-2">
                                  {[
                                    { label: "Title", value: ms.title },
                                    { label: "Severity", value: ms.severity_rating },
                                    { label: "Weakness", value: ms.weakness_name },
                                  ].filter(f => f.value).map(({ label, value }) => (
                                    <div key={label} className="flex items-center gap-2">
                                      <span className="text-xs font-medium w-20 shrink-0" style={{ color: "#a78bfa" }}>{label}</span>
                                      <span className="text-xs flex-1 font-mono" style={{ color: "var(--text)" }}>{value}</span>
                                      <button
                                        onClick={() => { navigator.clipboard.writeText(value); setCopiedId(`${f.id}-${label}`); setTimeout(() => setCopiedId(p => p === `${f.id}-${label}` ? null : p), 1500); }}
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{ background: "#2d2640", color: "#a78bfa" }}
                                      >
                                        {copiedId === `${f.id}-${label}` ? "✓" : "Copy"}
                                      </button>
                                    </div>
                                  ))}
                                  {cvss && (
                                    <div className="mt-2">
                                      <span className="text-xs font-medium" style={{ color: "#a78bfa" }}>CVSS v3.1</span>
                                      <div className="grid grid-cols-4 gap-1 mt-1">
                                        {[
                                          ["Attack Vector", cvss.attack_vector],
                                          ["Attack Complexity", cvss.attack_complexity],
                                          ["Privileges", cvss.privileges_required],
                                          ["User Interaction", cvss.user_interaction],
                                          ["Scope", cvss.scope],
                                          ["Confidentiality", cvss.confidentiality],
                                          ["Integrity", cvss.integrity],
                                          ["Availability", cvss.availability],
                                        ].map(([label, value]) => (
                                          <div key={label} className="flex items-center gap-1 text-[10px]">
                                            <span style={{ color: "var(--text-dim)" }}>{label}:</span>
                                            <span className="font-semibold capitalize" style={{ color: "var(--text)" }}>{value}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {[
                                    { label: "Vulnerability Info", value: ms.vulnerability_information },
                                    { label: "Impact", value: ms.impact },
                                  ].filter(f => f.value).map(({ label, value }) => (
                                    <div key={label}>
                                      <div className="flex items-center justify-between">
                                        <span className="text-xs font-medium" style={{ color: "#a78bfa" }}>{label}</span>
                                        <button
                                          onClick={() => { navigator.clipboard.writeText(value); setCopiedId(`${f.id}-${label}`); setTimeout(() => setCopiedId(p => p === `${f.id}-${label}` ? null : p), 1500); }}
                                          className="text-[10px] px-1.5 py-0.5 rounded"
                                          style={{ background: "#2d2640", color: "#a78bfa" }}
                                        >
                                          {copiedId === `${f.id}-${label}` ? "✓" : "Copy"}
                                        </button>
                                      </div>
                                      <pre className="mt-1 text-[10px] p-2 rounded overflow-x-auto max-h-40 overflow-y-auto" style={{ background: "#0f0a1a", color: "var(--text-dim)", whiteSpace: "pre-wrap" }}>
                                        {value.length > 500 ? value.substring(0, 500) + "..." : value}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        );
                      } catch { return null; }
                    })()}
                    </Fragment>
                  );
                })}
                {findings?.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-8 text-center" style={{ color: "var(--text-dim)" }}>
                      No findings found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
