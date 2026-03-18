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
};

export function StatusBadge({ status }: { status: string }) {
  const colors = statusColors[status] ?? { bg: "#1e293b", text: "#94a3b8" };

  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ background: colors.bg, color: colors.text }}
    >
      {status.replace("_", " ")}
    </span>
  );
}
