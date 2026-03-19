import type { ProviderName } from "@algora/core";

export interface DiscoveredBounty {
  providerBountyId: string;
  provider: ProviderName;
  sourceUrl: string;
  githubUrl: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number;
  title: string;
  body: string | null;
  labels?: string[];
  rewardCents: number;
  currency: string;
  paymentGuaranteed: boolean;
}

export interface BountyProvider {
  readonly name: ProviderName;
  readonly displayName: string;
  isEnabled(): boolean;
  fetchBounties(): Promise<DiscoveredBounty[]>;
}
