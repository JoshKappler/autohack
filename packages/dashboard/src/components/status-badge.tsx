const statusColors: Record<string, { bg: string; text: string }> = {
  discovered: { bg: "#1e293b", text: "#94a3b8" },
  analyzing: { bg: "#1e1b4b", text: "#818cf8" },
  selected: { bg: "#172554", text: "#60a5fa" },
  attempting: { bg: "#422006", text: "#fbbf24" },
  solving: { bg: "#431407", text: "#fb923c" },
  pr_created: { bg: "#052e16", text: "#4ade80" },
  in_review: { bg: "#1a2e05", text: "#a3e635" },
  merged: { bg: "#022c22", text: "#2dd4bf" },
  rejected: { bg: "#450a0a", text: "#f87171" },
  failed: { bg: "#450a0a", text: "#f87171" },
  // Security finding statuses
  scanning: { bg: "#1e1b4b", text: "#818cf8" },
  validated: { bg: "#172554", text: "#60a5fa" },
  drafting: { bg: "#422006", text: "#fbbf24" },
  report_ready: { bg: "#422006", text: "#fbbf24" },
  reviewing: { bg: "#052e16", text: "#4ade80" },
  submitted: { bg: "#1a2e05", text: "#a3e635" },
  triaged: { bg: "#022c22", text: "#2dd4bf" },
  accepted: { bg: "#022c22", text: "#2dd4bf" },
  rewarded: { bg: "#052e16", text: "#4ade80" },
  duplicate: { bg: "#431407", text: "#fb923c" },
  not_applicable: { bg: "#450a0a", text: "#f87171" },
  informative: { bg: "#1e293b", text: "#94a3b8" },
  dismissed: { bg: "#1e293b", text: "#94a3b8" },
  bot_rejected: { bg: "#431407", text: "#fb923c" },
};

export const displayLabels: Record<string, string> = {
  reviewing: "ready to submit",
  report_ready: "pending",
  pr_created: "pr created",
  in_review: "in review",
  not_applicable: "not applicable",
  bot_rejected: "bot rejected",
  dismissed: "rejected",
};

export function StatusBadge({ status }: { status: string }) {
  const colors = statusColors[status] ?? { bg: "#1e293b", text: "#94a3b8" };
  const label = displayLabels[status] ?? status.replace("_", " ");

  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ background: colors.bg, color: colors.text }}
    >
      {label}
    </span>
  );
}
