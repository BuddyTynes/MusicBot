const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TEST_URL = "https://www.youtube.com/watch?v=1KdQvhlINIk";
const COOKIE_FILE = path.resolve(__dirname, "..", "youtube-cookies.txt");
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 45000);

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
      `${path.basename(cookieFile)} is not UTF-8. Regenerate it with: node tools/convertChromeCookies.js chrome-cookies.tsv youtube-cookies.txt`,
    );
  }
}

function getCookieArgs() {
  if (fs.existsSync(COOKIE_FILE)) {
    validateUtf8CookieFile(COOKIE_FILE);
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

function trim(value, maxLength = 1200) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

async function main() {
  const testUrl = process.argv[2] || DEFAULT_TEST_URL;
  const command = resolveYtDlpCommand();
  const cookie = getCookieArgs();
  const args = [
    ...cookie.args,
    "--no-warnings",
    "--skip-download",
    "--no-playlist",
    "--print",
    "%(extractor)s\t%(id)s\t%(title)s\t%(duration_string)s",
    testUrl,
  ];

  console.log(`yt-dlp: ${command}`);
  console.log(`cookie source: ${cookie.source}`);
  console.log(`test url: ${testUrl}`);

  await new Promise((resolve, reject) => {
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

      console.log(`OK: ${stdout.trim()}`);
      if (stderr.trim()) {
        console.log(`stderr: ${trim(stderr.trim())}`);
      }
      resolve();
    });
  });
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
