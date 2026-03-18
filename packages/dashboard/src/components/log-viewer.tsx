"use client";

import { useEffect, useRef } from "react";
import { trpc } from "@/components/trpc-provider";

export function LogViewer({ bountyId }: { bountyId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data } = trpc.solverLogs.useQuery(
    { bountyId, tailLines: 80 },
    { refetchInterval: 1500 },
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [data?.lines]);

  return (
    <div
      ref={scrollRef}
      className="overflow-auto rounded-lg border font-mono text-xs leading-relaxed"
      style={{
        background: "#08080c",
        borderColor: "var(--border)",
        maxHeight: 360,
        minHeight: 200,
      }}
    >
      {(!data || data.lines.length === 0) && (
        <div className="flex h-48 items-center justify-center" style={{ color: "var(--text-dim)" }}>
          Waiting for output...
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words p-4" style={{ color: "#c4c4d4" }}>
        {data?.lines.join("\n")}
      </pre>
    </div>
  );
}
