"""Theme suggestions that come from somewhere other than the YouTube search.

ThemerrDB (https://github.com/LizardByte/ThemerrDB, BSD-3-Clause, by LizardByte) is a community list that picks one
YouTube theme for each movie and TV show, looked up by TMDB id (movies also by IMDb id). It is published once a day
as static JSON, so answers are kept for a day, including "not in the list"."""
import os
import re
import threading
import time
from urllib.parse import parse_qs, urlparse

import requests

from core.config import APP_VERSION

THEMERRDB_URL = "https://app.lizardbyte.dev/ThemerrDB"
OEMBED_URL = "https://www.youtube.com/oembed"
CACHE_TTL = 86400
# Says who is asking, so the ThemerrDB maintainers can see where the traffic comes from
HEADERS = {"User-Agent": f"Themarr/{APP_VERSION} (+https://github.com/themarr-jellyfin/Themarr)"}

# Ids in folder names: [tmdbid-603] and [imdbid-tt0133093] (Jellyfin, Radarr, Sonarr), {tmdb-603} (Plex)
_ID_TAG = re.compile(r'[\[{](tmdb|tmdbid|imdb|imdbid)[-=](\w+)[\]}]', re.IGNORECASE)
_EPISODE_FILE = re.compile(r'S\d{1,2}\s*E\d{1,3}', re.IGNORECASE)
_VIDEO_EXT = ('.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.webm')

_cache_lock = threading.Lock()
_cache = {}  # key -> (timestamp, value)


def _cached(key, fetch):
    """fetch() returns (value, keep). Failures that may be temporary (network) come back with keep=False"""
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    value, keep = fetch()
    if keep:
        with _cache_lock:
            _cache[key] = (time.time(), value)
    return value


def ids_from_folder_name(name):
    """{'tmdb': '603', 'imdb': 'tt0133093'} from the tags in a folder name, only the ones present"""
    ids = {}
    for db, value in _ID_TAG.findall(name or ''):
        key = 'imdb' if db.lower().startswith('imdb') else 'tmdb'
        ids.setdefault(key, value)
    return ids


def ids_from_jellyfin(provider_ids):
    """Same shape as ids_from_folder_name, from the ProviderIds of a Jellyfin item"""
    lowered = {str(k).lower(): str(v) for k, v in (provider_ids or {}).items() if v}
    return {key: lowered[key] for key in ('tmdb', 'imdb') if key in lowered}


def guess_media_kind(folder_path, season_folders=()):
    """'tv' when the folder has season folders or episode files (S01E01), otherwise 'movie'. Used only without Jellyfin"""
    if season_folders:
        return 'tv'
    try:
        names = os.listdir(folder_path)
    except OSError:
        return 'movie'
    episodes = [n for n in names if n.lower().endswith(_VIDEO_EXT) and _EPISODE_FILE.search(n)]
    return 'tv' if episodes else 'movie'


def youtube_video_id(url):
    parsed = urlparse(url or '')
    host = parsed.netloc.lower()
    if host.endswith('youtu.be'):
        return parsed.path.strip('/') or None
    if 'youtube.com' in host:
        return (parse_qs(parsed.query).get('v') or [None])[0]
    return None


def _themerrdb_url(kind, db, item_id):
    folder = 'movies' if kind == 'movie' else 'tv_shows'
    database = 'themoviedb' if db == 'tmdb' else 'imdb'
    return f"{THEMERRDB_URL}/{folder}/{database}/{item_id}.json"


def _themerrdb_link(kind, db, item_id):
    def fetch():
        try:
            res = requests.get(_themerrdb_url(kind, db, item_id), headers=HEADERS, timeout=10)
        except requests.RequestException as e:
            print(f"[THEMERRDB] Could not reach ThemerrDB: {e}")
            return None, False
        if res.status_code == 404:
            return None, True
        if res.status_code != 200:
            print(f"[THEMERRDB] ThemerrDB answered status {res.status_code}")
            return None, False
        try:
            return res.json().get('youtube_theme_url') or None, True
        except ValueError:
            return None, False
    return _cached(('themerrdb', kind, db, str(item_id)), fetch)


def _video_details(url):
    """Title and channel from YouTube oEmbed, which is fast and also tells a removed video apart.
    None when the video is gone; a generic entry when YouTube could not be asked"""
    def fetch():
        try:
            res = requests.get(OEMBED_URL, params={'url': url, 'format': 'json'}, headers=HEADERS, timeout=10)
        except requests.RequestException:
            return {}, False
        if res.status_code in (400, 404):
            return None, True
        if res.status_code != 200:
            # 401/403: the video exists but cannot be embedded; the preview and download still work
            return {}, True
        try:
            data = res.json()
        except ValueError:
            return {}, False
        return {'title': data.get('title', ''), 'channel': data.get('author_name', '')}, True
    return _cached(('oembed', url), fetch)


def themerrdb_theme(kind, ids):
    """The ThemerrDB pick for a movie ('movie') or TV show ('tv') as a search result, or None.
    TV shows are listed by TMDB id only; movies by TMDB id, then IMDb id"""
    lookups = [('tmdb', ids.get('tmdb'))]
    if kind == 'movie':
        lookups.append(('imdb', ids.get('imdb')))

    for db, item_id in lookups:
        if not item_id:
            continue
        link = _themerrdb_link(kind, db, item_id)
        if not link:
            continue
        details = _video_details(link)
        if details is None:
            print(f"[THEMERRDB] The theme listed for {db} {item_id} was removed from YouTube: {link}")
            return None
        video_id = youtube_video_id(link)
        return {
            'title': details.get('title') or 'Theme picked by ThemerrDB',
            'url': link,
            'channel': details.get('channel', ''),
            'duration': '',
            'thumbnail': f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg" if video_id else '',
            'source': 'themerrdb',
        }
    return None
