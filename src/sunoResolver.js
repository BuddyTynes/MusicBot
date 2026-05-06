const { spawn } = require("node:child_process");
const https = require("node:https");
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

function isValidUrl(input) {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const SUNO_PLAYLIST_UUID_RE = /\/playlist\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on("error", reject);
  });
}

// Resolve a Suno short URL (/s/<id>) to a full song UUID by following the redirect.
async function resolveSunoShortUrl(url) {
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith("/s/")) return url;
  const { status, headers } = await httpsGet(url);
  if ((status === 301 || status === 302 || status === 307 || status === 308) && headers.location) {
    const resolved = new URL(headers.location, "https://suno.com");
    logger.info("Resolved Suno short URL", { original: url, resolved: resolved.href });
    return resolved.href;
  }
  return url;
}

async function extractSunoPlaylist(url) {
  const match = SUNO_PLAYLIST_UUID_RE.exec(url);
  if (!match) return null;

  const playlistId = match[1];
  logger.info("Fetching Suno playlist via API", { playlistId });

  const { status, body } = await httpsGet(
    `https://studio-api.prod.suno.com/api/playlist/${playlistId}`
  );

  if (status !== 200) {
    logger.warn("Suno playlist API returned non-200", { playlistId, status });
    return null;
  }

  const data = JSON.parse(body);
  const clips = data.playlist_clips;
  if (!Array.isArray(clips) || clips.length === 0) return null;

  const tracks = clips
    .filter((c) => c.clip?.audio_url && c.clip?.id)
    .map((c) => ({
      title: c.clip.title || c.clip.id,
      sourceUrl: `https://suno.com/song/${c.clip.id}`,
    }));

  logger.info("Extracted Suno playlist tracks", {
    playlistId,
    name: data.name,
    count: tracks.length,
  });

  return tracks;
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

  // Suno playlists need the studio API — yt-dlp only gets the first track as silence
  if (isSunoUrl(url) && SUNO_PLAYLIST_UUID_RE.test(url)) {
    const tracks = await extractSunoPlaylist(url);
    if (tracks && tracks.length > 0) return tracks;
    // Fall through to yt-dlp if API fails
  }

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

const SUNO_SONG_UUID_RE = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

async function resolveStreamUrl(sourceUrl) {
  logger.info("Resolving stream URL", { sourceUrl });

  // Suno CDN URLs follow a predictable pattern: cdn1.suno.ai/<uuid>.mp3
  // yt-dlp cannot render Suno's JS and returns a silence placeholder instead.
  // Extract the UUID directly from the song URL when available.
  const sunoMatch = SUNO_SONG_UUID_RE.exec(sourceUrl);
  if (sunoMatch) {
    const cdnUrl = `https://cdn1.suno.ai/${sunoMatch[1]}.mp3`;
    logger.info("Resolved Suno CDN URL directly", { sourceUrl, cdnUrl });
    return cdnUrl;
  }

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

async function fetchRadioTracks(count = 10) {
  logger.info("Fetching Suno trending for radio", { count });
  const { status, body } = await httpsGet("https://studio-api.prod.suno.com/api/trending/");
  if (status !== 200) throw new Error(`Suno trending API returned ${status}`);

  const clips = JSON.parse(body).playlist_clips ?? [];
  const valid = clips.filter((c) => c.clip?.id && c.clip?.title);

  const shuffled = valid.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map((c) => ({
    title: c.clip.title,
    sourceUrl: `https://suno.com/song/${c.clip.id}`,
  }));
}

async function fetchRadioSongTracks(songUrl, count = 10) {
  // Resolve short URLs (/s/<id>) to full song URLs first
  const resolvedUrl = await resolveSunoShortUrl(songUrl);

  // Extract UUID from the song URL
  const match = SUNO_SONG_UUID_RE.exec(resolvedUrl);
  if (!match) throw new Error("Could not extract a Suno song ID from that URL.");
  const songId = match[1];

  // Fetch the seed song's metadata to get its tags
  logger.info("Fetching seed song metadata for radio-song", { songId });
  const { status, body } = await httpsGet(`https://studio-api.prod.suno.com/api/clip/${songId}`);
  if (status !== 200) throw new Error(`Could not fetch song metadata (HTTP ${status}).`);

  const clip = JSON.parse(body);
  const rawTags = clip.metadata?.tags ?? "";
  const seedTags = rawTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  logger.info("Seed song tags", { songId, title: clip.title, seedTags });

  // Fetch the trending pool
  const { status: ts, body: tb } = await httpsGet("https://studio-api.prod.suno.com/api/trending/");
  if (ts !== 200) throw new Error(`Suno trending API returned ${ts}`);

  const allClips = (JSON.parse(tb).playlist_clips ?? [])
    .filter((c) => c.clip?.id && c.clip?.title && c.clip.id !== songId);

  let pool = allClips;

  // If the seed song has tags, prefer clips that share at least one tag
  if (seedTags.length > 0) {
    const matched = allClips.filter((c) => {
      const clipTags = (c.clip.metadata?.tags ?? "")
        .split(",")
        .map((t) => t.trim().toLowerCase());
      return clipTags.some((t) => seedTags.includes(t));
    });
    // Use tag-matched pool if it has enough songs, otherwise fall back to full pool
    if (matched.length >= Math.min(count, 3)) pool = matched;
  }

  const shuffled = pool.sort(() => Math.random() - 0.5);
  const tracks = shuffled.slice(0, count).map((c) => ({
    title: c.clip.title,
    sourceUrl: `https://suno.com/song/${c.clip.id}`,
  }));

  return { tracks, seedTitle: clip.title, seedTags };
}

module.exports = {
  isSunoUrl,
  isValidUrl,
  extractTracksFromUrl,
  resolveStreamUrl,
  fetchRadioTracks,
  fetchRadioSongTracks,
};
