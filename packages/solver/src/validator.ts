import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@algora/core";

const execFileAsync = promisify(execFile);
const log = createLogger("validator");

interface ValidationResult {
  passed: boolean;
  testOutput?: string;
  lintOutput?: string;
  errors: string[];
}

async function tryRun(
  cmd: string,
  args: string[],
  cwd: string,
  label: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout: 300_000, // 5 min
      maxBuffer: 5 * 1024 * 1024,
    });
    return { ok: true, output: stdout + stderr };
  } catch (err: any) {
    log.warn({ label, error: err.message }, "Validation step failed");
    return { ok: false, output: err.stdout + err.stderr || err.message };
  }
}

export async function validateChanges(
  repoPath: string,
): Promise<ValidationResult> {
  const errors: string[] = [];
  let testOutput: string | undefined;
  let lintOutput: string | undefined;

  // Detect project type and run appropriate checks
  const hasPackageJson = existsSync(join(repoPath, "package.json"));
  const hasMakefile = existsSync(join(repoPath, "Makefile"));
  const hasPytest = existsSync(join(repoPath, "pytest.ini")) ||
    existsSync(join(repoPath, "pyproject.toml")) ||
    existsSync(join(repoPath, "setup.py"));
  const hasCargoToml = existsSync(join(repoPath, "Cargo.toml"));
  const hasGoMod = existsSync(join(repoPath, "go.mod"));

  // Install dependencies before running tests/lint
  if (hasPackageJson && !existsSync(join(repoPath, "node_modules"))) {
    log.info("Installing Node.js dependencies");
    const install = await tryRun("npm", ["install"], repoPath, "npm install");
    if (!install.ok) {
      log.warn("npm install failed — tests/lint may also fail");
    }
  }

  if (hasPackageJson) {
    // Try npm test
    const test = await tryRun("npm", ["test", "--if-present"], repoPath, "npm test");
    testOutput = test.output;
    if (!test.ok) errors.push("npm test failed");

    // Try npm run lint
    const lint = await tryRun(
      "npm",
      ["run", "lint", "--if-present"],
      repoPath,
      "npm lint",
    );
    lintOutput = lint.output;
    if (!lint.ok) errors.push("npm lint failed");
  } else if (hasCargoToml) {
    const test = await tryRun("cargo", ["test"], repoPath, "cargo test");
    testOutput = test.output;
    if (!test.ok) errors.push("cargo test failed");
  } else if (hasGoMod) {
    const test = await tryRun("go", ["test", "./..."], repoPath, "go test");
    testOutput = test.output;
    if (!test.ok) errors.push("go test failed");
  } else if (hasPytest) {
    // Try to install deps if requirements.txt exists
    if (existsSync(join(repoPath, "requirements.txt"))) {
      await tryRun("pip", ["install", "-r", "requirements.txt"], repoPath, "pip install");
    }
    const test = await tryRun("python", ["-m", "pytest"], repoPath, "pytest");
    testOutput = test.output;
    if (!test.ok) errors.push("pytest failed");
  } else if (hasMakefile) {
    const test = await tryRun("make", ["test"], repoPath, "make test");
    testOutput = test.output;
    if (!test.ok) errors.push("make test failed");
  }

  const passed = errors.length === 0;
  log.info({ passed, errors }, "Validation complete");

  return { passed, testOutput, lintOutput, errors };
}
