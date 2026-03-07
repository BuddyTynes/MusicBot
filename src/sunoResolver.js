const { spawn } = require("node:child_process");

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(
        new Error(
          `Failed to execute yt-dlp. Make sure it is installed and on PATH. ${error.message}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
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
  const output = await runYtDlp([
    "--dump-single-json",
    "--no-warnings",
    "--flat-playlist",
    url,
  ]);

  const data = JSON.parse(output);

  if (Array.isArray(data.entries) && data.entries.length > 0) {
    return data.entries.map((entry, index) => normalizeTrack(entry, url, index));
  }

  return [
    {
      title: data.title || "Suno Track",
      sourceUrl: data.webpage_url || data.url || url,
    },
  ];
}

async function resolveStreamUrl(sourceUrl) {
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
    throw new Error("No stream URL returned by yt-dlp.");
  }

  return candidates[candidates.length - 1];
}

module.exports = {
  isSunoUrl,
  extractTracksFromUrl,
  resolveStreamUrl,
};
