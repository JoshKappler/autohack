"use client";

import { useState, useRef, useCallback } from "react";
import { trpc } from "@/components/trpc-provider";
import { StatusBadge } from "@/components/status-badge";
import { LogViewer } from "@/components/log-viewer";

const solvableStatuses = ["discovered", "selected", "failed"];

const statuses = [
  "all",
  "discovered",
  "selected",
  "failed",
  "analyzing",
  "attempting",
  "solving",
  "pr_created",
  "in_review",
  "merged",
  "rejected",
];

function timeAgo(date: Date | string | number | null): string {
  if (!date) return "";
  const d = typeof date === "object" ? date : new Date(date);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function SortHeader({
  label,
  field,
  sortBy,
  sortDir,
  setSortBy,
  setSortDir,
}: {
  label: string;
  field: string;
  sortBy: string;
  sortDir: "asc" | "desc";
  setSortBy: (f: string) => void;
  setSortDir: (d: "asc" | "desc") => void;
}) {
  const active = sortBy === field;
  return (
    <th
      className="pb-3 font-medium cursor-pointer select-none whitespace-nowrap"
      style={{ color: active ? "var(--accent)" : "var(--text-dim)" }}
      onClick={() => {
        if (active) setSortDir(sortDir === "desc" ? "asc" : "desc");
        else {
          setSortBy(field);
          setSortDir("desc");
        }
      }}
    >
      {label} {active ? (sortDir === "desc" ? "\u2193" : "\u2191") : ""}
    </th>
  );
}

export default function PipelinePage() {
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<string>("priorityScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const utils = trpc.useUtils();
  const { data: bounties, isLoading } = trpc.bounties.useQuery(
    {
      ...(filter !== "all" ? { status: filter } : {}),
      sortBy: sortBy as any,
      sortDir,
      limit: 100,
    },
    { refetchInterval: 5000 },
  );
  const { data: queue } = trpc.queue.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const { data: solverStatus } = trpc.solverStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });

  const addMutation = trpc.queueAdd.useMutation({
    onSuccess: () => utils.queue.invalidate(),
  });
  const removeMutation = trpc.queueRemove.useMutation({
    onSuccess: () => utils.queue.invalidate(),
  });
  const clearMutation = trpc.queueClear.useMutation({
    onSuccess: () => utils.queue.invalidate(),
  });
  const reorderMutation = trpc.queueReorder.useMutation({
    onSuccess: () => utils.queue.invalidate(),
  });
  const runMutation = trpc.queueRun.useMutation({
    onSuccess: () => utils.queue.invalidate(),
  });
  const stopMutation = trpc.queueStop.useMutation({
    onSuccess: () => {
      utils.queue.invalidate();
      utils.bounties.invalidate();
    },
  });

  const queuedIds = new Set(queue?.items.map((i) => i.bountyId) ?? []);

  const isRunning = queue?.running ?? false;
  const currentIndex = queue?.currentIndex ?? -1;

  // ── Drag state ──
  const dragIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleDragStart = useCallback((idx: number) => {
    dragIdx.current = idx;
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault();
      // Don't allow dropping onto frozen items (already processed or currently solving)
      if (isRunning && idx <= currentIndex) return;
      if (dragIdx.current !== null && dragIdx.current !== idx) {
        setDragOverIdx(idx);
      }
    },
    [isRunning, currentIndex],
  );

  const handleDrop = useCallback(
    (idx: number) => {
      if (dragIdx.current === null || !queue) return;
      // Don't allow dropping onto frozen items
      if (isRunning && idx <= currentIndex) return;
      const items = [...queue.items];
      const [moved] = items.splice(dragIdx.current, 1);
      items.splice(idx, 0, moved);
      reorderMutation.mutate(items.map((i) => i.bountyId));
      dragIdx.current = null;
      setDragOverIdx(null);
    },
    [queue, reorderMutation, isRunning, currentIndex],
  );

  const handleDragEnd = useCallback(() => {
    dragIdx.current = null;
    setDragOverIdx(null);
  }, []);

  // Find the currently-solving bounty for log viewer
  const currentSolvingId =
    isRunning && currentIndex >= 0 ? queue?.items[currentIndex]?.bountyId : null;

  return (
    <div className="flex gap-6" style={{ minHeight: "calc(100vh - 120px)" }}>
      {/* ── Left panel: Bounty browser ── */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pipeline</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--text-dim)" }}>
              Browse bounties and add them to the queue
            </p>
          </div>
        </div>

        {/* Status filter tabs */}
        <div className="mt-4 flex flex-wrap gap-1">
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
              style={{
                background: filter === s ? "var(--accent)" : "var(--bg-card)",
                color: filter === s ? "#fff" : "var(--text-dim)",
                border: `1px solid ${filter === s ? "var(--accent)" : "var(--border)"}`,
              }}
            >
              {s.replace("_", " ")}
            </button>
          ))}
        </div>

        {/* Bounty table */}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th className="pb-3 w-8"></th>
                <th
                  className="pb-3 font-medium"
                  style={{ color: "var(--text-dim)" }}
                >
                  Bounty
                </th>
                <SortHeader
                  label="Reward"
                  field="rewardCents"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  setSortBy={setSortBy}
                  setSortDir={setSortDir}
                />
                <th
                  className="pb-3 font-medium"
                  style={{ color: "var(--text-dim)" }}
                >
                  Status
                </th>
                <SortHeader
                  label="Feasibility"
                  field="feasibilityScore"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  setSortBy={setSortBy}
                  setSortDir={setSortDir}
                />
                <SortHeader
                  label="Score"
                  field="priorityScore"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  setSortBy={setSortBy}
                  setSortDir={setSortDir}
                />
                <SortHeader
                  label="Updated"
                  field="updatedAt"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  setSortBy={setSortBy}
                  setSortDir={setSortDir}
                />
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td
                    colSpan={7}
                    className="py-8 text-center"
                    style={{ color: "var(--text-dim)" }}
                  >
                    Loading...
                  </td>
                </tr>
              )}
              {bounties?.map((b: any) => {
                const inQueue = queuedIds.has(b.id);
                const canAdd = solvableStatuses.includes(b.status);
                return (
                  <tr
                    key={b.id}
                    className="transition-colors"
                    style={{
                      borderBottom: "1px solid var(--border)",
                      opacity: inQueue ? 0.5 : 1,
                    }}
                    onMouseOver={(e) =>
                      (e.currentTarget.style.background = "var(--bg-hover)")
                    }
                    onMouseOut={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                  >
                    <td className="py-3 pr-2">
                      {canAdd && !inQueue && (
                        <button
                          onClick={() => addMutation.mutate(b.id)}
                          disabled={addMutation.isPending}
                          className="rounded p-1 transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ color: "var(--accent)" }}
                          title="Add to queue"
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <line x1="8" y1="3" x2="8" y2="13" />
                            <line x1="3" y1="8" x2="13" y2="8" />
                          </svg>
                        </button>
                      )}
                      {inQueue && (
                        <span
                          className="text-xs"
                          style={{ color: "var(--text-dim)" }}
                          title="In queue"
                        >
                          Q
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <a
                        href={b.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium hover:underline"
                        style={{ color: "var(--accent)" }}
                      >
                        {b.repoOwner}/{b.repoName}#{b.issueNumber}
                      </a>
                      <p
                        className="mt-0.5 max-w-xs truncate text-xs"
                        style={{ color: "var(--text-dim)" }}
                      >
                        {b.title}
                      </p>
                    </td>
                    <td
                      className="py-3 pr-4 font-mono font-semibold"
                      style={{ color: "var(--green)" }}
                    >
                      ${(b.rewardCents / 100).toFixed(0)}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">
                      {b.feasibilityScore != null
                        ? `${(b.feasibilityScore * 100).toFixed(0)}%`
                        : "\u2014"}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs">
                      {b.priorityScore != null
                        ? `${b.priorityScore.toFixed(1)} pts`
                        : "\u2014"}
                    </td>
                    <td
                      className="py-3 pr-4 text-xs"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {timeAgo(b.updatedAt)}
                    </td>
                  </tr>
                );
              })}
              {bounties?.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="py-8 text-center"
                    style={{ color: "var(--text-dim)" }}
                  >
                    No bounties found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Right panel: Queue ── */}
      <div
        className="w-80 shrink-0 rounded-xl border p-4 flex flex-col"
        style={{
          background: "var(--bg-card)",
          borderColor: isRunning ? "var(--accent-dim)" : "var(--border)",
        }}
      >
        {/* Queue header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wider">
              Queue
            </h2>
            <span
              className="text-xs tabular-nums"
              style={{ color: "var(--text-dim)" }}
            >
              {queue?.items.length ?? 0}
            </span>
            {isRunning && (
              <div className="flex items-center gap-1">
                <div
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: "var(--green)",
                    animation: "pulse 2s infinite",
                  }}
                />
                <span
                  className="text-[10px] font-medium"
                  style={{ color: "var(--green)" }}
                >
                  Running
                </span>
              </div>
            )}
          </div>
          {!isRunning && (queue?.items.length ?? 0) > 0 && (
            <button
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
              className="text-xs hover:underline"
              style={{ color: "var(--text-dim)" }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Progress bar when running */}
        {isRunning && queue && (
          <div className="mb-3">
            <div className="flex justify-between text-[10px] mb-1" style={{ color: "var(--text-dim)" }}>
              <span>
                {queue.completed + queue.failed}/{queue.items.length} done
              </span>
              {queue.failed > 0 && (
                <span style={{ color: "#f87171" }}>{queue.failed} failed</span>
              )}
            </div>
            <div
              className="h-1 rounded-full overflow-hidden"
              style={{ background: "var(--border)" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${((queue.completed + queue.failed) / queue.items.length) * 100}%`,
                  background: queue.failed > 0 ? "#f59e0b" : "var(--green)",
                }}
              />
            </div>
          </div>
        )}

        {/* Queue items */}
        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {(queue?.items.length ?? 0) === 0 && !isRunning && (
            <div
              className="flex items-center justify-center h-32 text-xs text-center"
              style={{ color: "var(--text-dim)" }}
            >
              Click + on bounties to add them here,
              <br />
              then drag to reorder
            </div>
          )}
          {queue?.items.map((item, idx) => {
            const isCurrent = isRunning && idx === currentIndex;
            const isDone = isRunning && idx < currentIndex;
            const isWaiting = isRunning && idx > currentIndex;
            const isDragOver = dragOverIdx === idx;

            return (
              <div
                key={item.bountyId}
                draggable={!isRunning || isWaiting}
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className="rounded-lg border px-3 py-2 transition-all"
                style={{
                  background: isCurrent
                    ? "var(--bg-hover)"
                    : isDragOver
                      ? "var(--bg-hover)"
                      : "var(--bg)",
                  borderColor: isCurrent
                    ? "var(--accent-dim)"
                    : isDragOver
                      ? "var(--accent)"
                      : "var(--border)",
                  opacity: isDone ? 0.4 : isWaiting ? 0.7 : 1,
                  cursor: isRunning && !isWaiting ? "default" : "grab",
                  borderTopWidth: isDragOver ? "2px" : "1px",
                  borderTopColor: isDragOver ? "var(--accent)" : undefined,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Position number */}
                    <span
                      className="text-[10px] font-mono tabular-nums shrink-0 w-4 text-center"
                      style={{
                        color: isCurrent ? "var(--accent)" : "var(--text-dim)",
                      }}
                    >
                      {isCurrent ? "\u25B6" : isDone ? "\u2713" : idx + 1}
                    </span>
                    <div className="min-w-0">
                      <p
                        className="text-xs font-medium truncate"
                        style={{
                          color: isCurrent ? "var(--accent)" : "var(--text)",
                        }}
                      >
                        {item.repoOwner}/{item.repoName}#{item.issueNumber}
                      </p>
                      <p
                        className="text-[10px] truncate"
                        style={{ color: "var(--text-dim)" }}
                      >
                        {item.title}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className="text-xs font-mono font-semibold"
                      style={{ color: "var(--green)" }}
                    >
                      ${(item.rewardCents / 100).toFixed(0)}
                    </span>
                    {(!isRunning || isWaiting) && (
                      <button
                        onClick={() => removeMutation.mutate(item.bountyId)}
                        disabled={removeMutation.isPending}
                        className="rounded p-0.5 transition-colors hover:bg-[var(--bg-hover)]"
                        style={{ color: "var(--text-dim)" }}
                        title="Remove from queue"
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <line x1="3" y1="3" x2="9" y2="9" />
                          <line x1="9" y1="3" x2="3" y2="9" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
                {item.feasibilityScore != null && (
                  <div className="mt-1 flex gap-3">
                    <span
                      className="text-[10px]"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {(item.feasibilityScore * 100).toFixed(0)}% feasible
                    </span>
                    {item.language && (
                      <span
                        className="text-[10px]"
                        style={{ color: "var(--text-dim)" }}
                      >
                        {item.language}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Queue errors */}
        {(queue?.errors.length ?? 0) > 0 && (
          <div className="mt-2 max-h-20 overflow-y-auto">
            {queue?.errors.map((err, i) => (
              <p
                key={i}
                className="text-[10px] truncate"
                style={{ color: "#f87171" }}
              >
                {err.bountyId.slice(0, 8)}: {err.error}
              </p>
            ))}
          </div>
        )}

        {/* Run / Stop buttons */}
        <div className="mt-4 flex gap-2">
          {!isRunning && (
            <button
              onClick={() => runMutation.mutate()}
              disabled={
                runMutation.isPending || (queue?.items.length ?? 0) === 0
              }
              className="flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40"
              style={{ background: "var(--green)", color: "#000" }}
            >
              {runMutation.isPending ? "Starting..." : "Run Queue"}
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              className="flex-1 rounded-md px-4 py-2 text-sm font-medium"
              style={{
                background: "#450a0a",
                color: "#ef4444",
                border: "1px solid #7f1d1d",
              }}
            >
              {stopMutation.isPending ? "Stopping..." : "Stop Queue"}
            </button>
          )}
        </div>

        {/* Live log viewer for currently solving bounty */}
        {currentSolvingId && solverStatus?.active && (
          <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
            <div className="mb-2 flex items-center gap-2">
              <div
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: "var(--green)",
                  animation: "pulse 2s infinite",
                }}
              />
              <span
                className="text-xs font-medium"
                style={{ color: "var(--text-dim)" }}
              >
                Live Output
              </span>
            </div>
            <LogViewer bountyId={currentSolvingId} />
          </div>
        )}
      </div>
    </div>
  );
}
