// @ts-nocheck

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = process.cwd();
const LOCK_FILE = "paa.lock.json";

function readLock(errors) {
  const lockPath = path.join(ROOT, LOCK_FILE);
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (error) {
    errors.push(`Unable to read ${LOCK_FILE}: ${error.message}`);
    return null;
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(directory, fullPath).split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

function checkRemotePin(lock, errors) {
  try {
    const output = execFileSync("git", ["ls-remote", lock.repository, `refs/heads/${lock.ref}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    const remoteCommit = output.split(/\s+/)[0];
    if (remoteCommit !== lock.commit) {
      const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "paa-remote-contracts-"));
      try {
        execFileSync("git", ["init", "--bare", "-q", checkout], { stdio: "pipe" });
        execFileSync("git", ["-C", checkout, "fetch", "--quiet", "--depth=1", lock.repository, `refs/heads/${lock.ref}`], { stdio: "pipe" });
        for (const file of lock.contract_files) {
          const content = execFileSync("git", ["-C", checkout, "show", `FETCH_HEAD:${file}`], { stdio: "pipe" });
          const digest = crypto.createHash("sha256").update(content).digest("hex");
          if (digest !== lock.sha256[file]) {
            errors.push(`PAA ${lock.ref} changed ${file} after pinned ${lock.commit}; repin contracts intentionally.`);
          }
        }
      } finally {
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    }
  } catch (error) {
    errors.push(`Unable to verify remote PAA pin: ${error.message}`);
  }
}

function runPaaPinCheck({ remote = false } = {}) {
  const errors = [];
  const lock = readLock(errors);
  if (!lock) {
    return errors;
  }

  if (!/^https:\/\/github\.com\/Personal-AI-Architecture\/the-architecture\.git$/.test(lock.repository)) {
    errors.push("paa.lock.json repository must point to the PAA architecture repository.");
  }
  if (lock.ref !== "main") {
    errors.push("paa.lock.json ref must remain main unless the pin policy is intentionally changed.");
  }
  if (!/^[0-9a-f]{40}$/.test(lock.commit)) {
    errors.push("paa.lock.json commit must be a full 40-character commit SHA.");
  }
  if (lock.source_root !== "vendor/paa-contracts") {
    errors.push("paa.lock.json source_root must be vendor/paa-contracts.");
  }

  const files = Array.isArray(lock.contract_files) ? lock.contract_files : [];
  const expected = [...files].sort();
  const actual = listFiles(path.join(ROOT, lock.source_root || ""));
  if (actual.join("\n") !== expected.join("\n")) {
    errors.push(
      `Vendored PAA contract file set drift. Expected: ${expected.join(", ")}. Found: ${
        actual.join(", ") || "<none>"
      }.`
    );
  }

  for (const relativeFile of files) {
    const vendorRelative = path.join(lock.source_root, relativeFile);
    const vendorPath = path.join(ROOT, vendorRelative);
    const localPath = path.join(ROOT, relativeFile);
    if (!fs.existsSync(vendorPath)) {
      errors.push(`Missing vendored PAA contract: ${vendorRelative}`);
      continue;
    }
    const expectedHash = lock.sha256?.[relativeFile];
    const actualHash = sha256(vendorPath);
    if (actualHash !== expectedHash) {
      errors.push(`Vendored PAA contract hash drift: ${vendorRelative}`);
    }
    if (!fs.existsSync(localPath)) {
      errors.push(`Missing local contract mirror: ${relativeFile}`);
      continue;
    }
    if (!fs.readFileSync(vendorPath).equals(fs.readFileSync(localPath))) {
      errors.push(`Local contract differs from pinned PAA source: ${relativeFile}`);
    }
  }

  if (remote && errors.length === 0) {
    checkRemotePin(lock, errors);
  }

  return errors;
}

function main() {
  const remote = process.argv.includes("--remote");
  const errors = runPaaPinCheck({ remote });
  if (errors.length > 0) {
    console.error("PAA pin check failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }
  console.log(`PAA pin check passed (${remote ? "local + remote" : "local"}).`);
}

if (require.main === module) {
  main();
}

module.exports = { runPaaPinCheck };
