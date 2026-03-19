import type { BountyProvider } from "../provider";
import { AlgoraProvider } from "./algora";
import { GitHubProvider } from "./github";

const allProviders: BountyProvider[] = [
  new AlgoraProvider(),
  new GitHubProvider(),
];

export function getEnabledProviders(): BountyProvider[] {
  return allProviders.filter((p) => p.isEnabled());
}

export function getProvider(name: string): BountyProvider | undefined {
  return allProviders.find((p) => p.name === name);
}
