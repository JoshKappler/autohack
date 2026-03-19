/**
 * Recovery script: Extract security findings from hunt logs that were
 * dropped due to pipeline bugs (PoC regex too web-centric, missing markers, etc.)
 * and insert them into the database.
 *
 * Usage: npx tsx scripts/recover-findings.ts [--dry-run]
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const LOG_DIR = join(import.meta.dirname, "..", "data", "logs");
const DB_PATH = join(import.meta.dirname, "..", "data", "algora.db");
const DRY_RUN = process.argv.includes("--dry-run");

// Program ID mapping from log filenames
const PROGRAM_MAP: Record<string, string> = {
  "hunt-h1-automattic": "h1-automattic",
  "hunt-h1-launchdarkly": "h1-launchdarkly",
  "hunt-h1-nextcloud": "h1-nextcloud",
  "hunt-h1-okg": "h1-okg",
  "hunt-h1-toolsforhumanity": "h1-toolsforhumanity",
  "hunt-h1-chia_network": "h1-chia_network",
  "hunt-h1-deriv": "h1-deriv",
  "hunt-h1-discourse": "h1-discourse",
  "hunt-h1-gitlab": "h1-gitlab",
  "hunt-h1-security": "h1-security",
};

interface ParsedFinding {
  title: string;
  severity: string;
  vulnerabilityType: string;
  targetAsset: string;
  confidence: number;
  reportBody: string;
}

function parseFindings(output: string): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  const regex = /===FINDING_START===([\s\S]*?)===FINDING_END===/g;
  let match;

  while ((match = regex.exec(output)) !== null) {
    const block = match[1].trim();

    const title = block.match(/\*\*Title:\*\*\s*(.+)/)?.[1]?.trim() ?? "Untitled Finding";
    const severity = block.match(/\*\*Severity:\*\*\s*(.+)/)?.[1]?.trim().toLowerCase() ?? "medium";
    const vulnType = block.match(/\*\*Vulnerability Type:\*\*\s*(.+)/)?.[1]?.trim() ?? "Unknown";
    const target = block.match(/\*\*Target Asset:\*\*\s*(.+)/)?.[1]?.trim() ?? "Unknown";
    const confMatch = block.match(/\*\*Confidence:\*\*\s*([\d.]+)/);
    const confidence = confMatch ? Math.max(0, Math.min(1, parseFloat(confMatch[1]))) : 0.5;

    findings.push({
      title,
      severity: ["critical", "high", "medium", "low", "informational"].includes(severity) ? severity : "medium",
      vulnerabilityType: vulnType,
      targetAsset: target,
      confidence,
      reportBody: block,
    });
  }

  return findings;
}

function main() {
  const db = new Database(DB_PATH);

  // Get existing finding titles to avoid duplicates
  const existingTitles = new Set(
    db.prepare("SELECT title FROM security_findings").all().map((r: any) => r.title),
  );

  console.log(`Found ${existingTitles.size} existing findings in DB`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE INSERT"}\n`);

  const insertStmt = db.prepare(`
    INSERT INTO security_findings (id, program_id, title, description, severity, vulnerability_type, target_asset, status, confidence_score, report_body, trace_id, discovered_at, updated_at, retry_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'report_ready', ?, ?, ?, ?, ?, 0)
  `);

  let recovered = 0;
  let skippedDuplicate = 0;
  let skippedLowQuality = 0;

  const logFiles = readdirSync(LOG_DIR).filter((f) => f.startsWith("hunt-h1-") && f.endsWith(".log"));

  for (const logFile of logFiles) {
    const baseName = logFile.replace(".log", "");
    const programId = PROGRAM_MAP[baseName];
    if (!programId) continue;

    const content = readFileSync(join(LOG_DIR, logFile), "utf-8");
    const findings = parseFindings(content);

    if (findings.length === 0) continue;

    console.log(`\n--- ${logFile} (${findings.length} findings) ---`);

    for (const f of findings) {
      // Skip duplicates
      if (existingTitles.has(f.title)) {
        console.log(`  SKIP (duplicate): ${f.title}`);
        skippedDuplicate++;
        continue;
      }

      // Skip low/informational severity
      if (!["critical", "high", "medium"].includes(f.severity)) {
        console.log(`  SKIP (low severity): ${f.title} [${f.severity}]`);
        skippedLowQuality++;
        continue;
      }

      const findingId = `sf-${randomBytes(8).toString("hex")}`;
      const traceId = `trc_${randomBytes(4).toString("hex")}`;
      const now = Math.floor(Date.now() / 1000);

      console.log(`  INSERT: ${f.title} [${f.severity}, ${f.confidence}] → ${findingId}`);

      if (!DRY_RUN) {
        insertStmt.run(
          findingId,
          programId,
          f.title,
          f.reportBody,
          f.severity,
          f.vulnerabilityType,
          f.targetAsset,
          f.confidence,
          f.reportBody,
          traceId,
          now,
          now,
        );
      }

      existingTitles.add(f.title);
      recovered++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Recovered: ${recovered}`);
  console.log(`Skipped (duplicate): ${skippedDuplicate}`);
  console.log(`Skipped (low quality): ${skippedLowQuality}`);

  db.close();
}

main();
