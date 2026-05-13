# Suno Discord Music Bot

A Discord bot that accepts Suno song links and playlist links, queues them, and plays them in voice chat.

## Features

- Queue a Suno song or playlist with one command
- Queue public songs from a Suno profile
- Queue Spotify tracks, albums, and playlists by matching them on YouTube
- Basic queue controls (`play`, `queue`, `now`, `skip`, `stop`)
- Automatic next-track playback
- Uses `yt-dlp` for YouTube playback and Spotify matching

## Requirements

- Node.js 20+
- Python 3.7+ available as `python3` during `npm install` on Linux
- A Discord bot token

FFmpeg and yt-dlp are installed as project dependencies. If you need a custom yt-dlp binary, set `YT_DLP_PATH` in `.env`.
On Linux servers, installing system FFmpeg and setting `FFMPEG_PATH=/usr/bin/ffmpeg` can avoid crashes from the bundled static binary.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from example and set your token:

```bash
cp .env.example .env
```

On Windows, use `copy .env.example .env`.

3. Fill in `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
COMMAND_PREFIX=!
LOG_LEVEL=info
YT_DLP_TIMEOUT_MS=45000
# Optional: override the bundled yt-dlp binary path.
YT_DLP_PATH=
# Optional: override FFmpeg. On Linux servers, /usr/bin/ffmpeg is often more stable than ffmpeg-static.
FFMPEG_PATH=
# Optional: use a browser profile for cookies on desktop hosts.
# Server deploys should use an uncommitted youtube-cookies.txt file instead.
YT_DLP_COOKIES_FROM_BROWSER=
# Optional: tune YouTube playback if yt-dlp reports requested format unavailable.
YT_DLP_YOUTUBE_FORMAT=
YT_DLP_YOUTUBE_EXTRACTOR_ARGS=
# Optional: override JavaScript runtime for YouTube player challenges. Defaults to node:<current node path>.
YT_DLP_JS_RUNTIME=
SUNO_MAX_PLAYLIST_TRACKS=1000
SUNO_DEFAULT_PROFILE_TRACKS=25
SUNO_MAX_PROFILE_TRACKS=500
MAX_CONSECUTIVE_PLAYBACK_FAILURES=3
MIN_PLAYBACK_SUCCESS_MS=3000
YOUTUBE_MAX_PLAYLIST_TRACKS=100
SPOTIFY_MAX_TRACKS=100
```

4. Run the bot:

```bash
npm start
```

Optional runtime check before starting:

```bash
npm run check:runtime
```

Optional YouTube cookie check:

```bash
npm run check:youtube-cookies
```

## Commands

- `!play <url>`: Add a Suno song/playlist, YouTube video/playlist, or Spotify track/album/playlist URL to queue
- `!profile <@handle|profile-url> [count|all] [top|recent]`: Queue public songs from a Suno profile
- `!queue`: Show current queue
- `!now`: Show currently playing track
- `!skip`: Skip current track
- `!stop`: Stop playback, clear queue, and disconnect
- `!help`: Show command help

## Notes

- `!play` accepts Suno, YouTube, and Spotify URLs. `!profile` accepts Suno profile handles or profile URLs.
- Spotify links are metadata-only; the bot searches YouTube for the closest playable match. Spotify collections are capped at the first 100 tracks.
- `MAX_CONSECUTIVE_PLAYBACK_FAILURES` defaults to 3 if it is missing or invalid, so a bad queue should stop instead of spamming every track.
- `MIN_PLAYBACK_SUCCESS_MS` defaults to 3000. Playback ending faster than that is treated as a failure and logged with FFmpeg exit details.
- If FFmpeg exits with `SIGSEGV` on a Linux server, install system FFmpeg and set `FFMPEG_PATH=/usr/bin/ffmpeg`.
- If YouTube says "Sign in to confirm you're not a bot", export cookies from a browser that can play YouTube and save them as `youtube-cookies.txt` in the app directory, beside `package.json`. The file is ignored by git and is passed directly to `yt-dlp`. `YT_DLP_COOKIES_FROM_BROWSER=firefox` can also work on desktop hosts.
- If YouTube says "Requested format is not available", run `npm run check:youtube-cookies`. The bot tries normal audio formats first, then alternate YouTube player clients. You can override the selector with `YT_DLP_YOUTUBE_FORMAT`.
- If the format list only shows `sb*` storyboard/image formats, make sure the checker prints a usable `js runtime`. You can set `YT_DLP_JS_RUNTIME=node:/usr/bin/node` on the server.
- If YouTube playback fails after install, run `npm install` again and check that Python 3.7+ is available as `python3`.
- Depending on Suno or extractor changes, `yt-dlp` support may need updates.

## Debug Logging

- Set `LOG_LEVEL=debug` in `.env` for verbose connection and playback logs.
- Logs are written to `src/logs/bot.log` and still appear in the terminal.
- On the server, run `tail -f src/logs/bot.log` while testing playback.

## YouTube Cookies

Follow yt-dlp's cookie export instructions for YouTube:

[Exporting YouTube cookies](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies)

Save the exported Netscape-format cookie file as `youtube-cookies.txt` in the app directory. The bot will use it automatically on the next playback request. Keep this file private; it is ignored by git.
