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

// ── Manual Queue State ───────────────────────────────────────

export interface QueueItem {
  bountyId: string;
  // Snapshot fields for display (populated when added)
  title: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  rewardCents: number;
  feasibilityScore: number | null;
  priorityScore: number | null;
  language: string | null;
}

export interface QueueState {
  items: QueueItem[];
  running: boolean;
  cancelled: boolean;
  currentIndex: number; // -1 when not running
  completed: number;
  failed: number;
  errors: Array<{ bountyId: string; error: string }>;
  startedAt: number | null;
}

export const queueState: QueueState = {
  items: [],
  running: false,
  cancelled: false,
  currentIndex: -1,
  completed: 0,
  failed: 0,
  errors: [],
  startedAt: null,
};

export function resetQueueRunState() {
  queueState.running = false;
  queueState.cancelled = false;
  queueState.currentIndex = -1;
  queueState.completed = 0;
  queueState.failed = 0;
  queueState.errors = [];
  queueState.startedAt = null;
}

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
