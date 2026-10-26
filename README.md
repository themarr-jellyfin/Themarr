<div align="center">
  <img src="docs/images/themarr.png" alt="Themarr logo" width="160" />
  <h1>Themarr</h1>
  <p><strong>Theme song manager for Jellyfin libraries.</strong><br />
  Find a theme on YouTube, trim it, level its loudness, tag it and drop it in the right folder, for the whole show or for each season.</p>

  <a href="https://github.com/themarr-jellyfin/Themarr/releases/latest"><img src="https://img.shields.io/github/v/release/themarr-jellyfin/Themarr?style=for-the-badge" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/themarr-jellyfin/Themarr?style=for-the-badge" alt="License: GPL-3.0" /></a>
  <img src="https://img.shields.io/badge/Jellyfin-10.10-00A4DC?style=for-the-badge&logo=jellyfin&logoColor=white" alt="Jellyfin 10.10" />
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" />
</div>

## About

Jellyfin plays a theme song while you browse a series or movie, as long as the media folder has a
`theme.mp3` or a `theme-music/` folder. Themarr is a web app that builds those files for you.

You pick the music. Themarr suggests the community pick from [ThemerrDB](https://github.com/LizardByte/ThemerrDB)
when there is one, searches YouTube, lets you preview and cut the exact part you want, normalizes the
volume so every show plays at the same level, embeds the cover and the official title from Jellyfin, and saves
the file where Jellyfin expects it. Shows with a different opening per season get one theme per season folder.

It runs as a Windows desktop app or as a Docker container next to your Jellyfin server, with a button on
Jellyfin's own pages that opens the current series or movie in Themarr.

<p align="center">
  <img src="docs/images/screenshot-library.png" alt="Themarr library with a poster for each movie and how many themes it has, over the backdrop of one of them" width="100%" />
</p>
<p align="center">
  <img src="docs/images/screenshot-media.png" alt="Media page with the title logo and backdrop, and a theme playing with its seek bar and volume" width="100%" />
</p>
<p align="center">
  <img src="docs/images/screenshot-add-theme.png" alt="Add Theme panel: YouTube results, preview with start and end marks, name and destination" width="49%" />
  <img src="docs/images/screenshot-missing.png" alt="Missing page: media without a theme and the suggested YouTube results for each" width="49%" />
</p>
<p align="center"><sub>The films in the screenshots, their posters and stills are in the public domain (from Wikimedia Commons); the title logos are drawn with open fonts.</sub></p>

> [!NOTE]
> Looking for fully automatic themes from a shared database? See
> [Themerr](https://github.com/LizardByte/Themerr). Themarr is the hands-on alternative: you choose each track,
> which suits media with several openings or a different theme per season. Its database,
> [ThemerrDB](https://github.com/LizardByte/ThemerrDB), is where Themarr's suggestions come from.

## Features

**Finding and downloading**
- Suggested theme from [ThemerrDB](https://github.com/LizardByte/ThemerrDB), a community list with one theme
  per movie and TV show, found by the TMDB or IMDb id from Jellyfin or from the folder name
  (`Movie (1999) [tmdbid-603]`). It can be turned off in Settings.
- YouTube search inside the app, or paste a link. Listen to the result before downloading anything.
- Mark where the theme starts and ends while it plays, name it, and choose where it goes: the main theme or a
  season.
- A background download queue, like the *arr apps: it keeps going when you close the page, can be paused, and
  retries only what failed.

**Audio**
- Loudness normalization with FFmpeg `loudnorm` (default target -24 LUFS, adjustable), so themes do not jump
  in volume from one show to the next.
- Optional fade-in, fade-out and removal of leading silence, globally or per track.
- Output is MP3 at 320 kbps.

**Metadata**
- ID3 tags with the track title, the official series or movie name and its genres from Jellyfin.
- Embedded cover art: a local `poster`/`folder`/`cover` image if present, otherwise the Jellyfin poster, or the
  season poster for season themes.

**Library**
- Every series and movie of your libraries as posters or a table, with how many themes each one has. Posters
  come from Jellyfin, or from a `poster.jpg`, `folder.jpg` or `cover.jpg` in the media folder.
- A page per media with its themes, main and per season: play, trim, rename, re-normalize, re-tag or delete.
- Missing: the media with no theme yet, each with the ThemerrDB pick (already selected when there is one) and
  the top YouTube results to pick from.
- Bulk actions on a selection: normalize, audio effects, re-tag, organize, remove themes.
- Organize creates a season folder and moves loose episode and subtitle files into it, never overwriting
  anything.
- Backup and restore of the themes of a library as a single `.zip`.

**Jellyfin integration**
- Folders are matched to Jellyfin items by path, with name search as a fallback.
- Jellyfin rescans the media after new themes are saved, so they show up without a manual scan.
- A Themarr button on series, season, episode and movie pages (through the
  [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector) plugin), which Themarr can
  install for you.
- In server mode, sign-in uses Jellyfin administrator accounts. No separate user list.

## What Themarr writes

Only theme files, in the layout Jellyfin reads:

```
Lost/
├── theme.mp3                     <- one main theme
├── theme-music/                  <- or several main themes
│   ├── Opening 1.mp3
│   └── Opening 2.mp3
└── Season 2/
    └── theme-music/
        └── Opening.mp3           <- theme for that season
```

In server mode a safety guard enforces this: Themarr can only create, rename or delete `theme.mp3` and
`theme-music/*.mp3` files inside existing media folders, and never replaces an existing file when it moves
something. The rest of the library is read only.

## Installation

### Server (Docker)

The recommended setup for a home server. Themarr runs as a container on the same machine as Jellyfin and is
reached from your browser on port 8686.

```bash
git clone https://github.com/themarr-jellyfin/Themarr.git themarr && cd themarr
cp env.example .env      # set MEDIA_PATH and JELLYFIN_API_KEY
docker compose up -d --build
```

The full guide, including folder layout, permissions and the Jellyfin buttons, is in
**[docs/SERVER.md](docs/SERVER.md)**.

> [!WARNING]
> Themarr is meant for your home network or a private VPN such as Tailscale. Do not expose it to the internet.

### Desktop (Windows)

1. Download `Themarr_vX.Y.Z.zip` from the [latest release](https://github.com/themarr-jellyfin/Themarr/releases/latest).
2. Extract it anywhere and run `Themarr_Desktop.exe`, which opens Themarr in its own window.
   `Themarr_Server.exe` does the same from a tray icon and opens it in your browser instead.

FFmpeg is bundled. The desktop app listens on `127.0.0.1:5000` only and has no login.

Themarr tells you when a new version is out (Settings > Updates, with the release notes), and the Windows app
can update itself with one click: it downloads the new version, closes and opens again, keeping your settings.

### From source

Python 3.13 or newer, FFmpeg (`bin/ffmpeg.exe` on Windows, `ffmpeg` on the PATH elsewhere) and Node.js or Deno,
which yt-dlp needs for YouTube.

```bash
pip install -r requirements-server.txt "yt-dlp[default]" pywebview pystray pillow
python main.py
```

## Quick start

1. In Jellyfin, open your user settings, go to **Display** and enable **Theme songs**.
2. Open Themarr. In **Settings**, add your media folders (one per library, such as TV and Movies), then enter
   your Jellyfin address and an API key (Dashboard, API Keys) and test the connection. The Docker setup reads
   the media folder and Jellyfin from `.env`.
3. In **Library**, open a series and click **Add Theme**. Pick a search result, listen to it, mark the start and
   end if needed, and click **Add to queue**.
4. The theme downloads in the background (see **Activity**). When it is done, open the series in Jellyfin and
   the theme plays.

## Requirements

- Jellyfin 10.10. Tested on 10.10.7. Themarr itself only uses the standard Jellyfin API; the page buttons depend
  on the web UI and may need changes on later versions.
- For the buttons: the JavaScript Injector plugin (tested with 3.5.0.0).
- An administrator API key, needed for library rescans and for installing the buttons.
- Media organized the usual Jellyfin way: one folder per series or movie, inside a folder per library.

## Roadmap

- [ ] More sources to search and download themes from, besides YouTube.
- [ ] Crossfades and more audio effects.
- [ ] Desktop builds for Linux and macOS.

Ideas and bug reports are welcome in [Issues](https://github.com/themarr-jellyfin/Themarr/issues).

## Built with

[yt-dlp](https://github.com/yt-dlp/yt-dlp) for search and download, [FFmpeg](https://ffmpeg.org) for audio
processing, [Mutagen](https://github.com/quodlibet/mutagen) for tags, [Flask](https://flask.palletsprojects.com)
and [Waitress](https://github.com/Pylons/waitress) for the web server, and
[pywebview](https://github.com/r0x0r/pywebview) for the desktop window.

Theme suggestions come from [ThemerrDB](https://github.com/LizardByte/ThemerrDB), maintained by
[LizardByte](https://github.com/LizardByte) and its contributors, who pick a theme for each title by hand.
Thank you. If a pick is missing or wrong, it can be fixed there, and every app that uses the list gets it.

## License

Themarr is free software under the [GNU General Public License v3.0](LICENSE).

Themarr is not affiliated with or endorsed by the Jellyfin project, LizardByte or YouTube. You are responsible for making
sure your use of downloaded audio complies with its terms and with the copyright laws where you live.
