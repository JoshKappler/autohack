"use client";

import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Claude Code's terminal theme
const CLAUDE_THEME = {
  background: "#080810",
  foreground: "#c4c4d4",
  cursor: "#c4c4d4",
  cursorAccent: "#080810",
  selectionBackground: "#3a3a5c",
  selectionForeground: "#e4e4ef",
  black: "#1a1a2e",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#c4c4d4",
  brightBlack: "#6e6e8a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fde047",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#e4e4ef",
};

interface XTermViewerProps {
  raw: string;
  totalLength: number;
  maxHeight?: number;
  minHeight?: number;
}

export function XTermViewer({
  raw,
  totalLength,
  maxHeight = 400,
  minHeight = 200,
}: XTermViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const prevTotalLengthRef = useRef(0);
  const prevRawLengthRef = useRef(0);
  const initializedRef = useRef(false);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const term = new Terminal({
      theme: CLAUDE_THEME,
      fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorStyle: "block",
      cursorBlink: false,
      disableStdin: true,
      scrollback: 10000,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Small delay so the container has dimensions before fitting
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {}
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {}
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      initializedRef.current = false;
    };
  }, []);

  // Write incremental data to terminal
  const writeData = useCallback((raw: string, totalLength: number) => {
    const term = termRef.current;
    if (!term || !raw) return;

    const prevTotal = prevTotalLengthRef.current;
    const prevRawLen = prevRawLengthRef.current;

    if (totalLength === prevTotal && raw.length === prevRawLen) {
      // No change
      return;
    }

    if (totalLength < prevTotal || prevTotal === 0) {
      // File was truncated/rotated, or first load — write everything
      term.reset();
      term.write(raw);
    } else if (totalLength > prevTotal) {
      // File grew — compute what's new
      const tailStart = totalLength - raw.length;
      if (tailStart <= prevTotal) {
        // Our previous position is within this tail
        const offsetInRaw = prevTotal - tailStart;
        const newContent = raw.slice(offsetInRaw);
        if (newContent.length > 0) {
          term.write(newContent);
        }
      } else {
        // Gap — we missed some content. Reset and rewrite all
        term.reset();
        term.write(raw);
      }
    }

    prevTotalLengthRef.current = totalLength;
    prevRawLengthRef.current = raw.length;
  }, []);

  useEffect(() => {
    writeData(raw, totalLength);
  }, [raw, totalLength, writeData]);

  return (
    <div
      className="overflow-auto rounded-lg border"
      style={{
        borderColor: "var(--border)",
        maxHeight,
        minHeight,
      }}
    >
      <div
        ref={containerRef}
        style={{
          height: "100%",
          minHeight,
        }}
      />
    </div>
  );
}
