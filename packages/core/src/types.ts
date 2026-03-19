export type ProviderName = "algora" | "github" | "hackerone";

export interface AlgoraBounty {
  id: string;
  status: string;
  reward_formatted: string;
  reward: {
    currency: string;
    amount: number; // in cents
  };
  task: {
    repo_owner: string;
    repo_name: string;
    number: number;
    title: string;
    body: string;
    url: string;
  };
  tech: string[];
  created_at: string;
}

export interface FeasibilityResult {
  feasibility: number; // 0-1
  riskFactors: string[];
  approach: string;
  requiresPlanComment: boolean;
}

export interface SolveResult {
  success: boolean;
  changesDescription: string;
  filesChanged: string[];
  testsPassed: boolean;
  error?: string;
}

export interface RepoInfo {
  owner: string;
  name: string;
  language: string | null;
  sizeKb: number;
  stars: number;
  hasCI: boolean;
  openIssues: number;
  testFramework: string | null;
}
