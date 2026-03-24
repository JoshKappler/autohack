// ── Security Analysis State ──────────────────────────────────

export interface SecurityAnalyzeState {
  running: boolean;
  cancelled: boolean;
  mode: "programs" | "findings";
  total: number;
  completed: number;
  currentId: string | null;
  currentName: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  errors: Array<{ id: string; error: string }>;
}

export const securityAnalyzeState: SecurityAnalyzeState = {
  running: false,
  cancelled: false,
  mode: "programs",
  total: 0,
  completed: 0,
  currentId: null,
  currentName: null,
  startedAt: null,
  lastActivityAt: null,
  errors: [],
};

export function resetSecurityAnalyzeState() {
  securityAnalyzeState.running = false;
  securityAnalyzeState.cancelled = false;
  securityAnalyzeState.mode = "programs";
  securityAnalyzeState.total = 0;
  securityAnalyzeState.completed = 0;
  securityAnalyzeState.currentId = null;
  securityAnalyzeState.currentName = null;
  securityAnalyzeState.startedAt = null;
  securityAnalyzeState.lastActivityAt = null;
  securityAnalyzeState.errors = [];
}

// ── Adversarial Review State ────────────────────────────────

export interface AdversarialReviewState {
  running: boolean;
  cancelled: boolean;
  total: number;
  completed: number;
  currentFindingId: string | null;
  currentFindingTitle: string | null;
  startedAt: number | null;
}

export const adversarialReviewState: AdversarialReviewState = {
  running: false,
  cancelled: false,
  total: 0,
  completed: 0,
  currentFindingId: null,
  currentFindingTitle: null,
  startedAt: null,
};

export function resetAdversarialReviewState() {
  adversarialReviewState.running = false;
  adversarialReviewState.cancelled = false;
  adversarialReviewState.total = 0;
  adversarialReviewState.completed = 0;
  adversarialReviewState.currentFindingId = null;
  adversarialReviewState.currentFindingTitle = null;
  adversarialReviewState.startedAt = null;
}
