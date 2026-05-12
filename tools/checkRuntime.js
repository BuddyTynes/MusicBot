const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function commandExists(command) {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  return {
    exists: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    error: result.error?.message,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error?.message,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

function firstLine(value) {
  return value.split(/\r?\n/).find(Boolean) || "";
}

let hasFailure = false;

function report(name, ok, details) {
  const status = ok ? "OK" : "FAIL";
  if (!ok) hasFailure = true;
  console.log(`${status} ${name}${details ? ` - ${details}` : ""}`);
}

function reportOptional(name, ok, details) {
  const status = ok ? "OK" : "WARN";
  console.log(`${status} ${name}${details ? ` - ${details}` : ""}`);
}

console.log(`Node ${process.version}`);

if (process.env.FFMPEG_PATH) {
  const result = run(process.env.FFMPEG_PATH, ["-version"]);
  report(
    "FFMPEG_PATH",
    result.ok,
    result.ok ? firstLine(result.output) : result.error || firstLine(result.output),
  );
}

{
  const result = commandExists("ffmpeg");
  reportOptional(
    "system ffmpeg",
    result.exists,
    result.exists ? firstLine(result.output) : result.error || "not found in PATH",
  );
}

try {
  const ffmpegPath = require("ffmpeg-static");
  const exists = Boolean(ffmpegPath) && fs.existsSync(ffmpegPath);
  if (!exists) {
    report("ffmpeg-static", false, "binary was not found after npm install");
  } else {
    const result = run(ffmpegPath, ["-version"]);
    report("ffmpeg-static", result.ok, result.ok ? firstLine(result.output) : result.error || firstLine(result.output));
  }
} catch (error) {
  report("ffmpeg-static", false, error.message);
}

try {
  const { constants } = require("youtube-dl-exec");
  const ytDlpPath = process.env.YT_DLP_PATH || constants.YOUTUBE_DL_PATH;
  const exists = Boolean(ytDlpPath) && fs.existsSync(ytDlpPath);
  if (!exists) {
    report("yt-dlp", false, "binary was not found after npm install");
  } else {
    const result = run(ytDlpPath, ["--version"]);
    report("yt-dlp", result.ok, result.ok ? firstLine(result.output) : result.error || firstLine(result.output));
  }
} catch (error) {
  report("yt-dlp", false, error.message);
}

if (hasFailure) {
  process.exitCode = 1;
}
