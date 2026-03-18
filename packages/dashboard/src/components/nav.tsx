"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { trpc } from "@/components/trpc-provider";

const links = [
  { href: "/", label: "Overview" },
  { href: "/bounties", label: "Bounties" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/traces", label: "Traces" },
  { href: "/earnings", label: "Earnings" },
];

export function Nav() {
  const pathname = usePathname();
  const { data: solverStatus } = trpc.solverStatus.useQuery(undefined, {
    refetchInterval: 3000,
  });

  return (
    <nav className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-8">
          <span className="text-lg font-semibold tracking-tight" style={{ color: "var(--accent)" }}>
            algora bot
          </span>
          <div className="flex gap-1">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
                style={{
                  color: pathname === link.href ? "var(--text)" : "var(--text-dim)",
                  background: pathname === link.href ? "var(--bg-hover)" : "transparent",
                }}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
        {/* Status dot in nav */}
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
    </nav>
  );
}
