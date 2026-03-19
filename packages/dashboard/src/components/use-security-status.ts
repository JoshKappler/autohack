import { trpc } from "@/components/trpc-provider";

export interface SecurityDisplayStatus {
  active: boolean;
  label: string;
  detail?: string;
  color: string;
  model: string;
  /** Raw solver stage if solver is active */
  solverStage?: string;
  /** Whether adversarial review is running */
  isReviewing: boolean;
  /** Whether security analysis is running */
  isAnalyzing: boolean;
  /** Whether the solver is actively working */
  isSolving: boolean;
  /** Adversarial review progress */
  adversarial?: { completed: number; total: number; currentFindingId?: string; currentFindingTitle?: string };
  /** Analysis progress */
  analysis?: { mode?: string; currentName?: string };
  /** Solver metadata */
  solver?: {
    programId?: string;
    programName?: string;
    findingId?: string;
    findingTitle?: string;
    severity?: string;
    stage?: string;
    startedAt?: string;
    timeoutMinutes?: number;
    linesOutput?: number;
    lastActivity?: string;
  };
}

const stageLabels: Record<string, string> = {
  hunting: "Hunting",
  reviewing: "Self-Review",
  done: "Finishing",
};

/**
 * Single source of truth for security agent display status.
 * All components should use this hook instead of deriving status independently.
 */
export function useSecurityStatus(): SecurityDisplayStatus {
  const { data: solverStatus } = trpc.securitySolverStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: analyzeStatus } = trpc.securityAnalyzeStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: adversarialStatus } = trpc.securityAdversarialStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: configData } = trpc.config.useQuery();

  // Adversarial review is checked FIRST because the solver status file can be
  // stale (still says "active" from a just-finished hunt) while review runs.
  const isReviewing = adversarialStatus?.active === true;
  const isSolving = solverStatus?.active === true && !isReviewing;
  const isAnalyzing = !isSolving && !isReviewing && analyzeStatus?.running === true;

  const adversarial = isReviewing && adversarialStatus
    ? {
        completed: adversarialStatus.completed ?? 0,
        total: adversarialStatus.total ?? 0,
        currentFindingId: adversarialStatus.currentFindingId ?? undefined,
        currentFindingTitle: adversarialStatus.currentFindingTitle ?? undefined,
      }
    : undefined;

  const solver = (isSolving || isReviewing) && solverStatus
    ? {
        programId: solverStatus.programId ?? undefined,
        programName: solverStatus.programName ?? undefined,
        findingId: solverStatus.findingId ?? undefined,
        findingTitle: solverStatus.findingTitle ?? undefined,
        severity: solverStatus.severity ?? undefined,
        stage: solverStatus.stage ?? undefined,
        startedAt: solverStatus.startedAt ?? undefined,
        timeoutMinutes: solverStatus.timeoutMinutes ?? undefined,
        linesOutput: solverStatus.linesOutput ?? undefined,
        lastActivity: solverStatus.lastActivity ?? undefined,
      }
    : undefined;

  const analysis = isAnalyzing && analyzeStatus
    ? {
        mode: analyzeStatus.mode ?? undefined,
        currentName: analyzeStatus.currentName ?? undefined,
      }
    : undefined;

  if (isReviewing) {
    const detail = adversarialStatus?.currentFindingTitle
      ?? `${adversarialStatus?.completed ?? 0}/${adversarialStatus?.total ?? 0}`;
    return {
      active: true,
      label: "Reviewing Findings",
      detail,
      color: "#fbbf24",
      model: "Opus",
      solverStage: "reviewing",
      isReviewing: true,
      isAnalyzing: false,
      isSolving: false,
      adversarial,
      solver,
    };
  }

  if (isSolving) {
    const stage = solverStatus?.stage ?? "working";
    const label = stageLabels[stage] ?? "Solving";
    const detail = solverStatus?.findingTitle ?? solverStatus?.programName ?? undefined;
    const color = stage === "hunting" ? "var(--green)" : "var(--accent)";
    return {
      active: true,
      label,
      detail,
      color,
      model: "Opus",
      solverStage: stage,
      isReviewing: false,
      isAnalyzing: false,
      isSolving: true,
      solver,
    };
  }

  if (isAnalyzing) {
    const label = analyzeStatus?.mode === "programs" ? "Analyzing Bounties" : "Analyzing Findings";
    const detail = analyzeStatus?.currentName ?? undefined;
    return {
      active: true,
      label,
      detail,
      color: "var(--accent)",
      model: configData?.analysisModel ? configData.analysisModel.charAt(0).toUpperCase() + configData.analysisModel.slice(1) : "…",
      isReviewing: false,
      isAnalyzing: true,
      isSolving: false,
      analysis,
    };
  }

  return {
    active: false,
    label: "Idle",
    color: "var(--yellow)",
    model: "",
    isReviewing: false,
    isAnalyzing: false,
    isSolving: false,
  };
}
