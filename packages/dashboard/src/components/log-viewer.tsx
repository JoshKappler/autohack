"use client";

import { useEffect, useRef } from "react";
import { trpc } from "@/components/trpc-provider";
import { XTermViewer } from "@/components/xterm-viewer";
import { ClaudeStreamViewer } from "@/components/claude-stream-viewer";

export function LogViewer({ bountyId }: { bountyId: string }) {
  // Use the rich stream viewer which handles fallback internally
  return <ClaudeStreamViewer bountyId={bountyId} />;
}

export function SecurityLogViewer({ programId, findingId }: { programId?: string; findingId?: string }) {
  const { data: huntData } = trpc.securityHuntLogs.useQuery(
    { programId: programId!, tail: 200, maxChars: 100_000 },
    { enabled: !!programId, refetchInterval: 1500 },
  );

  const { data: findingData } = trpc.securitySolverLogs.useQuery(
    { findingId: findingId!, tail: 200, maxChars: 100_000 },
    { enabled: !!findingId && !programId, refetchInterval: 1500 },
  );

  const data = programId ? huntData : findingData;
  const raw = data?.raw ?? "";
  const totalLength = data?.totalLength ?? 0;
  const lines = data?.lines ?? [];

  if (!data || (raw.length === 0 && lines.length === 0)) {
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

  if (raw && totalLength > 0) {
    return (
      <XTermViewer
        raw={raw}
        totalLength={totalLength}
        maxHeight={400}
        minHeight={200}
      />
    );
  }

  return <PlainLogViewer lines={lines} maxHeight={400} />;
}

/** Fallback plain text viewer for logs without ANSI content */
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
