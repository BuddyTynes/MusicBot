const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TEST_URL = "https://www.youtube.com/watch?v=1KdQvhlINIk";
const COOKIE_FILE = path.resolve(__dirname, "..", "youtube-cookies.txt");
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 45000);
const YT_DLP_YOUTUBE_FORMAT = process.env.YT_DLP_YOUTUBE_FORMAT?.trim()
  || "bestaudio[protocol^=http]/bestaudio/best[protocol^=http]/best/18/worst";
const YT_DLP_YOUTUBE_FALLBACK_EXTRACTOR_ARGS = [
  null,
  process.env.YT_DLP_YOUTUBE_EXTRACTOR_ARGS?.trim() || null,
  "youtube:player_client=tv,android_vr,android,web_embedded",
  "youtube:player_client=tv,android_vr,android,web_embedded,web_safari;formats=missing_pot",
].filter((value, index, values) => values.indexOf(value) === index);
const YT_DLP_JS_RUNTIME = process.env.YT_DLP_JS_RUNTIME?.trim() || `node:${process.execPath}`;
const LIKELY_AUTH_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "__Secure-1PAPISID",
  "__Secure-3PAPISID",
  "__Secure-1PSIDTS",
  "__Secure-3PSIDTS",
  "LOGIN_INFO",
]);

function resolveYtDlpCommand() {
  if (process.env.YT_DLP_PATH) {
    return process.env.YT_DLP_PATH;
  }

  try {
    const { constants } = require("youtube-dl-exec");
    if (constants?.YOUTUBE_DL_PATH && fs.existsSync(constants.YOUTUBE_DL_PATH)) {
      return constants.YOUTUBE_DL_PATH;
    }
  } catch {
    // Fall through to PATH lookup.
  }

  return "yt-dlp";
}

function validateUtf8CookieFile(cookieFile) {
  const bytes = fs.readFileSync(cookieFile);
  if (bytes.length === 0) {
    throw new Error(`${path.basename(cookieFile)} is empty.`);
  }

  const hasUtf16Bom =
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  const hasNulByteNearStart = bytes.subarray(0, Math.min(bytes.length, 32)).includes(0);

  if (hasUtf16Bom || hasNulByteNearStart) {
    throw new Error(
      `${path.basename(cookieFile)} is not UTF-8. Regenerate it with yt-dlp's YouTube cookie export instructions: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies`,
    );
  }
}

function parseCookieFile(cookieFile) {
  const rows = fs
    .readFileSync(cookieFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 7)
    .map((parts) => ({
      domain: parts[0].replace(/^#HttpOnly_/, ""),
      secure: parts[3] === "TRUE",
      expires: parts[4],
      name: parts[5],
    }));

  return rows;
}

function summarizeCookieFile(cookieFile) {
  const rows = parseCookieFile(cookieFile);
  const domains = [...new Set(rows.map((row) => row.domain))].sort();
  const presentAuthNames = [...new Set(
    rows
      .map((row) => row.name)
      .filter((name) => LIKELY_AUTH_COOKIE_NAMES.has(name)),
  )].sort();
  const hasSidLike = presentAuthNames.some((name) => name === "SID" || name.endsWith("PSID"));
  const hasApisidLike = presentAuthNames.some((name) => name === "SAPISID" || name.endsWith("PAPISID"));
  const hasSecureAuth = presentAuthNames.some((name) => name.startsWith("__Secure-"));

  console.log(`cookie rows: ${rows.length}`);
  console.log(`cookie domains: ${domains.length ? domains.join(", ") : "none"}`);
  console.log(`likely auth cookie names present: ${presentAuthNames.length ? presentAuthNames.join(", ") : "none"}`);

  if (rows.length < 20) {
    console.log("WARN: cookie file has fewer than 20 rows; incomplete manual copies often fail YouTube bot checks.");
  }
  if (!hasSidLike || !hasApisidLike) {
    console.log("WARN: cookie file appears to be missing SID/SAPISID-style Google auth cookies.");
  }
  if (!hasSecureAuth) {
    console.log("WARN: cookie file has no __Secure-* auth cookies; YouTube may reject this session.");
  }
}

function getCookieArgs() {
  if (fs.existsSync(COOKIE_FILE)) {
    validateUtf8CookieFile(COOKIE_FILE);
    summarizeCookieFile(COOKIE_FILE);
    return {
      source: COOKIE_FILE,
      args: ["--cookies", COOKIE_FILE],
    };
  }

  if (process.env.YT_DLP_COOKIES_FROM_BROWSER?.trim()) {
    return {
      source: `browser:${process.env.YT_DLP_COOKIES_FROM_BROWSER.trim()}`,
      args: ["--cookies-from-browser", process.env.YT_DLP_COOKIES_FROM_BROWSER.trim()],
    };
  }

  return { source: "none", args: [] };
}

function getRuntimeArgs() {
  return YT_DLP_JS_RUNTIME ? ["--js-runtimes", YT_DLP_JS_RUNTIME] : [];
}

function trim(value, maxLength = 1200) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

function explainCookieRejection(errorMessage) {
  if (!/sign in to confirm|use --cookies/i.test(errorMessage)) {
    return;
  }

  console.log("");
  console.log("Cookie file was passed to yt-dlp, but YouTube did not accept it as an authenticated session.");
  console.log("Regenerate youtube-cookies.txt from a browser session that is logged into YouTube and can play the same video.");
  console.log("Make sure the export includes all YouTube/Google auth rows, not only LOGIN_INFO.");
}

function runYtDlp(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, YT_DLP_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        reject(new Error(`yt-dlp timed out after ${YT_DLP_TIMEOUT_MS}ms`));
        return;
      }

      if (code !== 0) {
        reject(new Error(trim(stderr.trim() || `yt-dlp exited with code ${code}`)));
        return;
      }

      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function runMetadataCheck(command, cookie, testUrl) {
  const args = [
    ...cookie.args,
    ...getRuntimeArgs(),
    "--skip-download",
    "--no-playlist",
    "--ignore-no-formats-error",
    "--print",
    "%(extractor)s\t%(id)s\t%(title)s\t%(duration_string)s",
    testUrl,
  ];

  const result = await runYtDlp(command, args);
  console.log(`metadata OK: ${result.stdout}`);
  if (result.stderr) {
    console.log(`metadata stderr: ${trim(result.stderr)}`);
  }
}

async function runStreamCheck(command, cookie, testUrl) {
  let lastError = null;
  for (const extractorArgs of YT_DLP_YOUTUBE_FALLBACK_EXTRACTOR_ARGS) {
    const args = [
      ...cookie.args,
      ...getRuntimeArgs(),
      "-g",
      "--no-playlist",
      "--no-check-formats",
      "-f",
      YT_DLP_YOUTUBE_FORMAT,
    ];

    if (extractorArgs) {
      args.push("--extractor-args", extractorArgs);
    }

    args.push(testUrl);

    try {
      const result = await runYtDlp(command, args);
      const urls = result.stdout.split(/\r?\n/).filter((line) => /^https?:\/\//.test(line));
      console.log(`stream OK: ${urls.length} URL(s) using format ${YT_DLP_YOUTUBE_FORMAT}`);
      console.log(`stream extractor args: ${extractorArgs || "default"}`);
      if (result.stderr) {
        console.log(`stream stderr: ${trim(result.stderr)}`);
      }
      return;
    } catch (error) {
      lastError = error;
      console.log(`stream attempt failed (${extractorArgs || "default"}): ${error.message}`);
    }
  }

  await listFormats(command, cookie, testUrl);
  throw lastError || new Error("No stream attempt succeeded.");
}

async function listFormats(command, cookie, testUrl) {
  const args = [
    ...cookie.args,
    ...getRuntimeArgs(),
    "--list-formats",
    "--no-playlist",
    "--ignore-no-formats-error",
    testUrl,
  ];

  try {
    const result = await runYtDlp(command, args);
    console.log(`available formats:\n${trim(result.stdout, 2500)}`);
  } catch (error) {
    console.log(`could not list formats: ${error.message}`);
  }
}

async function main() {
  const testUrl = process.argv[2] || DEFAULT_TEST_URL;
  const command = resolveYtDlpCommand();
  const cookie = getCookieArgs();

  console.log(`yt-dlp: ${command}`);
  console.log(`cookie source: ${cookie.source}`);
  console.log(`js runtime: ${YT_DLP_JS_RUNTIME || "yt-dlp default"}`);
  console.log(`test url: ${testUrl}`);

  await runMetadataCheck(command, cookie, testUrl);
  await runStreamCheck(command, cookie, testUrl);
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  explainCookieRejection(error.message);
  process.exit(1);
});
