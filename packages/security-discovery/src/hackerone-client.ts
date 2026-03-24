import { getConfig, createLogger } from "@bounty/core";

const log = createLogger("hackerone-client");

const BASE_URL = "https://api.hackerone.com/v1";

interface HackerOneScope {
  id: string;
  type: string;
  attributes: {
    asset_type: string;
    asset_identifier: string;
    eligible_for_bounty: boolean;
    eligible_for_submission: boolean;
    instruction: string | null;
    max_severity: string | null;
  };
}

interface HackerOneProgram {
  id: string;
  type: string;
  attributes: {
    handle: string;
    name: string;
    url: string;
    offers_bounties: boolean;
    submission_state: string;
    started_accepting_at: string | null;
    bookmarked: boolean;
    allows_bounty_splitting: boolean;
    state: string;
    average_bounty_lower_amount: number | null;
    average_bounty_upper_amount: number | null;
    top_bounty_lower_amount: number | null;
    top_bounty_upper_amount: number | null;
  };
  relationships?: {
    structured_scopes?: {
      data: HackerOneScope[];
    };
  };
}

export interface HackerOneProgramInfo {
  id: string;
  handle: string;
  name: string;
  url: string;
  offersBounties: boolean;
  state: string;
  startedAcceptingAt: string | null;
  rewardMinCents: number | null;
  rewardMaxCents: number | null;
  scopes: Array<{
    id: string;
    assetType: string;
    assetIdentifier: string;
    eligibleForBounty: boolean;
    maxSeverity: string | null;
  }>;
}

export interface HackerOneSubmissionResult {
  reportId: string;
  reportUrl: string;
}

function getAuth(): { username: string; token: string } | null {
  const config = getConfig();
  if (!config.HACKERONE_USERNAME || !config.HACKERONE_API_TOKEN) return null;
  return { username: config.HACKERONE_USERNAME, token: config.HACKERONE_API_TOKEN };
}

function getAuthHeaders(): Record<string, string> {
  const auth = getAuth();
  if (!auth) throw new Error("HackerOne API credentials not configured");
  return {
    "Accept": "application/json",
    "Authorization": `Basic ${Buffer.from(`${auth.username}:${auth.token}`).toString("base64")}`,
  };
}

async function hackerOnePost(path: string, body: unknown): Promise<any> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HackerOne API ${response.status}: ${response.statusText} — ${text}`);
  }

  return response.json();
}

async function hackerOneGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const response = await fetch(url.toString(), {
    headers: getAuthHeaders(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HackerOne API ${response.status}: ${response.statusText} — ${body}`);
  }

  return response.json();
}

/**
 * Fetch all programs available to the authenticated hacker.
 * Uses cursor-based pagination via page[number].
 */
export async function fetchPrograms(): Promise<HackerOneProgramInfo[]> {
  const programs: HackerOneProgramInfo[] = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const data = await hackerOneGet("/hackers/programs", {
      "page[size]": String(pageSize),
      "page[number]": String(page),
    });

    if (!data.data || data.data.length === 0) break;

    for (const prog of data.data as HackerOneProgram[]) {
      if (!prog.attributes.offers_bounties) continue;
      if (prog.attributes.submission_state !== "open") continue;

      // Use top bounty range, fall back to average bounty range
      const minAmount = prog.attributes.top_bounty_lower_amount ?? prog.attributes.average_bounty_lower_amount;
      const maxAmount = prog.attributes.top_bounty_upper_amount ?? prog.attributes.average_bounty_upper_amount;

      programs.push({
        id: prog.id,
        handle: prog.attributes.handle,
        name: prog.attributes.name,
        url: `https://hackerone.com/${prog.attributes.handle}`,
        offersBounties: prog.attributes.offers_bounties,
        state: prog.attributes.state,
        startedAcceptingAt: prog.attributes.started_accepting_at,
        rewardMinCents: minAmount != null ? Math.round(minAmount * 100) : null,
        rewardMaxCents: maxAmount != null ? Math.round(maxAmount * 100) : null,
        scopes: [],
      });
    }

    // No more pages
    if (data.data.length < pageSize) break;
    page++;
  }

  log.info({ count: programs.length }, "Fetched programs from HackerOne");
  return programs;
}

/**
 * Fetch bounty reward amounts for a specific program via HackerOne's GraphQL API.
 * The REST API v1 doesn't expose bounty table data, so we use the public GraphQL endpoint.
 * Returns the max critical bounty as rewardMaxCents and the min low bounty as rewardMinCents.
 */
export async function fetchProgramDetails(
  programHandle: string,
): Promise<{ rewardMinCents: number | null; rewardMaxCents: number | null }> {
  const query = `query($handle: String!) {
    team(handle: $handle) {
      bounty_table {
        bounty_table_rows(first: 50) {
          edges {
            node {
              low
              low_minimum
              medium
              high
              critical
            }
          }
        }
      }
    }
  }`;

  const response = await fetch("https://hackerone.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { handle: programHandle } }),
  });

  if (!response.ok) {
    log.debug({ status: response.status, handle: programHandle }, "GraphQL bounty fetch failed");
    return { rewardMinCents: null, rewardMaxCents: null };
  }

  const result = await response.json();
  const rows = result?.data?.team?.bounty_table?.bounty_table_rows?.edges;
  if (!rows || rows.length === 0) return { rewardMinCents: null, rewardMaxCents: null };

  let maxReward = 0;
  let minReward = Infinity;

  for (const { node } of rows) {
    // Find the highest bounty across all rows and severities
    for (const val of [node.critical, node.high, node.medium, node.low]) {
      if (val != null && val > maxReward) maxReward = val;
    }
    // Find the lowest non-null bounty
    for (const val of [node.low, node.low_minimum, node.medium, node.high, node.critical]) {
      if (val != null && val > 0 && val < minReward) minReward = val;
    }
  }

  return {
    rewardMinCents: minReward < Infinity ? minReward * 100 : null,
    rewardMaxCents: maxReward > 0 ? maxReward * 100 : null,
  };
}

/**
 * Fetch structured scopes for a specific program.
 * Returns only assets eligible for bounty.
 */
export async function fetchProgramScopes(programHandle: string): Promise<HackerOneProgramInfo["scopes"]> {
  const data = await hackerOneGet(`/hackers/programs/${programHandle}/structured_scopes`, {
    "page[size]": "100",
  });

  const scopes: HackerOneProgramInfo["scopes"] = [];
  if (data.data) {
    for (const scope of data.data as HackerOneScope[]) {
      if (!scope.attributes.eligible_for_bounty) continue;
      scopes.push({
        id: scope.id,
        assetType: scope.attributes.asset_type,
        assetIdentifier: scope.attributes.asset_identifier,
        eligibleForBounty: scope.attributes.eligible_for_bounty,
        maxSeverity: scope.attributes.max_severity,
      });
    }
  }

  log.debug({ handle: programHandle, scopeCount: scopes.length }, "Fetched program scopes");
  return scopes;
}

/**
 * Fetch the current status of a submitted report.
 * Returns the report state, substate, and any triager feedback.
 */
export async function fetchReportStatus(reportId: string): Promise<HackerOneReportStatus | null> {
  try {
    const data = await hackerOneGet(`/hackers/reports/${reportId}`);
    const attrs = data?.data?.attributes;
    if (!attrs) return null;

    // Collect triager/team comments (activities that indicate triage decisions)
    let triagerFeedback: string | undefined;
    const activities = data?.data?.relationships?.activities?.data ?? [];
    for (const activity of activities) {
      const type = activity?.type ?? "";
      const msg = activity?.attributes?.message ?? "";
      // Look for state-change activities from the team
      if (type.includes("state_change") || type.includes("bounty_awarded") || type.includes("comment")) {
        if (msg && !triagerFeedback) {
          triagerFeedback = msg.slice(0, 500);
        }
      }
    }

    return {
      reportId,
      state: attrs.state ?? "unknown",
      substate: attrs.substate ?? "",
      severity: attrs.severity_rating ?? "",
      bountyAmountCents: attrs.bounty_amount != null ? Math.round(attrs.bounty_amount * 100) : null,
      triagerFeedback,
    };
  } catch (err: any) {
    log.debug({ err, reportId }, "Failed to fetch report status");
    return null;
  }
}

export interface HackerOneReportStatus {
  reportId: string;
  state: string; // "new" | "triaged" | "needs-more-info" | "resolved" | "not-applicable" | "informative" | "duplicate" | "spam"
  substate: string;
  severity: string;
  bountyAmountCents: number | null;
  triagerFeedback?: string;
}

/**
 * Fetch the program policy and disclosed reports for duplicate avoidance.
 * Policy text tells us what vuln types are excluded and special testing rules.
 * Disclosed reports help avoid submitting duplicates.
 */
export async function fetchProgramPolicy(
  programHandle: string,
): Promise<{ policy: string | null; disclosedReports: Array<{ title: string; severity: string; disclosedAt: string }>; disclosedReportCount: number }> {
  // Fetch policy via GraphQL (more fields than REST)
  // total_count gives us the full disclosed report count for saturation scoring
  const query = `query($handle: String!) {
    team(handle: $handle) {
      policy
      hacktivity_items(first: 30, filter: { disclosed: true }) {
        total_count
        edges {
          node {
            ... on HacktivityItemInterface {
              reporter { username }
              disclosed_at
              severity_rating
              report { title }
            }
          }
        }
      }
    }
  }`;

  let policy: string | null = null;
  let disclosedReportCount = 0;
  const disclosedReports: Array<{ title: string; severity: string; disclosedAt: string }> = [];

  try {
    const response = await fetch("https://hackerone.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { handle: programHandle } }),
    });

    if (response.ok) {
      const result = await response.json();
      policy = result?.data?.team?.policy ?? null;

      // Use total_count for saturation scoring (may be much higher than the 30 we fetch)
      disclosedReportCount = result?.data?.team?.hacktivity_items?.total_count ?? 0;

      const edges = result?.data?.team?.hacktivity_items?.edges ?? [];
      for (const { node } of edges) {
        if (node?.report?.title) {
          disclosedReports.push({
            title: node.report.title,
            severity: node.severity_rating ?? "unknown",
            disclosedAt: node.disclosed_at ?? "",
          });
        }
      }
    }
  } catch (err) {
    log.debug({ err, handle: programHandle }, "Failed to fetch program policy/hacktivity");
  }

  return { policy, disclosedReports, disclosedReportCount };
}

/**
 * Fetch all disclosed reports for a program with cursor-based pagination.
 * Returns up to `limit` disclosed reports (default 200) for thorough duplicate detection.
 * Falls back to the 30-report fetchProgramPolicy on error.
 */
export async function fetchAllDisclosedReports(
  programHandle: string,
  limit = 200,
): Promise<Array<{ title: string; severity: string; disclosedAt: string }>> {
  const reports: Array<{ title: string; severity: string; disclosedAt: string }> = [];
  let cursor: string | null = null;
  const pageSize = 100;

  try {
    while (reports.length < limit) {
      const afterClause: string = cursor ? `, after: "${cursor}"` : "";
      const query: string = `query($handle: String!) {
        team(handle: $handle) {
          hacktivity_items(first: ${pageSize}${afterClause}, filter: { disclosed: true }) {
            total_count
            pageInfo { endCursor hasNextPage }
            edges {
              node {
                ... on HacktivityItemInterface {
                  disclosed_at
                  severity_rating
                  report { title }
                }
              }
            }
          }
        }
      }`;

      const response = await fetch("https://hackerone.com/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { handle: programHandle } }),
      });

      if (!response.ok) break;

      const result: any = await response.json();
      const connection: any = result?.data?.team?.hacktivity_items;
      if (!connection) break;

      const edges = connection.edges ?? [];
      for (const { node } of edges) {
        if (node?.report?.title) {
          reports.push({
            title: node.report.title,
            severity: node.severity_rating ?? "unknown",
            disclosedAt: node.disclosed_at ?? "",
          });
        }
      }

      if (!connection.pageInfo?.hasNextPage || !connection.pageInfo?.endCursor) break;
      cursor = connection.pageInfo.endCursor;

      // Rate limit: 1s between pages
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    log.debug({ err, handle: programHandle, fetched: reports.length }, "Paginated disclosed report fetch failed, returning what we have");
  }

  // If pagination got nothing, fall back to the basic fetch
  if (reports.length === 0) {
    const { disclosedReports } = await fetchProgramPolicy(programHandle);
    return disclosedReports;
  }

  return reports.slice(0, limit);
}

/**
 * Strip metadata headers from the report body, keeping only the content sections.
 */
export function stripReportMetadata(reportBody: string): string {
  return reportBody
    .replace(/^\*\*Title:\*\*.*\n?/m, "")
    .replace(/^\*\*Severity:\*\*.*\n?/m, "")
    .replace(/^\*\*Vulnerability Type:\*\*.*\n?/m, "")
    .replace(/^\*\*Target Asset:\*\*.*\n?/m, "")
    .replace(/^\*\*Confidence:\*\*[^\n]*\n?/m, "")
    .trim();
}

const SEVERITY_MAP: Record<string, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  informational: "none",
};

/**
 * Fetch the full list of weaknesses (CWE types) a program accepts.
 * Returns array of { id, externalId, name } for use by the submission agent.
 */
export async function fetchProgramWeaknesses(teamHandle: string): Promise<Array<{ id: number; externalId: string; name: string }>> {
  try {
    const data = await hackerOneGet(`/hackers/programs/${teamHandle}/weaknesses`, {
      "page[size]": "100",
    });
    if (!data.data) return [];
    return data.data.map((w: any) => ({
      id: Number(w.id),
      externalId: w.attributes?.external_id ?? "",
      name: w.attributes?.name ?? "",
    }));
  } catch (err) {
    log.debug({ err, teamHandle }, "Failed to fetch weaknesses");
    return [];
  }
}

/**
 * Structured submission payload — produced by the submission agent.
 * Every field the HackerOne API accepts, filled precisely.
 */
export interface CvssVector {
  attack_vector: "network" | "adjacent" | "local" | "physical";
  attack_complexity: "low" | "high";
  privileges_required: "none" | "low" | "high";
  user_interaction: "none" | "required";
  scope: "unchanged" | "changed";
  confidentiality: "none" | "low" | "high";
  integrity: "none" | "low" | "high";
  availability: "none" | "low" | "high";
}

export interface SubmissionPayload {
  title: string;
  vulnerability_information: string;
  impact: string;
  severity_rating: "critical" | "high" | "medium" | "low" | "none";
  weakness_id?: number;
  weakness_name?: string;
  structured_scope_id?: string;
  cvss?: CvssVector;
  /** True if the submission agent detected this vuln type may be excluded by the program policy */
  policyExcluded?: boolean;
}

/**
 * Extract the "Vulnerability Information" section from a structured report body.
 * The hunt agent writes reports with explicit **Vulnerability Information:** sections.
 */
function extractVulnerabilityInfo(reportBody: string): string {
  // Try structured format: **Vulnerability Information:** ... **Impact:**
  const structuredMatch = reportBody.match(
    /\*\*Vulnerability Information:\*\*\s*([\s\S]*?)(?=\*\*Impact:\*\*|$)/,
  );
  if (structuredMatch?.[1]?.trim()) return structuredMatch[1].trim();

  // Fallback: strip metadata headers and return everything before **Impact:**
  const stripped = stripReportMetadata(reportBody);
  const beforeImpact = stripped.match(/([\s\S]*?)(?=\*\*Impact:\*\*|$)/);
  return beforeImpact?.[1]?.trim() || stripped;
}

/**
 * Extract the standalone "Impact" section from a structured report body.
 * In the HackerOne format, Impact is the last section before ===FINDING_END===.
 */
function extractImpact(reportBody: string): string {
  // New HackerOne format: **Impact:** is the last section
  const match = reportBody.match(
    /\*\*Impact:\*\*\s*([\s\S]*?)(?=={3}FINDING_END={3}|$)/,
  );
  return match?.[1]?.trim() || "";
}

/**
 * Prepare a structured HackerOne submission payload.
 *
 * The hunt agent already writes reports in HackerOne format (Vulnerability Information,
 * Impact, Steps to Reproduce, PoC, Remediation). This function:
 * 1. Extracts those sections directly from the report body (no rewriting)
 * 2. Uses Claude ONLY to select the correct weakness_id and structured_scope_id
 *    from the program's dropdown lists
 */
export async function prepareSubmission(opts: {
  teamHandle: string;
  finding: {
    title: string;
    description?: string;
    reportBody: string;
    severity: string;
    vulnerabilityType?: string;
    targetAsset?: string;
  };
  scopes: HackerOneProgramInfo["scopes"];
  policy?: string;
}): Promise<SubmissionPayload> {
  // Extract sections from the hunt agent's structured report
  const vulnInfo = extractVulnerabilityInfo(opts.finding.reportBody);
  const impact = extractImpact(opts.finding.reportBody);
  const severityRating = SEVERITY_MAP[opts.finding.severity] ?? "medium";

  if (!impact) {
    log.warn({ title: opts.finding.title }, "No Impact section found in report body — using fallback");
  }

  // Use Claude for field selection — weakness_id, scope_id, and CVSS vector
  const weaknesses = await fetchProgramWeaknesses(opts.teamHandle);
  let weaknessId: number | undefined;
  let weaknessName: string | undefined;
  let structuredScopeId: string | undefined;
  let cvss: CvssVector | undefined;
  let policyExcluded = false;

  try {
    const { runClaude, extractJsonWithKey } = await import("@bounty/core");

    const policyExcerpt = opts.policy ? opts.policy.slice(0, 2000) : "";

    const prompt = `You are selecting form fields for a HackerOne report submission. Do NOT rewrite any report content — just pick the correct values.

## Finding
**Title:** ${opts.finding.title}
**Vulnerability Type:** ${opts.finding.vulnerabilityType ?? "Not specified"}
**Target Asset:** ${opts.finding.targetAsset ?? "Not specified"}
**Severity:** ${opts.finding.severity}
**Impact Summary:** ${impact?.substring(0, 500) ?? "Not specified"}
${policyExcerpt ? `\n## Program Policy (check for exclusions)\n${policyExcerpt}\n` : ""}
## Task 0: Policy Exclusion Check
Read the program policy above. Is this vulnerability type explicitly excluded? If yes, set "policyExcluded": true in your response. Common exclusions: information disclosure, missing headers, rate limiting, clickjacking, open redirect. If no policy is provided or the type isn't excluded, set false.

## Task 1: Select the best matching IDs

### Weakness Types (pick ONE — the most specific match)
${weaknesses.length > 0
  ? weaknesses.map(w => `- ID: ${w.id} | ${w.externalId} | ${w.name}`).join("\n")
  : "No weakness list available — omit weakness_id"}

### In-Scope Assets (pick ONE — the asset this finding affects)
${opts.scopes.length > 0
  ? opts.scopes.map(s => `- ID: ${s.id} | ${s.assetType} | ${s.assetIdentifier}`).join("\n")
  : "No scope list available — omit structured_scope_id"}

## Task 2: CVSS v3.1 Vector

Based on the vulnerability, select one value per component:
- attack_vector: "network" | "adjacent" | "local" | "physical"
- attack_complexity: "low" | "high"
- privileges_required: "none" | "low" | "high"
- user_interaction: "none" | "required"
- scope: "unchanged" | "changed"
- confidentiality: "none" | "low" | "high"
- integrity: "none" | "low" | "high"
- availability: "none" | "low" | "high"

Return a JSON object:
\`\`\`json
{
  "policyExcluded": false,
  "fields": {
    "weakness_id": 123,
    "weakness_name": "CWE-327: Use of a Broken or Risky Cryptographic Algorithm",
    "structured_scope_id": "456",
    "cvss": {
      "attack_vector": "network",
      "attack_complexity": "low",
      "privileges_required": "none",
      "user_interaction": "none",
      "scope": "unchanged",
      "confidentiality": "none",
      "integrity": "high",
      "availability": "high"
    }
  }
}
\`\`\`

Omit weakness_id/structured_scope_id if no good match exists. CVSS is always required. Return ONLY the JSON.`;

    const response = await runClaude(prompt, { timeoutMs: 60_000, model: "sonnet", disableTools: true });
    const parsed = extractJsonWithKey<{ policyExcluded?: boolean; fields: {
      weakness_id?: number;
      weakness_name?: string;
      structured_scope_id?: string;
      cvss?: CvssVector;
    } }>(response, "fields");

    if (parsed?.policyExcluded) {
      policyExcluded = true;
      log.warn({ teamHandle: opts.teamHandle, title: opts.finding.title }, "Finding may be excluded by program policy — flagging for review");
    }

    if (parsed?.fields) {
      weaknessId = parsed.fields.weakness_id;
      weaknessName = parsed.fields.weakness_name;
      structuredScopeId = parsed.fields.structured_scope_id;
      cvss = parsed.fields.cvss;
    }
  } catch (err) {
    log.warn({ err, teamHandle: opts.teamHandle }, "Field selection agent failed — submitting without extra fields");
  }

  const payload: SubmissionPayload = {
    title: opts.finding.title,
    vulnerability_information: vulnInfo,
    impact: impact || "See vulnerability information above for full impact details.",
    severity_rating: severityRating as SubmissionPayload["severity_rating"],
    ...(weaknessId ? { weakness_id: weaknessId } : {}),
    ...(weaknessName ? { weakness_name: weaknessName } : {}),
    ...(structuredScopeId ? { structured_scope_id: structuredScopeId } : {}),
    ...(cvss ? { cvss } : {}),
    ...(policyExcluded ? { policyExcluded: true } : {}),
  };

  log.info({
    teamHandle: opts.teamHandle,
    title: payload.title,
    severity: payload.severity_rating,
    weaknessId: payload.weakness_id ?? null,
    scopeId: payload.structured_scope_id ?? null,
    vulnInfoLength: payload.vulnerability_information.length,
    impactLength: payload.impact.length,
  }, "Submission payload prepared");

  return payload;
}

/**
 * Submit a vulnerability report to HackerOne.
 * If the API returns a 400 error, feeds the error back to Claude to fix the payload
 * and retries once — handling custom fields, format mismatches, or unexpected requirements.
 */
export async function submitReport(opts: {
  teamHandle: string;
  payload?: SubmissionPayload;
  // Legacy fields — used if payload is not provided
  title?: string;
  reportBody?: string;
  severity?: string;
}): Promise<HackerOneSubmissionResult> {
  let attrs: Record<string, unknown>;

  if (opts.payload) {
    // Strip advisory-only fields that the API doesn't accept
    const { cvss: _cvss, weakness_name: _wn, ...apiPayload } = opts.payload;
    attrs = {
      team_handle: opts.teamHandle,
      ...apiPayload,
    };
  } else {
    const vulnInfo = stripReportMetadata(opts.reportBody ?? "");
    const severityRating = SEVERITY_MAP[opts.severity ?? "medium"] ?? "medium";
    const impactMatch = vulnInfo.match(/(?:\*\*Impact:\*\*|## Impact)\s*([\s\S]*?)(?=\*\*(?:Proof of Concept|Remediation|Summary|Vulnerability):\*\*|## (?:Proof of Concept|Remediation|Summary|Vulnerability)|$)/);
    const impact = impactMatch?.[1]?.trim() || "See vulnerability information above for full impact details.";

    attrs = {
      team_handle: opts.teamHandle,
      title: opts.title ?? "",
      vulnerability_information: vulnInfo,
      severity_rating: severityRating,
      impact,
    };
  }

  log.info({ teamHandle: opts.teamHandle, title: attrs.title }, "Submitting report to HackerOne");

  // Try submitting, auto-stripping invalid parameters on 400 errors (up to 3 attempts)
  let result: any;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await hackerOnePost("/hackers/reports", {
        data: { type: "report", attributes: attrs },
      });
      break; // Success
    } catch (err: any) {
      lastError = err;
      const errorText = err.message ?? String(err);

      // If a specific parameter is flagged as invalid, strip it and retry
      const invalidParamMatch = errorText.match(/"parameter":"(\w+)"/);
      if (invalidParamMatch) {
        const badParam = invalidParamMatch[1];
        if (badParam in attrs) {
          log.warn({ teamHandle: opts.teamHandle, removedParam: badParam, attempt }, "Stripping invalid parameter and retrying");
          delete attrs[badParam];
          continue; // Retry without the bad parameter
        }
      }

      // No auto-fixable parameter found — break out and throw
      break;
    }
  }

  if (!result) {
    throw lastError ?? new Error("Submission failed");
  }

  const reportId = result.data?.id ?? "";
  const reportUrl = result.data?.attributes?.url ?? `https://hackerone.com/reports/${reportId}`;

  log.info({ reportId, reportUrl }, "Report submitted successfully");

  return { reportId, reportUrl };
}

/**
 * Fetch a program's response efficiency percentage from HackerOne's public GraphQL API.
 * Returns a 0-1 value (e.g., 0.95 for 95% efficiency), or null on failure.
 */
export async function fetchProgramResponseEfficiency(
  programHandle: string,
): Promise<number | null> {
  const query = `query($handle: String!) {
    team(handle: $handle) {
      response_efficiency_percentage
    }
  }`;

  try {
    const response = await fetch("https://hackerone.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { handle: programHandle } }),
    });

    if (!response.ok) return null;
    const result = await response.json();
    const pct = result?.data?.team?.response_efficiency_percentage;
    if (pct == null || typeof pct !== "number") return null;
    return pct / 100;
  } catch {
    return null;
  }
}

/**
 * Check if a HackerOne program requires a minimum Signal score to submit reports.
 * Uses the public GraphQL API. Returns true if the program has signal requirements.
 */
export async function fetchProgramSignalRequirement(
  programHandle: string,
): Promise<boolean | null> {
  const query = `query($handle: String!) {
    team(handle: $handle) {
      signal_requirements_setting {
        target_signal
      }
    }
  }`;

  try {
    const response = await fetch("https://hackerone.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { handle: programHandle } }),
    });

    if (!response.ok) return null; // inconclusive — don't change existing value
    const result = await response.json();
    if (!result?.data?.team) return null; // query failed or program not found
    const targetSignal = result.data.team.signal_requirements_setting?.target_signal;
    // target_signal: null = no requirement, any number (0, -1, positive) = signal required to submit
    return targetSignal != null;
  } catch {
    return null; // inconclusive — don't change existing value
  }
}
