#!/usr/bin/env node
// Validate a QuickPortal config from the command line.
//
// It runs the same parser and validator the browser runs, imported from
// src/assets/config.js, so a config that passes here renders in the page and a
// config that fails here tells you why before you commit it.
//
//   node tools/validate-config.mjs examples/config/full.yaml
//   node tools/validate-config.mjs config/*.yaml
//   cat config.yaml | node tools/validate-config.mjs -
//
// Exit codes: 0 clean (warnings allowed), 1 errors found, 2 could not run.
// --strict turns warnings into a failure, which is what you want in CI.

import { readFile } from "node:fs/promises";
import process from "node:process";
import { parseConfig, normalizeConfig, indexItems } from "../src/assets/config.js";

const USAGE = `usage: validate-config.mjs [--strict] [--quiet] <file...|->

  --strict   treat warnings as failures
  --quiet    print only problems, not the summary
`;

function parseArgs(argv) {
  const files = [];
  let strict = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === "--strict") strict = true;
    else if (arg === "--quiet") quiet = true;
    else if (arg === "-h" || arg === "--help") return null;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else files.push(arg);
  }
  return files.length ? { files, strict, quiet } : null;
}

async function readSource(file) {
  if (file === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }
  return readFile(file, "utf8");
}

function printIssues(label, issues) {
  for (const issue of issues) {
    console.error(`  ${label}  ${issue.path}: ${issue.message}`);
  }
}

// A config can be valid and still be a surprise, so report the shape too: it
// is the quickest way to notice that a group you expected is missing because
// its entry was dropped.
function summarize(config) {
  let groups = 0;
  const walk = (list) => {
    for (const group of list) {
      groups += 1;
      walk(group.groups || []);
    }
  };
  walk(config.groups || []);
  const items = indexItems(config).size;
  const sets = (config.sets || []).length;
  return `${groups} group(s), ${items} item(s), ${sets} set(s)`;
}

async function validate(file, options) {
  let text;
  try {
    text = await readSource(file);
  } catch (error) {
    console.error(`${file}: cannot read: ${error.message}`);
    return 2;
  }

  const parsed = parseConfig(text);
  if (parsed.errors.length) {
    console.error(`${file}: FAILED to parse`);
    printIssues("error  ", parsed.errors);
    return 1;
  }

  const { config, errors, warnings } = normalizeConfig(parsed.raw);

  if (errors.length) printIssues("error  ", errors);
  if (warnings.length) printIssues("warning", warnings);

  if (errors.length) {
    console.error(`${file}: FAILED, ${errors.length} error(s), ${warnings.length} warning(s)`);
    return 1;
  }
  if (warnings.length && options.strict) {
    console.error(`${file}: FAILED under --strict, ${warnings.length} warning(s)`);
    return 1;
  }
  if (!options.quiet) {
    const detail = config ? summarize(config) : "nothing renderable";
    const tail = warnings.length ? `, ${warnings.length} warning(s)` : "";
    console.log(`${file}: ok, ${detail}${tail}`);
  }
  return 0;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (!options) {
    console.error(USAGE);
    process.exit(2);
  }

  let worst = 0;
  for (const file of options.files) {
    worst = Math.max(worst, await validate(file, options));
  }
  process.exit(worst);
}

main().catch((error) => {
  console.error(`validate-config: ${error.stack || error.message}`);
  process.exit(2);
});
