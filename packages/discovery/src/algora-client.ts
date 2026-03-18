import { algora } from "@algora/sdk";
import { createLogger, type AlgoraBounty } from "@algora/core";

const log = createLogger("algora-client");

export async function fetchAllBounties(): Promise<AlgoraBounty[]> {
  const all: AlgoraBounty[] = [];
  let cursor: string | undefined;

  do {
    const page = await algora.bounty.list.query({
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });

    for (const item of page.items) {
      all.push({
        id: item.id,
        status: item.status,
        reward_formatted: item.reward_formatted,
        reward: {
          currency: item.reward?.currency ?? "USD",
          amount: item.reward?.amount ?? 0,
        },
        task: {
          repo_owner: item.task.repo_owner,
          repo_name: item.task.repo_name,
          number: item.task.number,
          title: item.task.title,
          body: item.task.body ?? "",
          url: item.task.url,
        },
        tech: item.tech ?? [],
        created_at: item.created_at,
      });
    }

    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  log.info({ count: all.length }, "Fetched bounties from Algora SDK");
  return all;
}
