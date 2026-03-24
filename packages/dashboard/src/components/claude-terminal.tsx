"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// Structured event from .events.jsonl
interface StreamEvent {
  ts: string;
  type: "text" | "tool_use" | "tool_result" | "error" | "status";
  content?: string;
  tool?: string;
  detail?: string;
  id?: string;
  summary?: string;
  durationMs?: number;
}

const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  Bash: "Ran command",
  Read: "Read file",
  Write: "Wrote file",
  Edit: "Edited file",
  Grep: "Searched code",
  Glob: "Found files",
  WebFetch: "Fetched URL",
  WebSearch: "Web search",
  Agent: "Spawned agent",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function elapsedSince(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  return formatDuration(Math.max(0, ms));
}

function ToolUseEvent({
  event,
  result,
  isLast,
}: {
  event: StreamEvent;
  result?: StreamEvent;
  isLast: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);
  const isPending = !result && isLast;
  const friendlyName = FRIENDLY_TOOL_NAMES[event.tool ?? ""] ?? event.tool ?? "Tool";

  // Tick every second while pending to update elapsed timer
  useEffect(() => {
    if (!isPending) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [isPending]);

  return (
    <div style={{ marginLeft: 16, marginTop: 2, marginBottom: 2 }}>
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => result?.summary && setExpanded(!expanded)}
        style={{ minHeight: 22 }}
      >
        {isPending ? (
          <span
            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
            style={{ background: "#22c55e", animation: "pulse 1.5s infinite" }}
          />
        ) : (
          <span
            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
            style={{ background: "#6e6e8a" }}
          />
        )}
        <span style={{ color: isPending ? "#c4c4d4" : "#6e6e8a" }}>
          {friendlyName}
        </span>
        {event.detail && (
          <span
            className="truncate"
            style={{ color: "#6e6e8a", maxWidth: 500 }}
            title={event.detail}
          >
            {event.detail}
          </span>
        )}
        <span className="ml-auto flex-shrink-0" style={{ color: "#6e6e8a" }}>
          {isPending ? elapsedSince(event.ts) : result?.durationMs != null ? formatDuration(result.durationMs) : ""}
        </span>
        {result?.summary && (
          <span style={{ color: "#6e6e8a", fontSize: 10 }}>
            {expanded ? "▼" : "▶"}
          </span>
        )}
      </div>
      {expanded && result?.summary && (
        <pre
          className="whitespace-pre-wrap break-words mt-1 mb-1 rounded px-3 py-2"
          style={{
            color: "#6e6e8a",
            background: "#0e0e1a",
            fontSize: 11,
            lineHeight: 1.4,
            maxHeight: 300,
            overflowY: "auto",
            marginLeft: 18,
          }}
        >
          {result.summary}
        </pre>
      )}
    </div>
  );
}

function TextEvent({ content }: { content: string }) {
  return (
    <div className="flex gap-2" style={{ marginTop: 8, marginBottom: 4 }}>
      <span className="flex-shrink-0" style={{ color: "#c4c4d4" }}>●</span>
      <span style={{ color: "#c4c4d4", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {content}
      </span>
    </div>
  );
}

function ErrorEvent({ content }: { content: string }) {
  return (
    <div className="flex gap-2" style={{ marginTop: 8, marginBottom: 4 }}>
      <span className="flex-shrink-0" style={{ color: "#ef4444" }}>✗</span>
      <span style={{ color: "#ef4444", fontWeight: 600 }}>
        {content}
      </span>
    </div>
  );
}

export function ClaudeTerminalViewer({ events }: { events: StreamEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 40;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length]);

  // Build a map of tool_result by id for matching
  const resultMap = new Map<string, StreamEvent>();
  for (const e of events) {
    if (e.type === "tool_result" && e.id) {
      resultMap.set(e.id, e);
    }
  }

  // Render events, skipping tool_result (they're shown inline with tool_use)
  const renderedEvents = events.filter((e) => e.type !== "tool_result");

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="overflow-auto rounded-lg border font-mono text-xs leading-relaxed"
      style={{
        background: "#080810",
        borderColor: "var(--border)",
        maxHeight: 500,
        minHeight: 200,
      }}
    >
      <div className="p-4">
        {renderedEvents.length === 0 && (
          <div style={{ color: "#6e6e8a" }}>Waiting for output...</div>
        )}
        {renderedEvents.map((event, i) => {
          if (event.type === "text" && event.content) {
            return <TextEvent key={i} content={event.content} />;
          }
          if (event.type === "tool_use") {
            const result = event.id ? resultMap.get(event.id) : undefined;
            const isLast = i === renderedEvents.length - 1;
            return (
              <ToolUseEvent key={i} event={event} result={result} isLast={isLast} />
            );
          }
          if (event.type === "error" && event.content) {
            return <ErrorEvent key={i} content={event.content} />;
          }
          if (event.type === "status" && event.content) {
            return (
              <div key={i} className="flex gap-2" style={{ marginTop: 8, color: "#22c55e" }}>
                <span className="flex-shrink-0">✓</span>
                <span>{event.content}</span>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
