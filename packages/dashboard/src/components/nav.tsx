"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSecurityStatus } from "@/components/use-security-status";

function SecurityAgentIndicator() {
  const status = useSecurityStatus();

  if (!status.active) return null;

  const { label, detail, model, color } = status;

  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2.5 py-1"
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}
    >
      <div
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}`, animation: "pulse 2s infinite" }}
      />
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color }}>
          {label}
        </span>
        {detail && (
          <span
            className="max-w-[180px] truncate text-[11px]"
            style={{ color: "var(--text-dim)" }}
          >
            {detail}
          </span>
        )}
        <span
          className="rounded px-1 py-px text-[9px] font-bold uppercase"
          style={{ background: "rgba(255,255,255,0.08)", color: "var(--text-dim)" }}
        >
          {model}
        </span>
      </div>
    </div>
  );
}

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="mx-auto max-w-7xl px-6">
        <div className="flex items-center justify-between py-4">
          <div className="flex items-center gap-8">
            <span className="text-lg font-semibold tracking-tight" style={{ color: "var(--accent)" }}>
              bounty hunter
            </span>
          </div>
          <div className="flex items-center gap-3">
            <SecurityAgentIndicator />
          </div>
        </div>
      </div>
    </nav>
  );
}
