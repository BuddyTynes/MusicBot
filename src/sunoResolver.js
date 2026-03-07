const { spawn } = require("node:child_process");
const logger = require("./logger");

const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 45000);

function trimForLog(value, maxLength = 500) {
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    logger.info("Running yt-dlp", { args });
    const child = spawn("yt-dlp", args, { windowsHide: true });
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

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      logger.error("Failed to start yt-dlp", {
        args,
        error: logger.serializeError(error),
      });
      reject(
        new Error(
          `Failed to execute yt-dlp. Make sure it is installed and on PATH. ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        logger.error("yt-dlp timed out", {
          args,
          timeoutMs: YT_DLP_TIMEOUT_MS,
          stderr: trimForLog(stderr),
        });
        reject(new Error(`yt-dlp timed out after ${YT_DLP_TIMEOUT_MS}ms`));
        return;
      }

      if (code !== 0) {
        logger.error("yt-dlp exited with non-zero code", {
          args,
          code,
          stderr: trimForLog(stderr),
        });
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      logger.info("yt-dlp completed", {
        args,
        code,
        stdoutPreview: trimForLog(stdout),
      });
      resolve(stdout.trim());
    });
  });
}

function isSunoUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.hostname.includes("suno.com");
  } catch {
    return false;
  }
}

function normalizeTrack(entry, fallbackUrl, index) {
  const sourceUrl = entry.webpage_url || entry.url || fallbackUrl;
  return {
    title: entry.title || `Track ${index + 1}`,
    sourceUrl,
  };
}

async function extractTracksFromUrl(url) {
  logger.info("Extracting tracks from URL", { url });
  const output = await runYtDlp([
    "--dump-single-json",
    "--no-warnings",
    "--flat-playlist",
    url,
  ]);

  const data = JSON.parse(output);

  if (Array.isArray(data.entries) && data.entries.length > 0) {
    logger.info("Extracted playlist tracks", {
      url,
      count: data.entries.length,
      title: data.title,
    });
    return data.entries.map((entry, index) => normalizeTrack(entry, url, index));
  }

  logger.info("Extracted single track", {
    url,
    title: data.title || "Suno Track",
  });

  return [
    {
      title: data.title || "Suno Track",
      sourceUrl: data.webpage_url || data.url || url,
    },
  ];
}

async function resolveStreamUrl(sourceUrl) {
  logger.info("Resolving stream URL", { sourceUrl });
  const output = await runYtDlp([
    "-g",
    "--no-warnings",
    "-f",
    "bestaudio/best",
    sourceUrl,
  ]);

  const candidates = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http://") || line.startsWith("https://"));

  if (candidates.length === 0) {
    logger.error("No stream candidates returned", { sourceUrl, output: trimForLog(output) });
    throw new Error("No stream URL returned by yt-dlp.");
  }

  logger.info("Resolved stream candidate", {
    sourceUrl,
    candidateCount: candidates.length,
  });

  return candidates[candidates.length - 1];
}

module.exports = {
  isSunoUrl,
  extractTracksFromUrl,
  resolveStreamUrl,
};
