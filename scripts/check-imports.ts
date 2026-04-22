// @ts-nocheck

const fs = require("node:fs");
const path = require("node:path");
const { builtinModules } = require("node:module");

const ROOT = process.cwd();
const SRC_DIRECTORY = path.join(ROOT, "src");

const COMPONENT_DIRECTORIES = ["auth", "gateway", "engine", "memory", "adapters", "config"];
const COMPONENT_SET = new Set(COMPONENT_DIRECTORIES);
const SHARED_DIRECTORIES = new Set(["types"]);

const ALLOWED_COMPONENT_DEPENDENCIES = {
  auth: new Set(["auth", "types"]),
  gateway: new Set(["gateway", "types"]),
  engine: new Set(["engine", "types"]),
  memory: new Set(["memory", "types"]),
  adapters: new Set(["adapters", "types"]),
  config: new Set(["config", "types"])
};

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((value) => value.replace(/^node:/, ""))
]);

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function collectTypeScriptFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  const queue = [directory];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function parseImportSpecifiers(source) {
  const specifiers = [];
  const importFrom = /\bimport\s+[^"'`]*\sfrom\s*["']([^"']+)["']/g;
  const importBare = /\bimport\s*["']([^"']+)["']/g;
  const importDynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  const requireCall = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

  for (const regex of [importFrom, importBare, importDynamic, requireCall]) {
    let match = regex.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = regex.exec(source);
    }
  }

  return specifiers;
}

function ownerDirectoryForFile(filePath) {
  const relativeToSrc = toPosixPath(path.relative(SRC_DIRECTORY, filePath));
  return relativeToSrc.split("/")[0];
}

function componentForResolvedPath(resolvedPath) {
  const relativeToSrc = toPosixPath(path.relative(SRC_DIRECTORY, resolvedPath));
  if (relativeToSrc.startsWith("../")) {
    return null;
  }
  return relativeToSrc.split("/")[0];
}

function isComponentLike(ownerDirectory) {
  return COMPONENT_SET.has(ownerDirectory);
}

function runImportBoundaryCheck() {
  const errors = [];
  const files = collectTypeScriptFiles(SRC_DIRECTORY);

  for (const filePath of files) {
    const ownerDirectory = ownerDirectoryForFile(filePath);
    if (!isComponentLike(ownerDirectory)) {
      continue;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const specifiers = parseImportSpecifiers(source);

    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) {
        continue;
      }

      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const targetComponent = componentForResolvedPath(resolved);

        if (!targetComponent) {
          errors.push(
            `Forbidden import in ${toPosixPath(path.relative(ROOT, filePath))}: "${specifier}" resolves outside src/.`
          );
          continue;
        }

        if (SHARED_DIRECTORIES.has(targetComponent)) {
          continue;
        }

        const allowedTargets = ALLOWED_COMPONENT_DEPENDENCIES[ownerDirectory] ?? new Set([ownerDirectory]);
        if (!allowedTargets.has(targetComponent)) {
          errors.push(
            `Forbidden component coupling in ${toPosixPath(
              path.relative(ROOT, filePath)
            )}: "${specifier}" targets "${targetComponent}".`
          );
        }
        continue;
      }

      if (specifier.startsWith("/")) {
        errors.push(
          `Forbidden absolute import in ${toPosixPath(path.relative(ROOT, filePath))}: "${specifier}".`
        );
        continue;
      }

      if (!NODE_BUILTINS.has(specifier)) {
        errors.push(
          `Forbidden package import in ${toPosixPath(path.relative(ROOT, filePath))}: "${specifier}". Use local components/types only.`
        );
        continue;
      }

    }
  }

  return errors;
}

function reportFailure(errors) {
  console.error("Import boundary check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
}

function main() {
  const errors = runImportBoundaryCheck();
  if (errors.length > 0) {
    reportFailure(errors);
    return 1;
  }

  console.log("Import boundary check passed.");
  return 0;
}

if (require.main === module) {
  const exitCode = main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

module.exports = {
  runImportBoundaryCheck
};
