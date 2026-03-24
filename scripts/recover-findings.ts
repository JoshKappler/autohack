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

// Derive program ID from log filename: hunt-h1-shopify.log -> h1-shopify, hunt-immunefi-foo.log -> immunefi-foo
function programIdFromLog(logFile: string): string | null {
  const m = logFile.match(/^hunt-(.+)\.log$/);
  return m ? m[1] : null;
}

// For sec-sf-*.log files, look up the program from the finding ID in the log name
function findingIdFromSecLog(logFile: string): string | null {
  const m = logFile.match(/^sec-(sf-[a-f0-9]+)\.log$/);
  return m ? m[1] : null;
}

interface ParsedFinding {
  title: string;
  severity: string;
  vulnerabilityType: string;
  targetAsset: string;
  confidence: number;
  reportBody: string;
}

// Strip ANSI escape sequences (PTY logs contain these)
const ANSI_RE = /[\x1B\x9B][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g;

function parseFindings(output: string): ParsedFinding[] {
  // Strip ANSI codes first — PTY logs are full of them
  const clean = output.replace(ANSI_RE, "");
  const findings: ParsedFinding[] = [];
  const regex = /===FINDING_START===([\s\S]*?)===FINDING_END===/g;
  let match;

  while ((match = regex.exec(clean)) !== null) {
    const block = match[1].trim();

    const title = block.match(/\*\*Title:\*\*\s*(.+)/)?.[1]?.trim() ?? "Untitled Finding";
    const rawSev = block.match(/\*\*Severity:\*\*\s*(.+)/)?.[1]?.trim().toLowerCase() ?? "medium";
    const severity = ["critical", "high", "medium", "low", "informational"].find(s => rawSev.includes(s)) ?? "medium";
    const vulnType = block.match(/\*\*Vulnerability Type:\*\*\s*(.+)/)?.[1]?.trim() ?? "Unknown";
    const target = block.match(/\*\*(?:Target )?Asset:\*\*\s*(.+)/)?.[1]?.trim() ?? "Unknown";
    const confMatch = block.match(/\*\*Confidence:\*\*\s*([\d.]+)/);
    const confidence = confMatch ? Math.max(0, Math.min(1, parseFloat(confMatch[1]))) : 0.5;

    findings.push({
      title,
      severity,
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

  // Build lookup: program slug -> program ID from DB
  const programs = db.prepare("SELECT id FROM security_programs").all() as Array<{ id: string }>;
  const programIds = new Set(programs.map((p) => p.id));

  // For sec-sf-*.log files, get the program_id from existing findings
  const findingPrograms = new Map<string, string>();
  const fpRows = db.prepare("SELECT id, program_id FROM security_findings").all() as Array<{ id: string; program_id: string }>;
  for (const r of fpRows) findingPrograms.set(r.id, r.program_id);

  let recovered = 0;
  let skippedDuplicate = 0;
  let skippedLowQuality = 0;
  let skippedNoProgram = 0;

  // Scan all hunt-* and sec-* log files
  const logFiles = readdirSync(LOG_DIR).filter(
    (f) => f.endsWith(".log") && !f.endsWith(".events.jsonl") && (f.startsWith("hunt-") || f.startsWith("sec-")),
  );

  for (const logFile of logFiles) {
    // Determine program ID
    let programId: string | null = programIdFromLog(logFile);
    if (programId && !programIds.has(programId)) {
      // Try with underscores replaced by hyphens and vice versa
      const alt = programId.replace(/_/g, "-");
      if (programIds.has(alt)) programId = alt;
    }

    if (!programId) {
      // sec-sf-*.log: look up finding's program
      const fid = findingIdFromSecLog(logFile);
      if (fid) programId = findingPrograms.get(fid) ?? null;
    }

    if (!programId || !programIds.has(programId)) {
      // Skip silently — most logs won't need recovery
      continue;
    }

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
      const traceId = `trc_recovered_${randomBytes(4).toString("hex")}`;
      const now = Math.floor(Date.now() / 1000);

      console.log(`  INSERT: ${f.title} [${f.severity}, ${f.confidence}] → ${findingId} (program: ${programId})`);

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
  console.log(`Skipped (no program): ${skippedNoProgram}`);

  db.close();
}

main();
