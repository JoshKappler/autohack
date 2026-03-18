export interface AnalyzeAllState {
  running: boolean;
  cancelled: boolean;
  total: number;
  completed: number;
  currentBountyId: string | null;
  currentBountyTitle: string | null;
  startedAt: number | null;
  errors: Array<{ bountyId: string; error: string }>;
}

export interface AutoSolveState {
  running: boolean;
  phase: "idle" | "analyzing" | "solving";
  startedAt: number | null;
}

export const analyzeAllState: AnalyzeAllState = {
  running: false,
  cancelled: false,
  total: 0,
  completed: 0,
  currentBountyId: null,
  currentBountyTitle: null,
  startedAt: null,
  errors: [],
};

export const autoSolveState: AutoSolveState = {
  running: false,
  phase: "idle",
  startedAt: null,
};

export function resetAnalyzeAllState() {
  analyzeAllState.running = false;
  analyzeAllState.cancelled = false;
  analyzeAllState.total = 0;
  analyzeAllState.completed = 0;
  analyzeAllState.currentBountyId = null;
  analyzeAllState.currentBountyTitle = null;
  analyzeAllState.startedAt = null;
  analyzeAllState.errors = [];
}

export function resetAutoSolveState() {
  autoSolveState.running = false;
  autoSolveState.phase = "idle";
  autoSolveState.startedAt = null;
}
