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
  "signal blocked": ["report_ready", "reviewing"],
  "submitted": ["submitted", "triaged", "accepted"],
  "rewarded": ["rewarded"],
  "bot rejected": ["bot_rejected"],
  "closed": ["duplicate", "not_applicable", "informative", "failed", "dismissed"],
};

/** Check if a finding has a signal/submission error in its analysisNotes */
function hasSubmissionError(analysisNotes: string | null | undefined): boolean {
  if (!analysisNotes) return false;
  try {
    const notes = JSON.parse(analysisNotes);
    return !!notes.submissionError;
  } catch {
    return false;
  }
}
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

function parseReportSections(reportBody: string | null | undefined): {
  title: string;
  severity: string;
  vulnType: string;
  targetAsset: string;
  vulnerabilityInfo: string;
  impact: string;
} {
  if (!reportBody) return { title: "", severity: "", vulnType: "", targetAsset: "", vulnerabilityInfo: "", impact: "" };

  const grab = (pattern: RegExp) => reportBody.match(pattern)?.[1]?.trim() ?? "";

  const title = grab(/^\*\*Title:\*\*\s*(.+)/m);
  const severity = grab(/^\*\*Severity:\*\*\s*(.+)/m);
  const vulnType = grab(/^\*\*Vulnerability Type:\*\*\s*(.+)/m);
  const targetAsset = grab(/^\*\*Target Asset:\*\*\s*(.+)/m);

  const vulnMatch = reportBody.match(/\*\*Vulnerability Information:\*\*\s*([\s\S]*?)(?=\*\*Impact:\*\*|$)/);
  const vulnerabilityInfo = vulnMatch?.[1]?.trim() ?? "";

  const impactMatch = reportBody.match(/\*\*Impact:\*\*\s*([\s\S]*?)(?=={3}FINDING_END={3}|$)/);
  const impact = impactMatch?.[1]?.trim() ?? "";

  return { title, severity, vulnType, targetAsset, vulnerabilityInfo, impact };
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

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"] as const;
const EFFORT_OPTIONS = ["low", "medium", "high"] as const;

function ModelConfigPanel() {
  const { data: config } = trpc.config.useQuery(undefined, { refetchInterval: 5000 });
  const utils = trpc.useUtils();
  const setConfig = trpc.setConfig.useMutation({
    onSuccess: () => utils.config.invalidate(),
  });
  const [timeoutDraft, setTimeoutDraft] = useState<string>("");
  const [timeoutFocused, setTimeoutFocused] = useState(false);

  if (!config) return null;

  const timeout = config.SECURITY_HUNT_TIMEOUT_MINUTES ?? 60;

  const agents: { label: string; sub: string; modelKey: string; effortKey: string; model: string; effort: string }[] = [
    { label: "Scout", sub: "assessment", modelKey: "ANALYSIS_MODEL", effortKey: "ANALYSIS_EFFORT", model: config.ANALYSIS_MODEL ?? "sonnet", effort: config.ANALYSIS_EFFORT ?? "high" },
    { label: "Hunt", sub: "discovery", modelKey: "CLAUDE_MODEL", effortKey: "HUNT_EFFORT", model: config.CLAUDE_MODEL ?? "opus", effort: config.HUNT_EFFORT ?? "high" },
    { label: "Review", sub: "verification", modelKey: "REVIEW_MODEL", effortKey: "REVIEW_EFFORT", model: config.REVIEW_MODEL || config.CLAUDE_MODEL || "opus", effort: config.REVIEW_EFFORT ?? "high" },
    { label: "Submit", sub: "drafting", modelKey: "SUBMISSION_MODEL", effortKey: "SUBMISSION_EFFORT", model: config.SUBMISSION_MODEL || config.CLAUDE_MODEL || "opus", effort: config.SUBMISSION_EFFORT ?? "high" },
  ];

  return (
    <div
      className="rounded-xl border p-5"
      style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
          Model & Budget
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-medium" style={{ color: "var(--text-dim)" }}>Timeout</span>
          <input
            type="text"
            inputMode="numeric"
            className="w-12 rounded-md px-2 py-1 text-center font-mono text-xs font-bold"
            style={{
              background: "var(--bg-hover, rgba(255,255,255,0.05))",
              color: "var(--accent)",
              border: "1px solid var(--border)",
              outline: "none",
            }}
            value={timeoutFocused ? timeoutDraft : `${timeout}`}
            onFocus={() => { setTimeoutDraft(String(timeout)); setTimeoutFocused(true); }}
            onBlur={() => {
              setTimeoutFocused(false);
              const n = parseInt(timeoutDraft, 10);
              if (!isNaN(n) && n >= 5 && n <= 240 && n !== timeout) {
                setConfig.mutate({ key: "SECURITY_HUNT_TIMEOUT_MINUTES", value: n });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onChange={(e) => setTimeoutDraft(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>min</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-4 gap-3">
        {agents.map((a) => (
          <div key={a.modelKey}>
            <div className="mb-2">
              <span className="text-xs font-semibold">{a.label}</span>
              <span className="ml-1.5 text-[10px]" style={{ color: "var(--text-dim)" }}>{a.sub}</span>
            </div>
            <div className="flex flex-col gap-1">
              {MODEL_OPTIONS.map((m) => (
                <button
                  key={m}
                  onClick={() => setConfig.mutate({ key: a.modelKey, value: m })}
                  className="rounded-md px-2 py-1.5 text-xs font-medium transition-all"
                  style={{
                    background: a.model === m ? "var(--accent)" : "var(--bg-hover, rgba(255,255,255,0.05))",
                    color: a.model === m ? "#fff" : "var(--text-dim)",
                    border: `1px solid ${a.model === m ? "var(--accent)" : "var(--border)"}`,
                  }}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
            {a.effortKey && (
              <div className="mt-2">
                <span className="text-[10px] font-medium" style={{ color: "var(--text-dim)" }}>Effort</span>
                <div className="mt-1 flex gap-1">
                  {EFFORT_OPTIONS.map((e) => (
                    <button
                      key={e}
                      onClick={() => setConfig.mutate({ key: a.effortKey, value: e })}
                      className="flex-1 rounded-md py-1 text-[10px] font-medium transition-all"
                      style={{
                        background: a.effort === e ? "rgba(99,102,241,0.2)" : "transparent",
                        color: a.effort === e ? "var(--accent)" : "var(--text-dim)",
                        border: `1px solid ${a.effort === e ? "var(--accent)" : "var(--border)"}`,
                      }}
                    >
                      {e.charAt(0).toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type Tab = "overview" | "programs" | "findings";

export default function SecurityPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState("all");
  const [hideSignalFindings, setHideSignalFindings] = useState(true);
  const [sortBy, setSortBy] = useState<string>("discoveredAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [programSort, setProgramSort] = useState<string>("score");
  const [programSortDir, setProgramSortDir] = useState<"asc" | "desc">("desc");
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);
  const [expandedManualSubmit, setExpandedManualSubmit] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<Set<string>>(new Set());

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
      limit: 1000,
    },
    { refetchInterval: 5000 },
  );

  // Compute opportunity score and combined score for each program, then sort client-side
  // Uses the same composite formula as rankEligiblePrograms() in security-solver
  const programs = (() => {
    if (!rawPrograms) return rawPrograms;
    const now = Date.now();
    const enriched = rawPrograms.map((p: any) => {
      const { assessment, scopes } = parseAssessment(p.scopeSummary);
      const opportunity = assessment?.opportunityScore ?? 0;
      const rewardDollars = (p.rewardMaxCents ?? 0) / 100;
      const efficiency = p.responseEfficiency ?? 0.5;
      const missStreak = p.huntMissStreak ?? 0;

      // Source code boost
      const hasSourceCode = (scopes ?? []).some(
        (s: any) =>
          s.assetType === "SOURCE_CODE" ||
          (s.assetIdentifier?.includes("github.com")) ||
          (s.assetIdentifier?.includes("gitlab.com")),
      );
      const sourceCodeBoost = hasSourceCode ? 1.5 : 1.0;

      // Freshness multiplier
      let freshnessMult = 1.0;
      if (p.launchedAt) {
        const launchedMs = typeof p.launchedAt === "string" ? new Date(p.launchedAt).getTime() : p.launchedAt.getTime?.() ?? p.launchedAt;
        const ageMonths = (now - launchedMs) / (30.44 * 24 * 60 * 60 * 1000);
        if (ageMonths < 6) freshnessMult = 2.0;
        else if (ageMonths < 12) freshnessMult = 1.5;
        else if (ageMonths < 24) freshnessMult = 1.0;
        else if (ageMonths < 48) freshnessMult = 0.7;
        else freshnessMult = 0.5;
      }

      // Saturation multiplier
      let saturationMult = 1.0;
      const reportCount = p.disclosedReportCount;
      if (reportCount != null) {
        if (reportCount <= 5) saturationMult = 2.0;
        else if (reportCount <= 20) saturationMult = 1.5;
        else if (reportCount <= 50) saturationMult = 1.0;
        else if (reportCount <= 100) saturationMult = 0.7;
        else saturationMult = 0.4;
      }

      const score = 100
        * opportunity * opportunity
        * Math.log10(rewardDollars + 1)
        * efficiency
        * sourceCodeBoost
        * freshnessMult
        * saturationMult
        / (1 + missStreak);

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

  const { data: rawFindings, isLoading: findingsLoading, refetch } = trpc.securityFindings.useQuery(
    {
      ...(filter !== "all" && findingStatusGroups[filter]?.length ? { statuses: findingStatusGroups[filter] } : {}),
      sortBy: sortBy as any,
      sortDir,
    },
    { refetchInterval: 5000 },
  );

  // Client-side filtering: "ready" excludes signal-blocked, "signal blocked" only includes them
  const findings = (() => {
    if (!rawFindings) return rawFindings;
    let filtered = rawFindings;
    if (filter === "ready") filtered = filtered.filter((f: any) => !hasSubmissionError(f.analysisNotes));
    if (filter === "signal blocked") filtered = filtered.filter((f: any) => hasSubmissionError(f.analysisNotes));
    if (hideSignalFindings) filtered = filtered.filter((f: any) => !f.programRequiresSignal);
    return filtered;
  })();
  const signalBlockedCount = rawFindings?.filter((f: any) => f.programRequiresSignal).length ?? 0;

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
  const [analyzeSkipSignal, setAnalyzeSkipSignal] = useState(true);
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
  const [submittingId, setSubmittingId] = useState<string | null>(null);
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
  const { data: huntQueue } = trpc.securityHuntQueue.useQuery(undefined, { refetchInterval: 10000 });
  const { data: autoHuntEnabled } = trpc.securityAutoHuntEnabled.useQuery(undefined, { refetchInterval: 5000 });
  const setAutoHuntMutation = trpc.securitySetAutoHunt.useMutation({
    onSuccess: () => {
      utils.securityAutoHuntEnabled.invalidate();
    },
  });
  const { data: skipSignalRequired } = trpc.securitySkipSignalRequired.useQuery(undefined, { refetchInterval: 5000 });
  const setSkipSignalMutation = trpc.securitySetSkipSignal.useMutation({
    onSuccess: () => {
      utils.securitySkipSignalRequired.invalidate();
      utils.securityHuntQueue.invalidate();
    },
  });
  const { data: skipWebOnly } = trpc.securitySkipWebOnly.useQuery(undefined, { refetchInterval: 5000 });
  const setSkipWebOnlyMutation = trpc.securitySetSkipWebOnly.useMutation({
    onSuccess: () => {
      utils.securitySkipWebOnly.invalidate();
      utils.securityHuntQueue.invalidate();
    },
  });
  const { data: skipPreviouslyHunted } = trpc.securitySkipPreviouslyHunted.useQuery(undefined, { refetchInterval: 5000 });
  const setSkipPreviouslyHuntedMutation = trpc.securitySetSkipPreviouslyHunted.useMutation({
    onSuccess: () => {
      utils.securitySkipPreviouslyHunted.invalidate();
      utils.securityHuntQueue.invalidate();
    },
  });
  const backfillSignalMutation = trpc.securityBackfillSignal.useMutation({
    onSuccess: () => {
      utils.securityPrograms.invalidate();
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
          {/* Stats + Model Config — single row */}
          <div className="grid items-stretch gap-3" style={{ gridTemplateColumns: "200px 1fr" }}>
            <div className="flex flex-col gap-3">
              <div className="flex-1 rounded-xl border p-5" style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}>
                <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>Total Earned</p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight" style={{ color: "var(--green)" }}>
                  {ds.totalRewardedCents > 0 ? `$${(ds.totalRewardedCents / 100).toFixed(0)}` : "$0"}
                </p>
                <p className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>{ds.byStatus["rewarded"] ?? 0} rewarded</p>
              </div>
              <div className="flex-1 rounded-xl border p-5" style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}>
                <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>Available Bounties</p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight" style={unassessedCount > 0 ? { color: "var(--accent)" } : undefined}>
                  {ds.activePrograms}
                </p>
                <p className="mt-0.5 text-xs" style={{ color: "var(--text-dim)" }}>{ds.assessedPrograms} assessed, {unassessedCount} pending</p>
              </div>
            </div>
            <ModelConfigPanel />
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
              if (analyzeSkipSignal && p.requiresSignal) return false;
              const { assessment } = parseAssessment(p.scopeSummary);
              return !assessment?.opportunityScore;
            });

            // Use server-provided hunt queue (same scoring + filters as pickBestProgram)
            const assessedBounties = (huntQueue ?? []);

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
                      style={{ color: unassessedBounties.length > 0 ? "var(--accent)" : "var(--text-dim)" }}
                    >
                      {unassessedBounties.length}
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
                        onClick={() => analyzeProgramsMutation.mutate({ skipSignalRequired: analyzeSkipSignal })}
                        disabled={unassessedBounties.length === 0 || isBusy}
                        className="flex-1 rounded-lg py-2 text-sm font-semibold transition-colors disabled:opacity-40"
                        style={{ background: "var(--accent)", color: "#fff" }}
                      >
                        {isBusy && !isAnalyzing ? "Busy" : `Analyze ${unassessedBounties.length} Bount${unassessedBounties.length === 1 ? "y" : "ies"}`}
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
                  <label className="mt-2 flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-dim)" }}>
                    <input
                      type="checkbox"
                      checked={analyzeSkipSignal}
                      onChange={(e) => setAnalyzeSkipSignal(e.target.checked)}
                      className="rounded"
                    />
                    Skip Signal-required programs
                  </label>

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
                  <p className="mt-2 text-[10px]" style={{ color: "var(--text-dim)" }}>
                    Filters configured on Bounties tab
                  </p>
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

                  {/* Prioritized bounty queue — from server, same order as pickBestProgram */}
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
                              {p.rank}
                            </span>
                            <span className="truncate font-medium">{p.name}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="font-mono" style={{ color: "var(--text-dim)" }}>
                              {p.score.toFixed(0)}
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
          {/* Filter controls */}
          <div className="mb-4 rounded-xl border p-4" style={{ background: "var(--bg-card)", borderColor: "var(--border)" }}>
            <div className="flex flex-wrap items-center gap-4">
              {/* Platform filter */}
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>Platform</span>
                {(() => {
                  const providerSet = new Set<string>();
                  for (const p of (programs ?? []) as any[]) providerSet.add(String(p.provider));
                  const providers = Array.from(providerSet).sort();
                  const providerLabels: Record<string, string> = {
                    hackerone: "HackerOne",
                    immunefi: "Immunefi",
                    huntr: "Huntr",
                    bugcrowd: "Bugcrowd",
                    intigriti: "Intigriti",
                    yeswehack: "YesWeHack",
                    federacy: "Federacy",
                  };
                  return providers.map((prov) => {
                    const active = platformFilter.size === 0 || platformFilter.has(prov);
                    const count = (programs ?? []).filter((p: any) => p.provider === prov).length;
                    return (
                      <button
                        key={prov}
                        onClick={() => {
                          setPlatformFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(prov)) {
                              next.delete(prov);
                            } else {
                              next.add(prov);
                            }
                            return next;
                          });
                        }}
                        className="rounded-md px-2.5 py-1 text-xs font-medium transition-all"
                        style={{
                          background: active ? "var(--accent)" : "var(--bg-hover, rgba(255,255,255,0.05))",
                          color: active ? "#fff" : "var(--text-dim)",
                          border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                          opacity: active ? 1 : 0.6,
                        }}
                      >
                        {providerLabels[prov] ?? prov} <span className="font-mono text-[10px]">({count})</span>
                      </button>
                    );
                  });
                })()}
                {platformFilter.size > 0 && (
                  <button
                    onClick={() => setPlatformFilter(new Set())}
                    className="rounded-md px-2 py-1 text-[10px] font-medium"
                    style={{ color: "var(--text-dim)" }}
                  >
                    Clear
                  </button>
                )}
              </div>

              <div className="h-4 w-px" style={{ background: "var(--border)" }} />

              {/* Existing toggles */}
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-dim)" }}>
                <input
                  type="checkbox"
                  checked={skipSignalRequired ?? true}
                  onChange={(e) => setSkipSignalMutation.mutate({ enabled: e.target.checked })}
                  className="rounded"
                />
                Hide Signal-required
                {(() => {
                  const count = programs?.filter((p: any) => p.requiresSignal).length ?? 0;
                  return count > 0 ? <span className="font-mono" style={{ color: "var(--accent)" }}>({count})</span> : null;
                })()}
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-dim)" }}>
                <input
                  type="checkbox"
                  checked={skipWebOnly ?? true}
                  onChange={(e) => setSkipWebOnlyMutation.mutate({ enabled: e.target.checked })}
                  className="rounded"
                />
                Hide web-only
                {(() => {
                  const count = programs?.filter((p: any) => {
                    const { scopes } = parseAssessment(p.scopeSummary);
                    return !scopes.some((s: any) => s.assetType === "SOURCE_CODE" || s.assetIdentifier?.includes("github.com") || s.assetIdentifier?.includes("gitlab.com"));
                  }).length ?? 0;
                  return count > 0 ? <span className="font-mono" style={{ color: "var(--accent)" }}>({count})</span> : null;
                })()}
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-dim)" }}>
                <input
                  type="checkbox"
                  checked={skipPreviouslyHunted ?? true}
                  onChange={(e) => setSkipPreviouslyHuntedMutation.mutate({ enabled: e.target.checked })}
                  className="rounded"
                />
                Hide previously hunted
              </label>
              <button
                onClick={() => backfillSignalMutation.mutate()}
                disabled={backfillSignalMutation.isPending}
                className="rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-40"
                style={{ background: "var(--bg-hover)", color: "var(--text-dim)", border: "1px solid var(--border)" }}
              >
                {backfillSignalMutation.isPending ? "Checking..." : "Detect Signal"}
              </button>
            </div>
          </div>
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
                {(() => {
                  let filteredPrograms = programs;
                  // Platform filter
                  if (platformFilter.size > 0) {
                    filteredPrograms = filteredPrograms?.filter((p: any) => platformFilter.has(p.provider));
                  }
                  // Signal filter
                  if (skipSignalRequired ?? true) {
                    filteredPrograms = filteredPrograms?.filter((p: any) => !p.requiresSignal);
                  }
                  // Web-only filter
                  if (skipWebOnly ?? true) {
                    filteredPrograms = filteredPrograms?.filter((p: any) => {
                      const { scopes } = parseAssessment(p.scopeSummary);
                      return scopes.some((s: any) => s.assetType === "SOURCE_CODE" || s.assetIdentifier?.includes("github.com") || s.assetIdentifier?.includes("gitlab.com"));
                    });
                  }
                  // Previously hunted filter
                  if (skipPreviouslyHunted ?? true) {
                    filteredPrograms = filteredPrograms?.filter((p: any) => !p.lastHuntedAt);
                  }
                  return filteredPrograms?.map((p: any, idx: number) => {
                  // Insert a separator row before the first hunted program
                  const prevProgram = idx > 0 ? filteredPrograms?.[idx - 1] : null;
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
                        opacity: p.lastHuntedAt ? 0.5 : p.requiresSignal ? 0.6 : 1,
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
                          {p.lastHuntedAt && (p.huntCount ?? 0) > 0 && (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              style={{ background: "#14532d", color: "#4ade80" }}
                              title={`Last hunted: ${timeAgo(p.lastHuntedAt)}`}
                            >
                              Hunted
                            </span>
                          )}
                          {p.lastHuntedAt && (p.huntCount ?? 0) === 0 && (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              style={{ background: "#7f1d1d", color: "#f87171" }}
                              title={`Hunt failed: ${timeAgo(p.lastHuntedAt)}`}
                            >
                              Failed
                            </span>
                          )}
                          {p.requiresSignal && (
                            <span
                              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
                              style={{ background: "#422006", color: "#fb923c" }}
                              title="This program requires a HackerOne Signal score to submit reports"
                            >
                              Signal Required
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
                });
                })()}
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
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-dim)" }}>
                <input
                  type="checkbox"
                  checked={hideSignalFindings}
                  onChange={(e) => setHideSignalFindings(e.target.checked)}
                />
                Hide signal-required{signalBlockedCount > 0 ? ` (${signalBlockedCount})` : ""}
              </label>
              {findings && findings.length > 0 && (
                <button
                  onClick={() => reassessFindingsMutation.mutate({ excludeSignalBlocked: filter === "ready" || filter === "all" })}
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
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => setExpandedReview(expandedReview === f.id ? null : f.id)}
                                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
                                style={{
                                  background: notes.adversarialReview.verdict === "approve" ? "rgba(34,197,94,0.1)" : "rgba(248,113,113,0.1)",
                                  color: notes.adversarialReview.verdict === "approve" ? "var(--green)" : "#f87171",
                                  border: `1px solid ${notes.adversarialReview.verdict === "approve" ? "var(--green)" : "#f87171"}`,
                                }}
                              >
                                <span>{expandedReview === f.id ? "▼" : "▶"}</span>
                                View Analysis
                                <span className="font-mono" style={{ color: "var(--text-dim)" }}>
                                  ({(notes.adversarialReview.adjustedConfidence * 100).toFixed(0)}%)
                                </span>
                              </button>
                              {f.reportBody && (
                                <button
                                  onClick={() => setExpandedFinding(expandedFinding === f.id ? null : f.id)}
                                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium"
                                  style={{
                                    background: "rgba(99, 102, 241, 0.1)",
                                    color: "#818cf8",
                                    border: "1px solid rgba(99, 102, 241, 0.4)",
                                  }}
                                >
                                  <span>{expandedFinding === f.id ? "▼" : "▶"}</span>
                                  View Report
                                </button>
                              )}
                            </div>
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
                                onClick={() => { setSubmitError(null); setSubmittingId(f.id); approveReportMutation.mutate(f.id); }}
                                disabled={approveReportMutation.isPending}
                                className="rounded-md px-3 py-1 text-xs font-medium"
                                style={{ background: "var(--green)", color: "#000" }}
                              >
                                {approveReportMutation.isPending && submittingId === f.id ? "Submitting…" : "Submit Report"}
                              </button>
                              {f.reportBody && (
                                <button
                                  onClick={() => setExpandedManualSubmit(expandedManualSubmit === f.id ? null : f.id)}
                                  className="rounded-md px-3 py-1 text-xs font-medium"
                                  style={{ background: "#1e1b4b", color: "#818cf8" }}
                                >
                                  {expandedManualSubmit === f.id ? "Hide Copy Panel" : "Copy Report"}
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
                    {/* Manual Submission Panel — toggled via Copy Report button */}
                    {(() => {
                      if (!f.reportBody) return null;
                      if (expandedManualSubmit !== f.id) return null;

                      const sections = parseReportSections(f.reportBody);
                      if (!sections.vulnerabilityInfo) return null;

                      const notes = (() => { try { return JSON.parse(f.analysisNotes || "{}"); } catch { return {}; } })();
                      const ms = notes.manualSubmission;
                      const provider = (f as any).programProvider ?? "hackerone";
                      const programHandle = (f as any).programHandle ?? f.programId?.replace(/^h1-|^immunefi-|^huntr-|^bugcrowd-|^intigriti-|^yeswehack-|^federacy-/, "") ?? "";
                      const programUrl = (f as any).programUrl ?? "";

                      // Build submission URL based on provider
                      const submissionUrls: Record<string, { url: string; label: string }> = {
                        hackerone: { url: `https://hackerone.com/${programHandle}/reports/new`, label: "Open HackerOne Form" },
                        immunefi: { url: programUrl || `https://immunefi.com/bug-bounty/${programHandle}/`, label: "Open Immunefi Program" },
                        huntr: { url: "https://huntr.com/bounties/disclose", label: "Open Huntr Submission" },
                        bugcrowd: { url: programUrl || `https://bugcrowd.com/${programHandle}`, label: "Open Bugcrowd Program" },
                        intigriti: { url: programUrl || `https://app.intigriti.com/programs/${programHandle}`, label: "Open Intigriti Program" },
                        yeswehack: { url: programUrl || `https://yeswehack.com/programs/${programHandle}`, label: "Open YesWeHack Program" },
                        federacy: { url: programUrl || `https://federacy.com/programs/${programHandle}`, label: "Open Federacy Program" },
                      };
                      const sub = submissionUrls[provider] ?? { url: programUrl || "#", label: `Open ${provider} Program` };

                      const copyField = (id: string, value: string) => {
                        navigator.clipboard.writeText(value);
                        setCopiedId(id);
                        setTimeout(() => setCopiedId((prev) => prev === id ? null : prev), 2000);
                      };

                      // Build full report text for one-click copy
                      const fullReport = [
                        sections.title || f.title ? `# ${sections.title || f.title}` : "",
                        sections.severity ? `**Severity:** ${sections.severity}` : "",
                        sections.vulnType ? `**Vulnerability Type:** ${sections.vulnType}` : "",
                        sections.targetAsset ? `**Target Asset:** ${sections.targetAsset}` : "",
                        "",
                        sections.vulnerabilityInfo ? `**Vulnerability Information:**\n${sections.vulnerabilityInfo}` : "",
                        "",
                        sections.impact ? `**Impact:**\n${sections.impact}` : "",
                      ].filter(Boolean).join("\n");

                      return (
                        <tr>
                          <td colSpan={7} className="px-4 pb-4">
                            <div
                              className="rounded-lg p-4"
                              style={{ background: "#1a1625", border: "1px solid #7c3aed44" }}
                            >
                              <div className="flex items-center justify-between mb-4">
                                <span className="text-sm font-semibold" style={{ color: "#c4b5fd" }}>
                                  Manual Submission
                                  {provider !== "hackerone" && (
                                    <span className="ml-2 text-[10px] font-normal px-1.5 py-0.5 rounded" style={{ background: "#2d2640", color: "#a78bfa" }}>
                                      {provider}
                                    </span>
                                  )}
                                </span>
                                <div className="flex gap-2">
                                  <button
                                    onClick={() => copyField(`${f.id}-fullreport`, fullReport)}
                                    className="rounded-md px-3 py-1.5 text-xs font-semibold"
                                    style={{ background: "#2d2640", color: "#c4b5fd" }}
                                  >
                                    {copiedId === `${f.id}-fullreport` ? "Copied!" : "Copy Full Report"}
                                  </button>
                                  <a
                                    href={sub.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="rounded-md px-3 py-1.5 text-xs font-semibold"
                                    style={{ background: "#7c3aed", color: "#fff" }}
                                  >
                                    {sub.label} ↗
                                  </a>
                                </div>
                              </div>
                              {notes.submissionError && (
                                <p className="text-xs mb-3" style={{ color: "#ef4444" }}>
                                  API Error: {notes.submissionError}
                                </p>
                              )}

                              <div className="space-y-3">
                                {/* Title */}
                                <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>
                                      Report Title
                                    </span>
                                    <button
                                      onClick={() => copyField(`${f.id}-title`, sections.title || f.title)}
                                      className="text-[10px] px-2 py-0.5 rounded font-medium"
                                      style={{ background: "#2d2640", color: "#a78bfa" }}
                                    >
                                      {copiedId === `${f.id}-title` ? "Copied" : "Copy"}
                                    </button>
                                  </div>
                                  <p className="text-xs font-medium" style={{ color: "var(--text)" }}>
                                    {sections.title || f.title}
                                  </p>
                                </div>

                                {/* Dropdowns row: Severity, Weakness, Asset */}
                                <div className="grid grid-cols-3 gap-2">
                                  <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>
                                      Severity
                                    </span>
                                    <p className="mt-1 text-xs font-medium capitalize" style={{ color: "var(--text)" }}>
                                      {sections.severity || f.severity || "medium"}
                                    </p>
                                  </div>
                                  <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>
                                      Weakness (CWE)
                                    </span>
                                    <p className="mt-1 text-xs font-medium" style={{ color: "var(--text)" }}>
                                      {sections.vulnType || f.vulnerabilityType || "--"}
                                    </p>
                                  </div>
                                  <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>
                                      Asset
                                    </span>
                                    <p className="mt-1 text-xs font-medium truncate" style={{ color: "var(--text)" }} title={sections.targetAsset || f.targetAsset || ""}>
                                      {sections.targetAsset || f.targetAsset || "--"}
                                    </p>
                                  </div>
                                </div>

                                {/* Vulnerability Information */}
                                <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>
                                      Vulnerability Information
                                      <span className="ml-2 normal-case font-normal" style={{ color: "var(--text-dim)" }}>
                                        ({sections.vulnerabilityInfo.length.toLocaleString()} chars)
                                      </span>
                                    </span>
                                    <button
                                      onClick={() => copyField(`${f.id}-vulninfo`, sections.vulnerabilityInfo)}
                                      className="text-[10px] px-2 py-0.5 rounded font-medium"
                                      style={{ background: "#7c3aed", color: "#fff" }}
                                    >
                                      {copiedId === `${f.id}-vulninfo` ? "Copied" : "Copy"}
                                    </button>
                                  </div>
                                  <div
                                    className="text-[11px] max-h-60 overflow-y-auto overflow-x-auto rounded p-2"
                                    style={{ background: "#0a0612", color: "var(--text-dim)" }}
                                  >
                                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace", lineHeight: 1.5 }}>{sections.vulnerabilityInfo}</pre>
                                  </div>
                                </div>

                                {/* Impact */}
                                <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>
                                      Impact
                                      <span className="ml-2 normal-case font-normal" style={{ color: "var(--text-dim)" }}>
                                        ({sections.impact.length.toLocaleString()} chars)
                                      </span>
                                    </span>
                                    <button
                                      onClick={() => copyField(`${f.id}-impact`, sections.impact)}
                                      className="text-[10px] px-2 py-0.5 rounded font-medium"
                                      style={{ background: "#7c3aed", color: "#fff" }}
                                    >
                                      {copiedId === `${f.id}-impact` ? "Copied" : "Copy"}
                                    </button>
                                  </div>
                                  <div
                                    className="text-[11px] rounded p-2"
                                    style={{ background: "#0a0612", color: "var(--text-dim)" }}
                                  >
                                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace", lineHeight: 1.5 }}>{sections.impact}</pre>
                                  </div>
                                </div>

                                {/* CVSS if available from prepareSubmission */}
                                {ms?.cvss && (
                                  <div className="rounded-md p-3" style={{ background: "#0f0a1a", border: "1px solid #2d2640" }}>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#a78bfa" }}>CVSS v3.1</span>
                                    <div className="grid grid-cols-4 gap-1 mt-2">
                                      {(
                                        [
                                          ["Attack Vector", ms.cvss.attack_vector],
                                          ["Attack Complexity", ms.cvss.attack_complexity],
                                          ["Privileges", ms.cvss.privileges_required],
                                          ["User Interaction", ms.cvss.user_interaction],
                                          ["Scope", ms.cvss.scope],
                                          ["Confidentiality", ms.cvss.confidentiality],
                                          ["Integrity", ms.cvss.integrity],
                                          ["Availability", ms.cvss.availability],
                                        ] as const
                                      ).map(([label, value]) => (
                                        <div key={label} className="flex items-center gap-1 text-[10px]">
                                          <span style={{ color: "var(--text-dim)" }}>{label}:</span>
                                          <span className="font-semibold capitalize" style={{ color: "var(--text)" }}>{value}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
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
