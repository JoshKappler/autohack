"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { trpc } from "@/components/trpc-provider";

// ── Types for stream-json events ──

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: {
    id?: string;
    model?: string;
    content?: ContentBlock[];
    usage?: Usage;
    stop_reason?: string;
  };
  tool_use_result?: {
    type?: string;
    file?: { filePath?: string; content?: string; numLines?: number };
  };
  name?: string;
  input?: Record<string, any>;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Usage;
  session_id?: string;
  tools?: string[];
  model?: string;
  claude_code_version?: string;
  parent_tool_use_id?: string | null;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, any>;
  caller?: { type: string };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// ── Rendering helpers ──

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function getToolIcon(name: string): string {
  switch (name) {
    case "Read": return "\u{1F4C4}";
    case "Edit": return "\u{270F}\u{FE0F}";
    case "Write": return "\u{1F4DD}";
    case "Bash": return "\u{1F4BB}";
    case "Glob": return "\u{1F50D}";
    case "Grep": return "\u{1F50E}";
    case "Agent": return "\u{1F916}";
    case "WebFetch": return "\u{1F310}";
    case "WebSearch": return "\u{1F50D}";
    default: return "\u{1F527}";
  }
}

function getToolSummary(name: string, input: Record<string, any> | undefined): string {
  if (!input) return "";
  switch (name) {
    case "Read":
      return input.file_path ?? "";
    case "Edit":
      return input.file_path ?? "";
    case "Write":
      return input.file_path ?? "";
    case "Bash":
      return input.command ? (input.command.length > 120 ? input.command.slice(0, 120) + "..." : input.command) : "";
    case "Glob":
      return input.pattern ?? "";
    case "Grep":
      return `/${input.pattern ?? ""}/ ${input.path ?? ""}`;
    case "Agent":
      return input.description ?? input.prompt?.slice(0, 80) ?? "";
    default:
      return JSON.stringify(input).slice(0, 100);
  }
}

// ── Event components ──

function InitEvent({ event }: { event: StreamEvent }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs" style={{ color: "var(--text-dim)" }}>
      <span style={{ color: "#6e6e8a" }}>session</span>
      <span style={{ color: "#a855f7" }}>{event.model ?? "unknown"}</span>
      {event.claude_code_version && (
        <span>v{event.claude_code_version}</span>
      )}
      {event.tools && (
        <span>{event.tools.length} tools</span>
      )}
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;

  return (
    <div
      className="mx-4 my-1 rounded border px-3 py-2"
      style={{ borderColor: "#3a3a5c", background: "#0d0d1a" }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left text-xs font-medium"
        style={{ color: "#a855f7" }}
      >
        <span style={{ fontSize: 10, opacity: 0.7 }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        Thinking...
        <span className="ml-auto font-mono text-[10px]" style={{ color: "#6e6e8a" }}>
          {content.length} chars
        </span>
      </button>
      {expanded && (
        <pre
          className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-xs leading-relaxed"
          style={{ color: "#8a8aac" }}
        >
          {content}
        </pre>
      )}
      {!expanded && (
        <pre
          className="mt-1 overflow-hidden whitespace-pre-wrap text-[11px] leading-relaxed"
          style={{ color: "#6e6e8a", maxHeight: 40 }}
        >
          {preview}
        </pre>
      )}
    </div>
  );
}

function ToolUseBlock({ block }: { block: ContentBlock }) {
  const summary = getToolSummary(block.name ?? "", block.input);
  return (
    <div
      className="mx-4 my-1 flex items-start gap-2 rounded border px-3 py-1.5"
      style={{ borderColor: "#1e3a5f", background: "#0a1628" }}
    >
      <span className="flex-shrink-0 text-xs">{getToolIcon(block.name ?? "")}</span>
      <div className="min-w-0 flex-1">
        <span className="text-xs font-semibold" style={{ color: "#60a5fa" }}>
          {block.name}
        </span>
        {summary && (
          <span className="ml-2 truncate text-xs font-mono" style={{ color: "#8a8aac" }}>
            {summary}
          </span>
        )}
      </div>
    </div>
  );
}

function ToolResultBlock({ event }: { event: StreamEvent }) {
  const [expanded, setExpanded] = useState(false);
  const fileInfo = event.tool_use_result?.file;
  const content = fileInfo?.content ?? "";
  const hasContent = content.length > 0;

  if (!hasContent) return null;

  return (
    <div
      className="mx-4 my-0.5 rounded border px-3 py-1"
      style={{ borderColor: "#1a2e1a", background: "#0a140a" }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-left text-[10px]"
        style={{ color: "#4ade80" }}
      >
        <span style={{ fontSize: 9, opacity: 0.7 }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        {fileInfo?.filePath && (
          <span className="truncate font-mono" style={{ color: "#6e8a6e" }}>
            {fileInfo.filePath}
          </span>
        )}
        <span className="ml-auto" style={{ color: "#4a6a4a" }}>
          {fileInfo?.numLines ?? content.split("\n").length} lines
        </span>
      </button>
      {expanded && (
        <pre
          className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed"
          style={{ color: "#8aac8a" }}
        >
          {content.slice(0, 3000)}
          {content.length > 3000 && "\n[truncated]"}
        </pre>
      )}
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <div className="px-4 py-1">
      <pre
        className="whitespace-pre-wrap text-xs leading-relaxed"
        style={{ color: "#e4e4ef" }}
      >
        {text}
      </pre>
    </div>
  );
}

function AssistantEvent({ event }: { event: StreamEvent }) {
  const content = event.message?.content ?? [];
  const usage = event.message?.usage;

  return (
    <div className="border-l-2 py-1" style={{ borderColor: "#3b82f6" }}>
      {content.map((block, i) => {
        if (block.type === "thinking" && block.thinking) {
          return <ThinkingBlock key={i} content={block.thinking} />;
        }
        if (block.type === "tool_use") {
          return <ToolUseBlock key={i} block={block} />;
        }
        if (block.type === "text" && block.text) {
          return <TextBlock key={i} text={block.text} />;
        }
        return null;
      })}
      {usage && (usage.input_tokens || usage.output_tokens) && (
        <div className="flex gap-3 px-4 py-0.5 text-[10px] font-mono" style={{ color: "#4a4a6a" }}>
          {usage.input_tokens != null && <span>in: {formatTokens(usage.input_tokens)}</span>}
          {usage.output_tokens != null && <span>out: {formatTokens(usage.output_tokens)}</span>}
          {usage.cache_read_input_tokens != null && usage.cache_read_input_tokens > 0 && (
            <span>cache: {formatTokens(usage.cache_read_input_tokens)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ResultEvent({ event }: { event: StreamEvent }) {
  const isSuccess = event.subtype === "success";
  return (
    <div
      className="mx-4 my-2 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-xs font-mono"
      style={{
        borderColor: isSuccess ? "#1a3a1a" : "#3a1a1a",
        background: isSuccess ? "#0a1a0a" : "#1a0a0a",
      }}
    >
      <span style={{ color: isSuccess ? "#4ade80" : "#ef4444" }}>
        {isSuccess ? "\u2713 Done" : "\u2717 Error"}
      </span>
      {event.duration_ms != null && (
        <span style={{ color: "#8a8aac" }}>
          {formatDuration(event.duration_ms)}
        </span>
      )}
      {event.num_turns != null && (
        <span style={{ color: "#8a8aac" }}>
          {event.num_turns} turn{event.num_turns !== 1 ? "s" : ""}
        </span>
      )}
      {event.total_cost_usd != null && (
        <span style={{ color: "#eab308" }}>
          ${event.total_cost_usd.toFixed(4)}
        </span>
      )}
      {event.usage && (
        <span style={{ color: "#6e6e8a" }}>
          {formatTokens((event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0))} tokens
        </span>
      )}
    </div>
  );
}

// ── Main component ──

export function ClaudeStreamViewer({ bountyId }: { bountyId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const prevEventCountRef = useRef(0);

  const { data } = trpc.solverEvents.useQuery(
    { bountyId, offset: 0, maxEvents: 500 },
    { refetchInterval: 1500 },
  );

  // Fall back to old log viewer if no events file exists
  const { data: legacyLogs } = trpc.solverLogs.useQuery(
    { bountyId, tailLines: 80, maxChars: 100_000 },
    { refetchInterval: 1500, enabled: !data || data.totalEvents === 0 },
  );

  // Deduplicate assistant messages by message.id (keep latest version)
  const events = useMemo(() => {
    if (!data?.events?.length) return [];
    const seen = new Map<string, number>();
    const result: StreamEvent[] = [];

    for (let i = 0; i < data.events.length; i++) {
      const ev = data.events[i];
      if (ev.type === "assistant" && ev.message?.id) {
        const prev = seen.get(ev.message.id);
        if (prev !== undefined) {
          result[prev] = ev; // Replace with latest version
          continue;
        }
        seen.set(ev.message.id, result.length);
      }
      result.push(ev);
    }
    return result.filter(Boolean);
  }, [data?.events]);

  // Auto-scroll to bottom unless user has scrolled up
  useEffect(() => {
    if (!scrollRef.current || userScrolled) return;
    if (events.length !== prevEventCountRef.current) {
      prevEventCountRef.current = events.length;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, userScrolled]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    setUserScrolled(!atBottom);
  };

  // Summary stats from result event
  const resultEvent = events.find((e) => e.type === "result");
  const initEvent = events.find((e) => e.type === "system" && e.subtype === "init");

  // If we have stream events, show them
  if (events.length > 0) {
    return (
      <div className="flex flex-col" style={{ minHeight: 200 }}>
        {/* Header bar */}
        <div
          className="flex items-center justify-between rounded-t-lg border border-b-0 px-4 py-2"
          style={{ background: "#0c0c18", borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-3 text-xs">
            {initEvent?.model && (
              <span className="rounded-full px-2 py-0.5" style={{ background: "#1e1b4b", color: "#a78bfa" }}>
                {initEvent.model}
              </span>
            )}
            {resultEvent ? (
              <>
                <span style={{ color: "#8a8aac" }}>
                  {formatDuration(resultEvent.duration_ms ?? 0)}
                </span>
                <span style={{ color: "#eab308" }}>
                  ${(resultEvent.total_cost_usd ?? 0).toFixed(4)}
                </span>
                <span style={{ color: "#8a8aac" }}>
                  {resultEvent.num_turns ?? 0} turns
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1.5" style={{ color: "#4ade80" }}>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: "#4ade80", animation: "pulse 2s infinite" }}
                />
                Running...
              </span>
            )}
          </div>
          <div className="text-[10px] font-mono" style={{ color: "#6e6e8a" }}>
            {events.length} events
            {userScrolled && (
              <button
                onClick={() => {
                  setUserScrolled(false);
                  scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                }}
                className="ml-2 rounded px-1.5 py-0.5"
                style={{ background: "#1e1b4b", color: "#a78bfa" }}
              >
                scroll to bottom
              </button>
            )}
          </div>
        </div>

        {/* Event stream */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto rounded-b-lg border"
          style={{
            background: "#080810",
            borderColor: "var(--border)",
            maxHeight: "calc(100vh - 400px)",
            minHeight: 300,
          }}
        >
          <div className="py-2">
            {events.map((event, i) => {
              if (event.type === "system" && event.subtype === "init") {
                return <InitEvent key={i} event={event} />;
              }
              if (event.type === "assistant") {
                return <AssistantEvent key={`${event.message?.id ?? i}-${i}`} event={event} />;
              }
              if (event.type === "user" && event.tool_use_result) {
                return <ToolResultBlock key={i} event={event} />;
              }
              if (event.type === "result") {
                return <ResultEvent key={i} event={event} />;
              }
              return null;
            })}
          </div>
        </div>
      </div>
    );
  }

  // Fallback: old-style log viewer
  if (legacyLogs?.raw && legacyLogs.totalLength > 0) {
    return (
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="overflow-y-auto rounded-lg border font-mono text-xs leading-relaxed"
        style={{
          background: "#080810",
          borderColor: "var(--border)",
          maxHeight: "calc(100vh - 400px)",
          minHeight: 200,
        }}
      >
        <pre className="whitespace-pre-wrap break-words p-4" style={{ color: "#c4c4d4" }}>
          {legacyLogs.raw}
        </pre>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center rounded-lg border font-mono text-xs"
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
