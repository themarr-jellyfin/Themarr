# Running Themarr on a server, next to Jellyfin

This guide sets up Themarr as a Docker container on the same machine as Jellyfin, with a web UI that only
Jellyfin administrators can sign in to, and a **Themarr** button on Jellyfin's series, season, episode and
movie pages that opens that media straight in Themarr.

It assumes a Linux server with Docker and Docker Compose, and Jellyfin already running (in Docker or not).

| Piece | What it does |
| --- | --- |
| `docker-compose.yml` + `.env` | Builds and runs the container. Everything specific to your server goes in `.env`. |
| Themarr web UI, port 8686 | Same app as the desktop version. Sign in with a Jellyfin admin account. |
| `jellyfin/themarr-buttons.js` | The buttons inside Jellyfin, loaded by the JavaScript Injector plugin. Themarr can install it for you. |

Tested with Jellyfin 10.10.7 and JavaScript Injector 3.5.0.0. Themarr itself only uses the standard Jellyfin
API, so it should work on newer versions too; the buttons depend on the web UI's page structure and may need
adjusting on Jellyfin 10.11 or later.

## What Themarr may touch

In server mode Themarr writes, renames or deletes **only theme files**: `theme.mp3` and `theme-music/*.mp3`
inside a media folder or one of its season folders. It never creates or removes a media folder. Organize can
move loose episodes into a season folder of the same media, and never replaces a file that already exists.
Everything else in your library is read only, whatever the volume permissions say.

## 1. Lay out the media folder

Themarr expects one host folder holding your libraries, one subfolder per library:

```
/srv/media            <- MEDIA_PATH, seen by Themarr as /data
├── TV/
│   └── Lost/
│       ├── Season 1/
│       └── theme.mp3        <- what Themarr writes
└── Movies/
    └── Up (2009)/
```

This is how most Jellyfin setups look already. Themarr only writes at `/data/<library>/<media>`, so a library
mounted directly as `/data` (no library folder above the media) is not supported.

Libraries spread over several disks: point `MEDIA_PATH` at one of them and add the others in a
`docker-compose.override.yml` next to `docker-compose.yml`, each under `/data`:

```yaml
services:
  themarr:
    volumes:
      - /mnt/disk2/TV:/data/TV:ro
      - /mnt/disk3/Movies:/data/Movies:ro
```

## 2. Get the code

```bash
git clone https://github.com/themarr-jellyfin/Themarr.git ~/themarr
cd ~/themarr
cp env.example .env
```

## 3. Create a Jellyfin API key

Jellyfin > Dashboard > API Keys > **+**, name it `Themarr`, and put it in `.env` as `JELLYFIN_API_KEY`.
Themarr uses it to read the library and to install the buttons. Users still sign in with their own Jellyfin
account, and only administrators are let in.

## 4. Fill in `.env`

Open `.env` and set at least `MEDIA_PATH` and `JELLYFIN_API_KEY`. The values you may need to look up:

| Setting | How to find it |
| --- | --- |
| `MEDIA_PATH` | The host folder above your libraries (the left side of Jellyfin's media volume, if it runs in Docker). |
| `PUID`, `PGID` | Owner of the media files: `stat -c '%u %g' /srv/media/TV`. Themes are created as this user. |
| `JELLYFIN_NETWORK` | `docker inspect jellyfin --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'` |
| `JELLYFIN_URL` | `http://<jellyfin container name>:8096` on the same Docker network. |
| `THEMARR_BIND` | `127.0.0.1` to reach Themarr only through a VPN or proxy, or the server's LAN IP for the home network. |

**Jellyfin not in Docker** (installed from a package): create a network once with
`docker network create themarr`, then set `JELLYFIN_NETWORK=themarr` and
`JELLYFIN_URL=http://host.docker.internal:8096`.

Keep `MEDIA_ACCESS=ro` for now.

## 5. Start it

```bash
docker compose up -d --build
docker compose logs -f themarr
```

The log should show `[SERVER] Themarr listening on 0.0.0.0:8686 | media root: /data`.
From the server, `curl -I http://127.0.0.1:8686/login` should answer `200`.

The container runs with low CPU priority and a 600 MB memory cap, so Jellyfin keeps priority on small machines.
Audio jobs (ffmpeg) run one at a time.

## 6. Reach the web UI

Pick one. Themarr has a login, but it is not meant to face the internet.

- **Home network:** set `THEMARR_BIND` to the server's LAN IP (e.g. `192.168.1.50`), run `docker compose up -d`,
  open `http://192.168.1.50:8686`.
- **Tailscale:** keep `THEMARR_BIND=127.0.0.1` and run `sudo tailscale serve --bg --https=8686 http://127.0.0.1:8686`.
  Open `https://<server>.<tailnet>.ts.net:8686` from any device on the tailnet.
- **Reverse proxy** (Caddy, Nginx, Traefik) on your own domain: proxy to `127.0.0.1:8686`, keep it behind your
  VPN or the proxy's own authentication, and set `THEMARR_PUBLIC_URL=https://themarr.example.com` so the
  Jellyfin buttons open the right address.

## 7. First check, read only

Sign in with a Jellyfin administrator account. The Library lists every media folder under `/data`, one library per
folder (Settings > Media folders lets you choose which libraries to show). Media that Jellyfin knows show their poster
and official name, and their page says "Matched in Jellyfin". If none do, Themarr and Jellyfin disagree about paths;
see [When paths differ](#when-paths-differ).

Saving a theme now fails with a "Read-only file system" error, which is expected with `MEDIA_ACCESS=ro`.

## 8. Allow saving themes

Set `MEDIA_ACCESS=rw` in `.env` and run `docker compose up -d`. Try the first theme on a media you would not
mind redoing, and check the result in Jellyfin (Jellyfin plays it only for users who enabled theme songs in
Settings > Display).

## 9. Add the buttons to Jellyfin

1. Install the **JavaScript Injector** plugin: Jellyfin > Dashboard > Plugins > Repositories > **+**, URL
   `https://raw.githubusercontent.com/n00bcodr/jellyfin-plugins/main/manifest.json`. Then Catalog >
   JavaScript Injector > Install, and restart Jellyfin.
2. In Themarr, open Settings and, under Jellyfin, click **Install** next to Buttons in Jellyfin. It adds a script named
   `Themarr buttons` to the plugin, or updates it, and leaves any other scripts alone.
3. Reload Jellyfin with Ctrl+F5. Administrators see a music note in the header and on media pages; other users
   see nothing.

On a series, season, episode or movie page the button opens Themarr at `/?item=<Jellyfin item id>`. Themarr
asks Jellyfin where that item lives, finds the same folder under `/data` and opens its page, ready for
**Add Theme**. The button in the header opens the Library.

To install by hand instead, open `http://<themarr>/jellyfin/themarr-buttons.js` while signed in to Themarr,
copy it into a new script in JavaScript Injector, and tick "Requires authentication".

The buttons open Themarr on the same host Jellyfin was opened on, port 8686, with the same http/https.
`http://192.168.1.50:8096` leads to `http://192.168.1.50:8686`, and a Tailscale name works the same way.
Set `THEMARR_PUBLIC_URL` and click Install again if Themarr lives elsewhere (reverse proxy, other port).

## When paths differ

The button sends Themarr a Jellyfin item, and Themarr needs to find that item's folder on its own disk.
It works out on its own when both containers see the same folders, even at different mount points:
`/media/Shows/Lost` in Jellyfin finds `/data/TV/Lost` in Themarr, and `/tvshows/Dark` finds
`/data/TV/Dark` if only one library has a `Dark` folder.

If Themarr still says `Folder not visible from Themarr: <path>`, tell it where each Jellyfin folder is:

```
THEMARR_PATH_MAP=/tvshows=/data/TV;/films=/data/Movies
```

Left of `=` is the path as Jellyfin shows it (Dashboard > Libraries, or the item's "Media info"), right is the
path inside Themarr. Then `docker compose up -d`.

## Updating

Settings > Updates shows when a new version is out, with its release notes. A container does not replace itself, so update it from the server:

```bash
cd ~/themarr
git pull
docker compose up -d --build
```

`.env`, `config/` (settings, login secret, backups) and `docker-compose.override.yml` are kept. If downloads
start failing (YouTube and SoundCloud change often), rebuild without cache to get the newest yt-dlp:
`docker compose build --no-cache`.
After an update that changed `jellyfin/themarr-buttons.js`, click **Install** again in Settings > Jellyfin.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `set MEDIA_PATH in .env` when starting | `.env` is missing or has no `MEDIA_PATH`. |
| `network ... declared as external, but could not be found` | Wrong `JELLYFIN_NETWORK`; see step 4. |
| Login says Jellyfin is unreachable | `JELLYFIN_URL` wrong, or Themarr is not on Jellyfin's network. |
| Login rejected for a valid account | Only Jellyfin administrators can sign in. |
| No posters or Jellyfin names in the Library | Paths differ; see [When paths differ](#when-paths-differ). |
| Saving fails with "Read-only file system" | `MEDIA_ACCESS` is still `ro`. |
| Saving fails with "Permission denied" | `PUID`/`PGID` do not own the media files. |
| "Blocked ... outside the media folder" | The folder is not under `/data`. |
| Buttons missing | Not an admin, plugin not installed, or the page was not hard-reloaded (Ctrl+F5). |
| Button opens a blank or wrong address | Set `THEMARR_PUBLIC_URL` and install the buttons again. |

## Removing it

Delete the `Themarr buttons` script in JavaScript Injector, then `docker compose down` in `~/themarr`. Themes
already saved stay in the media folders, where Jellyfin keeps using them.
