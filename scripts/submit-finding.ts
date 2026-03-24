import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
process.env.PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

import { getDb, schema, loadConfig } from "@bounty/core";
import { eq } from "drizzle-orm";

async function main() {
  loadConfig();
  const db = getDb();

  const FINDING_ID = "sf-5e654a54f52a5d9f";

  // Read current report body
  const finding = db
    .select({ reportBody: schema.securityFindings.reportBody })
    .from(schema.securityFindings)
    .where(eq(schema.securityFindings.id, FINDING_ID))
    .get();

  if (!finding?.reportBody) {
    console.error(`Finding ${FINDING_ID} not found or has no report body`);
    process.exit(1);
  }

  let reportBody = finding.reportBody;

  // 1. Add ECDH severity note after the Secondary Vector code block in Vulnerability Details
  reportBody = reportBody.replace(
    "This allows spoofing the connection response (injecting a fake wallet address and ECDH public key).",
    "This allows spoofing the connection response (injecting a fake wallet address and ECDH public key).\n\nCritically, the spoofed `providerPublicKey` from the unvalidated `PRIVY_CROSS_APP_CONNECT_RESPONSE` is used directly in `recoverSharedSecret` for ECDH key derivation. An attacker who injects their own public key controls the derived shared secret, making **all subsequent encrypted MWP transactions for that session readable, forgeable, and replayable** by the attacker."
  );

  // 2. Enhance Attack 3 step 5 with ECDH compromise detail
  reportBody = reportBody.replace(
    "5. The dapp displays the attacker's address as the connected wallet.",
    "5. The dapp displays the attacker's address as the connected wallet.\n6. Because the attacker's `providerPublicKey` is used in `recoverSharedSecret` for ECDH shared secret derivation, the attacker now controls the encryption key for all subsequent MWP transactions — they can decrypt, modify, and re-encrypt any transaction data sent through the cross-app channel."
  );

  // 3. Add point (4) to the Impact section
  reportBody = reportBody.replace(
    "The attack requires only a single `postMessage` call from any cross-origin context",
    "In MWP mode, connection spoofing additionally compromises the ECDH shared secret — the attacker's injected public key is used in `recoverSharedSecret`, giving them full ability to decrypt, forge, and replay all subsequent encrypted cross-app transactions for the duration of the session. The attack requires only a single `postMessage` call from any cross-origin context"
  );

  // Update the finding in the database
  db.update(schema.securityFindings)
    .set({
      reportBody,
      status: "report_ready",
      updatedAt: new Date(),
    })
    .where(eq(schema.securityFindings.id, FINDING_ID))
    .run();

  console.log(`Updated ${FINDING_ID}:`);
  console.log("  - Added ECDH shared secret compromise to Secondary Vector details");
  console.log("  - Added ECDH compromise step to Attack 3 reproduction");
  console.log("  - Added MWP ECDH impact to Impact section");
  console.log("  - Status set to report_ready");
}

main();
