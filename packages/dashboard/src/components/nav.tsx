"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { trpc } from "@/components/trpc-provider";
import { useSecurityStatus } from "@/components/use-security-status";

const sections = [
  {
    key: "hacking",
    label: "Hacking",
    href: "/security",
    match: (p: string) => p.startsWith("/security"),
  },
  {
    key: "coding",
    label: "Coding",
    href: "/",
    match: (p: string) => !p.startsWith("/security"),
    subLinks: [
      { href: "/", label: "Overview" },
      { href: "/bounties", label: "Bounties" },
      { href: "/pipeline", label: "Pipeline" },
      { href: "/traces", label: "Traces" },
      { href: "/earnings", label: "Earnings" },
    ],
  },
];

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
  const { data: solverStatus } = trpc.solverStatus.useQuery(undefined, {
    refetchInterval: 3000,
  });

  const activeSection = sections.find((s) => s.match(pathname)) ?? sections[0];

  return (
    <nav className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="mx-auto max-w-7xl px-6">
        {/* Primary nav row */}
        <div className="flex items-center justify-between py-4">
          <div className="flex items-center gap-8">
            <span className="text-lg font-semibold tracking-tight" style={{ color: "var(--accent)" }}>
              algora bot
            </span>
            <div className="flex gap-1">
              {sections.map((section) => (
                <Link
                  key={section.key}
                  href={section.href}
                  className="rounded-md px-3.5 py-1.5 text-sm font-semibold transition-colors"
                  style={{
                    color: activeSection.key === section.key ? "var(--text)" : "var(--text-dim)",
                    background: activeSection.key === section.key ? "var(--bg-hover)" : "transparent",
                  }}
                >
                  {section.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SecurityAgentIndicator />
            {solverStatus?.active && (
              <div className="flex items-center gap-2">
                <div
                  className="h-2 w-2 rounded-full"
                  style={{ background: "var(--green)", animation: "pulse 2s infinite" }}
                />
                <span className="text-xs" style={{ color: "var(--green)" }}>
                  Solving
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Sub-nav row for Coding section */}
        {activeSection.key === "coding" && activeSection.subLinks && (
          <div className="flex gap-1 pb-3 -mt-1">
            {activeSection.subLinks.map((link) => {
              const isActive =
                link.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                  style={{
                    color: isActive ? "var(--text)" : "var(--text-dim)",
                    background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
                  }}
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}
