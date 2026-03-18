import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "@/components/trpc-provider";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "Algora Bounty Bot",
  description: "Automated bounty solving dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <TRPCProvider>
          <Nav />
          <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        </TRPCProvider>
      </body>
    </html>
  );
}
