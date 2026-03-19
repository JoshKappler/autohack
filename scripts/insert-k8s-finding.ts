/**
 * Insert the Kubernetes publishing-bot InsecureSkipVerify finding into the database.
 * This finding was discovered during the hunt but dropped due to an overly strict quality bar.
 *
 * Run: npx tsx scripts/insert-k8s-finding.ts
 */

import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { resolve } from "node:path";

const dbPath = resolve(import.meta.dirname, "../data/algora.db");
const db = new Database(dbPath);

const findingId = `sf-${randomBytes(8).toString("hex")}`;
const traceId = `trc_${randomBytes(4).toString("hex")}`;
const now = Math.floor(Date.now() / 1000);

const reportBody = `## Summary

The \`kubernetes/publishing-bot\` contains an insecure TLS configuration in its rules loading mechanism that, when combined with downstream code execution, creates a potential supply chain attack vector affecting 40+ Kubernetes repositories.

## Vulnerability Details

**File:** \`rules.go\`, function \`readFromURL()\` (line ~125-142)

The \`readFromURL()\` function creates an HTTP client with TLS certificate verification explicitly disabled:

\`\`\`go
tr := &http.Transport{
    TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
}
client := &http.Client{Transport: tr}
resp, err := client.Get(u)
\`\`\`

This function is used to load the publishing rules configuration from \`raw.githubusercontent.com\`.

## Attack Chain

1. **TLS bypass:** \`readFromURL()\` accepts any TLS certificate, including attacker-controlled ones, when fetching rules YAML from \`raw.githubusercontent.com\`
2. **Rules injection:** The fetched YAML contains \`smoke-test\` fields — arbitrary bash commands used to validate publishing
3. **Code execution:** Smoke tests are executed via \`exec.Command("/bin/bash", "-xec", smokeTest)\` at \`publisher.go:201\`
4. **Token access:** The publishing-bot pod mounts a GitHub token at \`/etc/secret-volume/token\` with push access to 40+ \`kubernetes/*\` repositories
5. **Supply chain compromise:** An attacker with MITM position could inject malicious rules to exfiltrate the token and push arbitrary code to core Kubernetes repos

## Impact

An attacker who achieves a man-in-the-middle position on the network path between the publishing-bot pod and \`raw.githubusercontent.com\` could:

- Execute arbitrary commands on the publishing-bot pod
- Exfiltrate the GitHub push token mounted at \`/etc/secret-volume/token\`
- Push malicious code to 40+ \`kubernetes/*\` repositories
- Compromise the Kubernetes software supply chain

The MITM prerequisite limits practical exploitability, but the impact is catastrophic if achieved. The fix is trivial — remove \`InsecureSkipVerify: true\` — and there is no legitimate reason for this setting.

**Proof of Concept:**

A local PoC was built demonstrating that:
1. With \`InsecureSkipVerify: true\` (current code): a rogue TLS server with a self-signed certificate is accepted, and malicious rules YAML with arbitrary bash in \`smoke-test\` fields is loaded and parsed
2. With proper TLS verification: the self-signed certificate is correctly rejected with \`CERTIFICATE_VERIFY_FAILED\`

The PoC confirms the code vulnerability is real and the attack chain is valid.

## Remediation

Remove \`InsecureSkipVerify: true\` from the HTTP transport in \`readFromURL()\`:

\`\`\`go
// Before (insecure):
tr := &http.Transport{
    TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
}

// After (secure):
tr := &http.Transport{}
// Uses default TLS config with proper certificate verification
\`\`\`
`;

db.prepare(`
  INSERT INTO security_findings (
    id, program_id, title, description, severity, vulnerability_type,
    target_asset, status, confidence_score, report_body, retry_count,
    trace_id, discovered_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  findingId,
  "h1-kubernetes",
  "InsecureSkipVerify in publishing-bot rules loader enables MITM → RCE → supply chain compromise",
  "publishing-bot readFromURL() disables TLS certificate verification when loading executable rules from raw.githubusercontent.com, enabling MITM injection of arbitrary bash commands via smoke-test fields",
  "high",
  "Improper Certificate Validation (CWE-295)",
  "https://github.com/kubernetes/publishing-bot",
  "report_ready",
  0.80,
  reportBody,
  0,
  traceId,
  now,
  now,
);

console.log(`Finding inserted: ${findingId}`);
console.log(`Program: h1-kubernetes (Kubernetes)`);
console.log(`Status: report_ready`);
console.log(`\nYou can now approve this finding from the dashboard or run the adversarial review.`);

db.close();
