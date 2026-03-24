"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/components/trpc-provider";
import { ClaudeTerminalViewer } from "@/components/claude-terminal";

export function SecurityLogViewer({ programId, findingId }: { programId?: string; findingId?: string }) {
  // Incremental event loading — track how many lines we've already fetched
  const [allEvents, setAllEvents] = useState<any[]>([]);
  const afterLineRef = useRef(0);

  const { data: huntEvents } = trpc.securityHuntEvents.useQuery(
    { programId: programId!, afterLine: afterLineRef.current },
    { enabled: !!programId, refetchInterval: 1500 },
  );

  const { data: solverEvents } = trpc.securitySolverEvents.useQuery(
    { findingId: findingId!, afterLine: afterLineRef.current },
    { enabled: !!findingId && !programId, refetchInterval: 1500 },
  );

  const eventsData = programId ? huntEvents : solverEvents;

  // Accumulate events incrementally
  useEffect(() => {
    if (!eventsData) return;
    if (eventsData.events.length > 0) {
      setAllEvents((prev) => [...prev, ...eventsData.events]);
      afterLineRef.current = eventsData.totalLines;
    } else if (eventsData.totalLines < afterLineRef.current) {
      // File was rotated/reset — start fresh
      afterLineRef.current = 0;
      setAllEvents([]);
    }
  }, [eventsData]);

  // Reset when programId/findingId changes
  useEffect(() => {
    setAllEvents([]);
    afterLineRef.current = 0;
  }, [programId, findingId]);

  // If we have structured events, use the Claude terminal renderer
  if (allEvents.length > 0) {
    return <ClaudeTerminalViewer events={allEvents} />;
  }

  // Fallback: try plain text logs for older hunts without .events.jsonl
  return <PlainLogFallback programId={programId} findingId={findingId} />;
}

/** Fallback: load plain text logs for runs that don't have .events.jsonl */
function PlainLogFallback({ programId, findingId }: { programId?: string; findingId?: string }) {
  const { data: huntData } = trpc.securityHuntLogs.useQuery(
    { programId: programId!, tail: 200, maxChars: 100_000 },
    { enabled: !!programId, refetchInterval: 1500 },
  );

  const { data: findingData } = trpc.securitySolverLogs.useQuery(
    { findingId: findingId!, tail: 200, maxChars: 100_000 },
    { enabled: !!findingId && !programId, refetchInterval: 1500 },
  );

  const data = programId ? huntData : findingData;
  const lines = data?.lines ?? [];

  if (!data || lines.length === 0) {
    return (
      <div
        className="flex items-center justify-center overflow-auto rounded-lg border font-mono text-xs"
        style={{
          background: "#080810",
          borderColor: "var(--border)",
          height: 200,
          color: "var(--text-dim)",
        }}
      >
        Waiting for output...
      </div>
    );
  }

  return <PlainLogViewer lines={lines} maxHeight={500} />;
}

/** Plain text viewer for logs without structured events */
function PlainLogViewer({ lines, maxHeight }: { lines: string[]; maxHeight: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div
      ref={scrollRef}
      className="overflow-auto rounded-lg border font-mono text-xs leading-relaxed"
      style={{
        background: "#080810",
        borderColor: "var(--border)",
        maxHeight,
        minHeight: 200,
      }}
    >
      <pre className="whitespace-pre-wrap break-words p-4" style={{ color: "#c4c4d4" }}>
        {lines.join("\n")}
      </pre>
    </div>
  );
}
