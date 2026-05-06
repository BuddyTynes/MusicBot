const { spawn } = require("node:child_process");
const https = require("node:https");
const logger = require("./logger");

const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS || 45000);
const SUNO_API_BASE = "https://studio-api.prod.suno.com";
const SUNO_PROFILE_PAGE_SIZE = 20;
const SUNO_MAX_PLAYLIST_TRACKS = Math.max(1, Number(process.env.SUNO_MAX_PLAYLIST_TRACKS) || 1000);
const SUNO_DEFAULT_PROFILE_TRACKS = Math.max(1, Number(process.env.SUNO_DEFAULT_PROFILE_TRACKS) || 25);
const SUNO_MAX_PROFILE_TRACKS = Math.max(1, Number(process.env.SUNO_MAX_PROFILE_TRACKS) || 500);

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
const SUNO_PROFILE_PATH_RE = /\/@([a-z0-9_]{3,30})(?:[/?#]|$)/i;
const SUNO_HANDLE_RE = /^@?([a-z0-9_]{3,30})$/i;

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on("error", reject);
  });
}

function httpsPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request(
      parsed,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "Mozilla/5.0",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      },
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function clampPositiveInt(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function parseJsonResponse(body, context) {
  try {
    return JSON.parse(body);
  } catch (error) {
    logger.error("Failed to parse JSON response", {
      context,
      bodyPreview: trimForLog(body),
      error: logger.serializeError(error),
    });
    throw new Error(`Could not parse ${context} response.`);
  }
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

function getClipFromEntry(entry) {
  if (!entry) return null;
  return entry.clip || entry.content_item?.clip || entry.content_item || entry.contentItem?.clip || entry.contentItem || entry;
}

function trackFromClip(clip, index) {
  if (!clip?.id) return null;
  return {
    title: clip.title || `Suno Track ${index + 1}`,
    sourceUrl: `https://suno.com/song/${clip.id}`,
  };
}

function addClipTracks(entries, tracks, seenIds) {
  let added = 0;
  for (const entry of entries) {
    const clip = getClipFromEntry(entry);
    if (!clip?.id || seenIds.has(clip.id)) continue;
    const track = trackFromClip(clip, tracks.length);
    if (!track) continue;
    seenIds.add(clip.id);
    tracks.push(track);
    added += 1;
  }
  return added;
}

async function extractSunoPlaylist(url) {
  const match = SUNO_PLAYLIST_UUID_RE.exec(url);
  if (!match) return null;

  const playlistId = match[1];
  const maxTracks = clampPositiveInt(SUNO_MAX_PLAYLIST_TRACKS, 1000, 5000);
  const tracks = [];
  const seenIds = new Set();
  let nextCursor = null;
  let currentPage = 1;
  let playlistName = null;
  let totalResults = null;

  logger.info("Fetching Suno playlist via API", { playlistId, maxTracks });

  do {
    const requestUrl = new URL(`${SUNO_API_BASE}/api/playlist/${playlistId}`);
    if (nextCursor) {
      requestUrl.searchParams.set("cursor", nextCursor);
    } else {
      requestUrl.searchParams.set("page", String(currentPage));
    }

    const { status, body } = await httpsGet(requestUrl.href);

    if (status !== 200) {
      logger.warn("Suno playlist API returned non-200", {
        playlistId,
        status,
        currentPage,
      });
      return tracks.length > 0 ? tracks : null;
    }

    const data = parseJsonResponse(body, "Suno playlist");
    const clips = Array.isArray(data.playlist_clips) ? data.playlist_clips : [];
    if (!playlistName) playlistName = data.name;
    totalResults = data.num_total_results ?? totalResults;

    const added = addClipTracks(clips, tracks, seenIds);
    logger.info("Fetched Suno playlist page", {
      playlistId,
      currentPage: data.current_page || currentPage,
      added,
      runningCount: tracks.length,
      totalResults,
    });

    nextCursor = data.next_cursor || null;
    currentPage += 1;
    if (tracks.length >= maxTracks) {
      tracks.length = maxTracks;
      break;
    }
    if (clips.length === 0 || added === 0) {
      break;
    }
  } while (nextCursor);

  if (tracks.length === 0) return null;

  logger.info("Extracted Suno playlist tracks", {
    playlistId,
    name: playlistName,
    count: tracks.length,
    totalResults,
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

function getSunoProfileHandle(input) {
  if (!input) return null;

  const trimmed = input.trim();
  if (isValidUrl(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname.includes("suno.com")) return null;
      const match = SUNO_PROFILE_PATH_RE.exec(parsed.pathname);
      return match ? match[1].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  const handleMatch = SUNO_HANDLE_RE.exec(trimmed);
  return handleMatch ? handleMatch[1].toLowerCase() : null;
}

function isSunoProfileInput(input) {
  return Boolean(getSunoProfileHandle(input));
}

function getProfileTrackCount(count) {
  if (String(count).toLowerCase() === "all") {
    return clampPositiveInt(SUNO_MAX_PROFILE_TRACKS, 500, 5000);
  }
  return clampPositiveInt(count, SUNO_DEFAULT_PROFILE_TRACKS, SUNO_MAX_PROFILE_TRACKS);
}

function getProfileSortKey(sort) {
  return sort === "top" ? "upvote_count" : "created_at";
}

async function fetchSunoProfileTracks(input, options = {}) {
  const handle = getSunoProfileHandle(input);
  if (!handle) {
    throw new Error("Could not find a Suno profile handle in that input.");
  }

  const count = getProfileTrackCount(options.count);
  const sortKey = getProfileSortKey(options.sort);
  const tracks = [];
  const seenIds = new Set();

  logger.info("Fetching Suno profile", { handle, count, sortKey });

  const profileUrl = new URL(`${SUNO_API_BASE}/api/profiles/${handle}`);
  profileUrl.searchParams.set("playlists_sort_by", "created_at");
  profileUrl.searchParams.set("clips_sort_by", sortKey);

  const { status, body } = await httpsGet(profileUrl.href);
  if (status !== 200) {
    logger.warn("Suno profile API returned non-200", { handle, status });
    throw new Error(`Could not fetch Suno profile @${handle} (HTTP ${status}).`);
  }

  const profile = parseJsonResponse(body, "Suno profile");
  if (!profile.user_id) {
    throw new Error(`Could not resolve Suno profile @${handle}.`);
  }

  let nextCursor = null;
  do {
    const pageSize = Math.min(SUNO_PROFILE_PAGE_SIZE, count - tracks.length);
    const requestBody = {
      feed_id: "user_songs",
      target_user_id: profile.user_id,
      request_metadata: { sort_by: sortKey },
      page_size: pageSize,
    };
    if (nextCursor) {
      requestBody.cursor = nextCursor;
    }

    const { status: feedStatus, body: feedBody } = await httpsPostJson(
      `${SUNO_API_BASE}/api/unified/feed`,
      requestBody,
    );

    if (feedStatus !== 200) {
      logger.warn("Suno profile feed API returned non-200", {
        handle,
        status: feedStatus,
        nextCursor,
      });
      break;
    }

    const data = parseJsonResponse(feedBody, "Suno profile feed");
    const feed = data.feed || {};
    const items = Array.isArray(feed.items) ? feed.items : [];
    const added = addClipTracks(items, tracks, seenIds);

    logger.info("Fetched Suno profile songs page", {
      handle,
      added,
      runningCount: tracks.length,
      nextCursor: feed.next_cursor || null,
    });

    nextCursor = feed.next_cursor || null;
    if (items.length === 0 || added === 0) {
      break;
    }
  } while (nextCursor && tracks.length < count);

  return {
    tracks,
    profile: {
      handle: profile.handle || handle,
      displayName: profile.display_name || handle,
      userId: profile.user_id,
    },
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

  if (isSunoUrl(url) && isSunoProfileInput(url)) {
    const { tracks } = await fetchSunoProfileTracks(url);
    if (tracks.length > 0) return tracks;
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
  isSunoProfileInput,
  extractTracksFromUrl,
  fetchSunoProfileTracks,
  resolveStreamUrl,
  fetchRadioTracks,
  fetchRadioSongTracks,
};
