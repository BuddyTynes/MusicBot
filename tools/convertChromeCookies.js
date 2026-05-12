const fs = require("node:fs");

function usage() {
  return [
    "Usage:",
    "  node tools/convertChromeCookies.js <chrome-cookies.tsv> <youtube-cookies.txt>",
    "  node tools/convertChromeCookies.js <chrome-cookies.tsv> --output <youtube-cookies.txt>",
    "  Get-Content .\\chrome-cookies.tsv | node tools\\convertChromeCookies.js",
    "",
    "Input should be rows copied from Chrome DevTools Application > Cookies.",
  ].join("\n");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const outputFlagIndex = args.findIndex((arg) => arg === "--output" || arg === "-o");
  let outputFile = null;

  if (outputFlagIndex !== -1) {
    outputFile = args[outputFlagIndex + 1];
    args.splice(outputFlagIndex, 2);
  }

  return {
    inputFile: args[0] || null,
    outputFile: outputFile || args[1] || null,
  };
}

function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new Error("UTF-16 big-endian input is not supported. Save the input as UTF-8 or UTF-16 LE.");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

function readInput(inputFile) {
  if (inputFile) {
    return decodeText(fs.readFileSync(inputFile));
  }

  if (process.stdin.isTTY) {
    console.error(usage());
    process.exit(1);
  }

  return decodeText(fs.readFileSync(0));
}

function boolFromCell(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "1" ||
    normalized === "\u2713" ||
    normalized === "\u221a" ||
    normalized.includes("check")
  );
}

function expiryToUnix(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /^session$/i.test(trimmed)) {
    return "0";
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return "0";
  }

  return String(Math.floor(parsed / 1000));
}

function parseRows(input) {
  return input
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

function isHeader(row) {
  return row[0]?.trim().toLowerCase() === "name" && row[1]?.trim().toLowerCase() === "value";
}

function toNetscapeLine(row) {
  const [name, value, rawDomain, rawPath, rawExpires, , rawHttpOnly, rawSecure] = row;
  if (!name || !rawDomain || !rawPath) {
    return null;
  }

  const httpOnly = boolFromCell(rawHttpOnly);
  const secure = boolFromCell(rawSecure);
  const domain = rawDomain.trim();
  const netscapeDomain = `${httpOnly ? "#HttpOnly_" : ""}${domain}`;
  const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
  const path = rawPath.trim() || "/";
  const expires = expiryToUnix(rawExpires);

  return [
    netscapeDomain,
    includeSubdomains,
    path,
    secure ? "TRUE" : "FALSE",
    expires,
    name,
    value || "",
  ].join("\t");
}

const { inputFile, outputFile } = parseArgs();
const rows = parseRows(readInput(inputFile)).filter((row) => !isHeader(row));
const cookieLines = rows.map(toNetscapeLine).filter(Boolean);

if (cookieLines.length === 0) {
  console.error("No cookie rows were converted. Make sure the input is tab-separated Chrome cookie rows.");
  process.exit(1);
}

const output = ["# Netscape HTTP Cookie File", ...cookieLines, ""].join("\n");

if (outputFile) {
  fs.writeFileSync(outputFile, output, "utf8");
  console.log(`Wrote ${cookieLines.length} cookie row(s) to ${outputFile} as UTF-8.`);
} else {
  process.stdout.write(output);
}
