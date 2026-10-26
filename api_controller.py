import os
import json
import threading
import time
import re
import tempfile
import requests
import subprocess
import zipfile
from datetime import datetime
from mutagen.mp3 import MP3, MPEGInfo

try:
    import webview
except ImportError:  # headless server: no native windows or dialogs
    webview = None

from core.config import load_config, save_config, SERVER_MODE, MEDIA_ROOT, BACKUP_DIR, PATH_MAP, PUBLIC_URL, BUNDLE_DIR
from core.safety import check_theme_write, check_media_read, is_season_folder_name, theme_files_only, UnsafeMediaOperation
from core.logger import log_queue
from core.audio import download_music, normalize_and_save, normalize_audio_ffmpeg, inject_mp3_metadata, get_streaming_url
from core.jellyfin import fetch_jellyfin_data, download_jellyfin_image, fetch_jellyfin_season_image, find_jellyfin_item, get_library_index, match_media_folder, local_media_folder, install_jellyfin_buttons, refresh_jellyfin_media
from core.files import generate_destination_path, move_loose_episodes, clean_search_name, safe_move
from core.jobs import ThemeQueue
from core.sources import search as search_source, themerrdb_theme, ids_from_folder_name, ids_from_jellyfin, guess_media_kind, youtube_video_id
from core import backup

global_state = {
    "is_processing": False,
    "percentage": 0,
    "statusText": "Ready",
    "percentageText": "0%",
    "item_statuses": [] 
}

LOCAL_COVER_NAMES = ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "poster.jpg", "poster.png"]

# Wide background art and title logo, with the names Jellyfin and Kodi read from the media folder
LOCAL_ART_NAMES = {
    "backdrop": ["backdrop.jpg", "backdrop.png", "fanart.jpg", "fanart.png", "background.jpg", "background.png",
                 "landscape.jpg", "landscape.png", "thumb.jpg", "thumb.png"],
    "logo": ["logo.png", "clearlogo.png"],
}

def local_cover(media_folder_path, names=LOCAL_COVER_NAMES):
    """Artwork saved in the media folder (the names Jellyfin and other tools use), or None"""
    for file_name in names:
        path = os.path.join(media_folder_path, file_name)
        if os.path.isfile(path) and os.path.getsize(path) > 1024:
            return path
    return None

def process_folder_artwork(media_folder_path, media_folder_name, config, only_file=None, only_changed=False):
    """Tags the theme files of a media folder: Jellyfin cover and names first, artwork in the folder as fallback.
    only_changed: files whose tags already match stay untouched. Returns how many files were written"""
    print(f"\n[AUTOMATION] 🎬 Starting metadata processing for: {media_folder_name}")

    final_image_path = None
    temp_image = False

    final_genre = ""
    final_album_name = media_folder_name
    series_id = None

    jelly_url = config.get("jelly_url")
    jelly_api = config.get("jelly_api")
    
    if jelly_url and jelly_api:
        print("[AUTOMATION] 🌐 Querying Jellyfin for additional metadata...")
        search_result = fetch_jellyfin_data(media_folder_name, jelly_url, jelly_api, folder_path=media_folder_path)
        
        if search_result["success"]:
            final_genre = search_result["genres"]
            final_album_name = search_result["official_name"]
            series_id = search_result["series_id"]
            
            if final_genre:
                print(f"[AUTOMATION] 🏷️ Genres found: {final_genre}")
            
            # The poster shown in Jellyfin wins, so a cover changed there reaches the themes too
            if search_result["image_url"]:
                final_image_path = download_jellyfin_image(
                    image_url=search_result["image_url"],
                    api_key=jelly_api,
                    dest_folder=tempfile.gettempdir(),
                    file_name=f"temp_cover_{series_id}.jpg"
                )
                temp_image = bool(final_image_path)
    else:
        print("[AUTOMATION] ⚠️ Jellyfin not configured/disabled. Skipping online search.")

    if not final_image_path:
        final_image_path = local_cover(media_folder_path)
        if final_image_path:
            print(f"[AUTOMATION] 🔍 Using the artwork in the folder ({os.path.basename(final_image_path)})")

    print("[AUTOMATION] 🚀 Scanning folder to apply metadata to MP3 files...")
    mp3_found = 0
    
    season_images_cache = {} 
    
    if only_file:
        mp3_paths = [only_file]
    else:
        mp3_paths = theme_files_only([
            os.path.join(root, file)
            for root, _, files in os.walk(media_folder_path)
            for file in files if file.lower().endswith('.mp3')
        ])

    for full_mp3_path in mp3_paths:
        root = os.path.dirname(full_mp3_path)
        music_title = os.path.splitext(os.path.basename(full_mp3_path))[0]

        current_image_path = final_image_path

        season_match = re.search(r'Season\s+(\d+)', root, re.IGNORECASE)

        if season_match and series_id and jelly_url and jelly_api:
            season_num = int(season_match.group(1))

            if season_num in season_images_cache:
                current_image_path = season_images_cache[season_num] or final_image_path
            else:
                print(f"[AUTOMATION] 🔍 Looking for Season {season_num} specific cover on Jellyfin...")
                season_image_url = fetch_jellyfin_season_image(series_id, season_num, jelly_url, jelly_api)

                if season_image_url:
                    downloaded_season_path = download_jellyfin_image(
                        image_url=season_image_url,
                        api_key=jelly_api,
                        dest_folder=tempfile.gettempdir(),
                        file_name=f"temp_cover_{series_id}_S{season_num}.jpg"
                    )
                    if downloaded_season_path:
                        season_images_cache[season_num] = downloaded_season_path
                        current_image_path = downloaded_season_path
                    else:
                        season_images_cache[season_num] = None
                else:
                    print(f"[JELLYFIN] ⚠️ Cover for Season {season_num} not found. Using main cover fallback.")
                    season_images_cache[season_num] = None

        if inject_mp3_metadata(full_mp3_path, current_image_path, music_title, final_album_name, final_genre,
                               only_if_changed=only_changed):
            mp3_found += 1

    if only_changed and not mp3_found:
        print("[AUTOMATION] ✨ Done! Tags were already up to date.")
    else:
        print(f"[AUTOMATION] ✨ Done! Metadata applied to {mp3_found} MP3 file(s).")
    
    if temp_image and final_image_path:
        try:
            os.remove(final_image_path)
        except Exception:
            pass
            
    for s_img in season_images_cache.values():
        if s_img and os.path.exists(s_img):
            try:
                os.remove(s_img)
            except Exception:
                pass
    return mp3_found

UPLOAD_PREFIX = "themarr_upload_"

def _is_uploaded_backup(path):
    """True only for a zip saved by the upload route"""
    if not path or not os.path.isfile(path):
        return False
    real = os.path.realpath(path)
    return (os.path.dirname(real) == os.path.realpath(tempfile.gettempdir())
            and os.path.basename(real).startswith(UPLOAD_PREFIX) and real.lower().endswith('.zip'))

def save_uploaded_backup(file_storage):
    # Uploads left behind by a page closed before the restore started
    temp_root = tempfile.gettempdir()
    for name in os.listdir(temp_root):
        old = os.path.join(temp_root, name)
        if name.startswith(UPLOAD_PREFIX) and time.time() - os.path.getmtime(old) > 86400:
            os.remove(old)
    fd, path = tempfile.mkstemp(prefix=UPLOAD_PREFIX, suffix='.zip')
    os.close(fd)
    file_storage.save(path)
    return path

def _backup_name(base_path):
    library = re.sub(r'[^A-Za-z0-9]+', '-', os.path.basename(os.path.normpath(base_path))).strip('-')
    return f"Themarr_Backup_{library + '_' if library else ''}{datetime.now().strftime('%Y%m%d_%H%M%S')}.zip"

def _remove_server_backups():
    """The server only keeps a backup until it is downloaded: the next export removes it"""
    for name in os.listdir(BACKUP_DIR):
        if backup.NAME.fullmatch(name):
            os.remove(os.path.join(BACKUP_DIR, name))

def _start_background(target, *args):
    t = threading.Thread(target=target, args=args)
    t.daemon = True
    t.start()

def _download_with_retry(link, log_prefix, name):
    max_attempts = 2
    for attempt in range(max_attempts):
        try:
            return download_music(link)
        except Exception:
            if attempt == max_attempts - 1:
                raise
            print(f"{log_prefix} ⚠️ Attempt {attempt + 1} failed to download '{name}'. Retrying...")

def _artwork_config():
    """Config for process_folder_artwork: Jellyfin credentials blanked when the integration is disabled"""
    config = load_config()
    if not config.get("jelly_check"):
        config["jelly_url"] = ""
        config["jelly_api"] = ""
    return config

def _refresh_jellyfin(folder):
    """Rescans the media folder on Jellyfin after new themes were saved, when the integration is enabled"""
    config = _artwork_config()
    if folder and config.get("jelly_url") and config.get("jelly_api"):
        refresh_jellyfin_media(folder, config["jelly_url"], config["jelly_api"])

def _is_single_media_folder(base_path):
    """True when base_path is one media folder (has theme files or season folders) instead of the library root"""
    if os.path.exists(os.path.join(base_path, "theme.mp3")):
        return True
    if os.path.isdir(os.path.join(base_path, "theme-music")):
        return True
    for item in os.listdir(base_path):
        if os.path.isdir(os.path.join(base_path, item)) and (item.lower().startswith("season") or item.lower() == "specials"):
            return True
    return False

def _is_season_folder_name(name):
    name = name.lower()
    return "season" in name or "temporada" in name or name == "specials"

def _media_folder_of_track(file_path):
    """Media folder that owns a theme track: <media>/theme.mp3, <media>/theme-music/x.mp3 or <media>/<season>/theme-music/x.mp3"""
    parent = os.path.dirname(file_path)
    if os.path.basename(parent).lower() != "theme-music":
        return parent if os.path.basename(file_path).lower() == "theme.mp3" else None

    owner = os.path.dirname(parent)
    if _is_season_folder_name(os.path.basename(owner)):
        return os.path.dirname(owner)
    return owner

def _track_destination(file_path, media_folder):
    """'Main Theme' or the season folder name that holds a theme track, in the terms the queue uses"""
    parent = os.path.dirname(file_path)
    if os.path.normcase(parent) == os.path.normcase(media_folder):
        return 'Main Theme'
    owner = os.path.dirname(parent)
    return 'Main Theme' if os.path.normcase(owner) == os.path.normcase(media_folder) else os.path.basename(owner)

def _track_file_name(name):
    """File name for a theme track typed by the user: .mp3 added and characters Windows refuses replaced"""
    name = (name or '').strip()
    if not name.lower().endswith('.mp3'):
        name += '.mp3'
    for char in '|*?:"<>/\\':
        name = name.replace(char, '-')
    return name

def _library_root(base_path):
    return os.path.dirname(base_path) if _is_single_media_folder(base_path) else base_path

def _mp3_duration(file_path):
    """Length of an MP3 in seconds. Skips the ID3 tag instead of parsing it: the embedded cover made reading
    every track of the library take seconds, and the length is the same"""
    with open(file_path, 'rb') as fh:
        head = fh.read(10)
        offset = 0
        if len(head) == 10 and head[:3] == b'ID3':
            offset = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9])
        try:
            return MPEGInfo(fh, offset).length
        except Exception:
            pass
    return MP3(file_path).info.length

def _track_entry(file_path, file_name, location_type, error_label):
    duration = 0.0
    try:
        duration = _mp3_duration(file_path)
    except Exception as e:
        print(f"[LIBRARY] Error reading {error_label}: {e}")

    return {
        "file_name": file_name,
        "file_path": file_path,
        "location_type": location_type,
        "duration": duration,
        "startTime": "0",
        "endTime": f"{int(duration)}" if duration > 0 else "0"
    }

def _theme_folder_tracks(theme_folder, location_type, error_label):
    tracks = []
    if os.path.isdir(theme_folder):
        for file in os.listdir(theme_folder):
            if file.lower().endswith('.mp3'):
                tracks.append(_track_entry(os.path.join(theme_folder, file), file, location_type, f"{error_label} {file}"))
    return tracks

def _list_season_folders(folder):
    seasons = []
    for item in os.listdir(folder):
        if os.path.isdir(os.path.join(folder, item)):
            item_lower = item.lower()
            if "season" in item_lower or "temporada" in item_lower or "specials" in item_lower:
                seasons.append(item)
    return sorted(seasons)

def _count_mp3(folder):
    try:
        return sum(1 for f in os.listdir(folder) if f.lower().endswith('.mp3'))
    except OSError:
        return 0

def _count_theme_files(folder):
    """Themes of a media or season folder: theme.mp3, theme-music/ and the theme-music of its seasons"""
    count = 0
    try:
        entries = os.listdir(folder)
    except OSError:
        return 0
    for name in entries:
        path = os.path.join(folder, name)
        if name.lower() == 'theme.mp3' and os.path.isfile(path):
            count += 1
        elif os.path.isdir(path):
            if name.lower() == 'theme-music':
                count += _count_mp3(path)
            elif is_season_folder_name(name):
                count += _count_mp3(os.path.join(path, 'theme-music'))
    return count

MEDIA_ACTIONS = {
    "normalize": "Normalizing",
    "fx": "Applying audio effects to",
    "retag": "Writing tags for",
    "refresh": "Refreshing",
    "organize": "Organizing",
    "remove": "Removing themes from",
}

def theme_files_in(folder):
    """Theme files of a media folder: theme.mp3 and theme-music/*.mp3, its own and its seasons'"""
    return theme_files_only([
        os.path.join(root, file)
        for root, _, files in os.walk(folder)
        for file in files if file.lower().endswith('.mp3')
    ])

def remove_theme_files(folder):
    """Deletes the theme files of a media folder and the theme-music folders left empty. Nothing else"""
    removed = 0
    for path in theme_files_in(folder):
        check_theme_write(path, "delete")
        os.remove(path)
        print(f"[CLEANUP] 🗑️ Removed: {os.path.relpath(path, folder)}")
        removed += 1
    for root, subfolders, _ in os.walk(folder, topdown=False):
        for sub in subfolders:
            sub_path = os.path.join(root, sub)
            if sub.lower() == 'theme-music' and not os.listdir(sub_path):
                os.rmdir(sub_path)
    return removed

def _media_entry(media_path):
    """One media folder with its theme tracks: theme.mp3, theme-music/ and each season's theme-music/"""
    folder = os.path.basename(media_path)
    tracks = []
    single_theme_path = os.path.join(media_path, "theme.mp3")
    if os.path.exists(single_theme_path):
        tracks.append(_track_entry(single_theme_path, "theme.mp3", "Main Theme (Single)", f"theme.mp3 in {folder}"))

    tracks += _theme_folder_tracks(os.path.join(media_path, "theme-music"), "Main Theme (Folder)", "root theme-music")

    try:
        for subitem in sorted(os.listdir(media_path), key=str.lower):
            subitem_path = os.path.join(media_path, subitem)
            if os.path.isdir(subitem_path) and subitem.lower() != 'theme-music':
                tracks += _theme_folder_tracks(os.path.join(subitem_path, "theme-music"), subitem, "season track")
    except Exception as e:
        print(f"[LIBRARY] Error reading subdirectories of {folder}: {e}")

    cover = local_cover(media_path)
    # cover_version changes with the file, so the browser does not keep showing an old cover. 0: no such file
    art = {kind: local_cover(media_path, names) for kind, names in LOCAL_ART_NAMES.items()}
    return {"media_name": folder, "folder_path": media_path, "tracks": tracks, "has_cover": bool(cover),
            "cover_version": int(os.path.getmtime(cover)) if cover else 0,
            "backdrop_version": int(os.path.getmtime(art["backdrop"])) if art["backdrop"] else 0,
            "logo_version": int(os.path.getmtime(art["logo"])) if art["logo"] else 0}

# ----------------------------------------------------------------------
# Download queue workers
# ----------------------------------------------------------------------
def _process_queue_item(item, set_stage):
    downloaded_file = None
    try:
        set_stage("Downloading")
        downloaded_file = _download_with_retry(item['link'], "[QUEUE]", item['name'])

        set_stage("Processing")
        destination = item.get('destination') or 'Main Theme'
        season = None if destination == 'Main Theme' else destination
        final_path = generate_destination_path(item['media_folder'], 'season' if season else 'main', item['name'],
                                               season, multiple_main=item.get('multi_main', False))
        effects = item.get('audio_fx')
        if effects is None:
            effects = load_config().get("audio_fx", {})
        normalize_and_save(downloaded_file, final_path, item['lufs'], effects,
                           start_time=item.get('startTime'), end_time=item.get('endTime'),
                           normalize_enabled=item.get('normalize', True))
        print(f"[SUCCESS] {item['name']} saved for {item['media_name']}.")
    finally:
        if downloaded_file and os.path.exists(downloaded_file):
            try:
                os.remove(downloaded_file)
            except Exception as e:
                print(f"[WARNING] Could not delete temporary file: {e}")

def _finish_media(media_folder, finished_items):
    """Once per media after its queued themes: loose episodes into the season used, tags and covers, Jellyfin rescan"""
    for season in {i['destination'] for i in finished_items if i.get('destination') != 'Main Theme'}:
        move_loose_episodes(media_folder, season)
    if any(i.get('tag', True) for i in finished_items):
        process_folder_artwork(media_folder, os.path.basename(media_folder), _artwork_config())
    _refresh_jellyfin(media_folder)

_theme_queue = None
_theme_queue_lock = threading.Lock()

def theme_queue():
    global _theme_queue
    with _theme_queue_lock:
        if _theme_queue is None:
            _theme_queue = ThemeQueue(_process_queue_item, _finish_media)
        return _theme_queue

def _powershell_dialog(script):
    res = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW
    )
    return res.stdout.strip()

class Api:
    def select_folder(self):
        folder = ""
        seasons = []
        try:
            if SERVER_MODE:
                return {"success": False, "path": "", "seasons": [], "message": "Use the folder browser on the server."}
            if webview and len(webview.windows) > 0:
                active_window = next(iter(webview.windows))
                result = active_window.create_file_dialog(webview.FOLDER_DIALOG)
                if result:
                    folder = next(iter(result))
            else:
                cmd = (
                    "[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null;"
                    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;"
                    "$dialog.Description = 'Select Media Directory';"
                    "$dialog.ShowNewFolderButton = $true;"
                    "if($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }"
                )
                folder = _powershell_dialog(cmd)

            if folder and os.path.exists(folder):
                seasons = _list_season_folders(folder)

        except Exception as e:
            print(f"[API] Error selecting folder: {e}")
            
        return {
            "success": bool(folder),
            "path": folder,
            "seasons": seasons
        }
        
    def browse_media_folders(self, folder=None):
        """Server folder browser: subfolders of `folder` with Jellyfin and theme details, never above MEDIA_ROOT"""
        root = MEDIA_ROOT or os.path.abspath(os.sep)
        current = os.path.realpath(folder) if folder else root
        check_media_read(current)
        if not os.path.isdir(current):
            current = root
        try:
            names = sorted((f for f in os.listdir(current) if os.path.isdir(os.path.join(current, f)) and not f.startswith('.')),
                           key=str.lower)
        except OSError as e:
            return {"success": False, "message": str(e)}

        # Depth below the media root: 0 = root, 1 = library (TV), 2 = media, 3 = season
        depth = 0 if current == root else len(os.path.relpath(current, root).split(os.sep))

        index = []
        if depth + 1 == 2:
            config = load_config()
            if config.get("jelly_check") and config.get("jelly_url") and config.get("jelly_api"):
                index = get_library_index(config["jelly_url"], config["jelly_api"])

        folders = []
        for name in names:
            path = os.path.join(current, name)
            entry = {"name": name, "path": path, "season": depth + 1 == 3 and is_season_folder_name(name),
                     "jellyfin": None, "themes": None}
            if depth + 1 >= 2 and name.lower() != 'theme-music':
                entry["themes"] = _count_theme_files(path) if not entry["season"] else _count_mp3(os.path.join(path, 'theme-music'))
            if index:
                item = match_media_folder(index, path)
                entry["jellyfin"] = item.get("Name") if item else None
            folders.append(entry)

        breadcrumb = [{"name": os.path.basename(root) or root, "path": root}]
        if current != root:
            walked = root
            for part in os.path.relpath(current, root).split(os.sep):
                walked = os.path.join(walked, part)
                breadcrumb.append({"name": part, "path": walked})

        parent = os.path.dirname(current) if current != root else None
        return {"success": True, "path": current, "parent": parent, "root": root, "folders": folders, "breadcrumb": breadcrumb}

    def suggest_media_folders(self, text):
        """Autocomplete for the path field: folders whose name starts with what was typed after the last /"""
        root = MEDIA_ROOT or os.path.abspath(os.sep)
        text = (text or '').strip()
        if not text:
            return {"success": True, "suggestions": [root]}
        base, fragment = (text.rstrip('/\\'), '') if text.endswith(('/', '\\')) else (os.path.dirname(text), os.path.basename(text))
        base = os.path.realpath(base or root)
        try:
            check_media_read(base)
            names = [n for n in os.listdir(base) if os.path.isdir(os.path.join(base, n)) and not n.startswith('.')]
        except (UnsafeMediaOperation, OSError):
            return {"success": True, "suggestions": []}
        fragment = fragment.casefold()
        matches = sorted((n for n in names if n.casefold().startswith(fragment)), key=str.lower)[:15]
        return {"success": True, "suggestions": [os.path.join(base, n) for n in matches]}

    def resolve_jellyfin_item(self, item_id):
        """Media folder of a Jellyfin item, in the same shape as select_folder"""
        config = load_config()
        jelly_url, jelly_api = config.get("jelly_url"), config.get("jelly_api")
        if not (config.get("jelly_check") and jelly_url and jelly_api):
            return {"success": False, "message": "Jellyfin is not configured in Settings."}

        item = find_jellyfin_item(str(item_id).strip(), jelly_url, jelly_api)
        if not item or not item.get("Path"):
            return {"success": False, "message": "This item was not found on Jellyfin."}

        jellyfin_folder = os.path.dirname(item["Path"]) if item.get("Type") == "Movie" else item["Path"]
        folder = local_media_folder(jellyfin_folder, MEDIA_ROOT, PATH_MAP)
        if not folder:
            print(f"[JELLYFIN] ⚠️ '{item.get('Name')}' lives at '{jellyfin_folder}', which Themarr cannot see. Check the media volume or THEMARR_PATH_MAP.")
            return {"success": False, "message": f"Folder not visible from Themarr: {jellyfin_folder}"}

        print(f"[JELLYFIN] 🔗 Opened from Jellyfin: {item.get('Name')} -> {folder}")
        return {"success": True, "path": folder, "seasons": _list_season_folders(folder), "name": item.get("Name")}

    def _auto_organize_single_season(self, media_folder):
        try:
            items_in_folder = os.listdir(media_folder)
            
            season_folders = [item for item in items_in_folder if os.path.isdir(os.path.join(media_folder, item)) and "season" in item.lower()]
            has_season = len(season_folders) > 0
            
            if not has_season:
                media_name = os.path.basename(media_folder)
                new_season_name = f"Season 01. {media_name}"
                new_season_path = os.path.join(media_folder, new_season_name)
                
                media_extensions = ('.mkv', '.mp4', '.avi', '.ass', '.srt', '.vtt')
                moved_items = 0
                
                for item in items_in_folder:
                    item_path = os.path.join(media_folder, item)
                    
                    if os.path.isfile(item_path) and item.lower().endswith(media_extensions):
                        os.makedirs(new_season_path, exist_ok=True)
                        if safe_move(item_path, os.path.join(new_season_path, item)):
                            moved_items += 1
                        
                if moved_items > 0:
                    print(f"\n[AUTO-ORGANIZE] 🧹 {moved_items} item(s) automatically organized into '{new_season_name}'!")
                    season_folders = [new_season_name] 
            
            items_in_folder = os.listdir(media_folder)
            
            has_root_music = False
            for item in items_in_folder:
                item_lower = item.lower()
                if item_lower == "theme-music" and os.path.isdir(os.path.join(media_folder, item)):
                    has_root_music = True
                elif item_lower == "theme.mp3" and os.path.isfile(os.path.join(media_folder, item)):
                    has_root_music = True
                    
            if not has_root_music and len(season_folders) == 1:
                only_season_path = os.path.join(media_folder, season_folders[0])
                season_items = os.listdir(only_season_path)
                
                for s_item in season_items:
                    if s_item.lower() == "theme-music" and os.path.isdir(os.path.join(only_season_path, s_item)):
                        if safe_move(os.path.join(only_season_path, s_item), os.path.join(media_folder, s_item)):
                            print(f"\n[AUTO-ORGANIZE] 🎵 Promoted 'theme-music' from '{season_folders[0]}' to the main media folder.")
                        break
                        
        except Exception as e:
            print(f"[AUTO-ORGANIZE] ❌ Error organizing folder {media_folder}: {e}")

    # ------------------------------------------------------------------
    # Library: folders, media list and media page
    # ------------------------------------------------------------------
    def get_library_folders(self):
        """Library folders from Settings. On the server, every folder under the media root until some are chosen"""
        folders = [f for f in load_config().get("library_folders", []) if f and os.path.isdir(f)]
        if not folders and SERVER_MODE and MEDIA_ROOT and os.path.isdir(MEDIA_ROOT):
            folders = sorted((os.path.join(MEDIA_ROOT, n) for n in os.listdir(MEDIA_ROOT)
                              if os.path.isdir(os.path.join(MEDIA_ROOT, n)) and not n.startswith('.')), key=str.lower)
        return folders

    def set_library_folders(self, folders):
        clean = []
        for folder in folders or []:
            folder = os.path.realpath(str(folder))
            check_media_read(folder)
            if not os.path.isdir(folder):
                return {"success": False, "message": f"Folder not found: {folder}"}
            # On the server a library is /data/<library>: media folders must sit right below it
            if SERVER_MODE and os.path.dirname(folder) != MEDIA_ROOT:
                return {"success": False, "message": f"Pick a library folder directly under {MEDIA_ROOT}, such as {MEDIA_ROOT}/TV."}
            if folder not in clean:
                clean.append(folder)
        config = load_config()
        config["library_folders"] = clean
        save_config(config)
        return {"success": True, "folders": self.get_library_folders()}

    def _jellyfin_index(self, fresh=False):
        config = load_config()
        if config.get("jelly_check") and config.get("jelly_url") and config.get("jelly_api"):
            return get_library_index(config["jelly_url"], config["jelly_api"], force_refresh=fresh)
        return []

    @staticmethod
    def _jellyfin_info(index, folder):
        item = match_media_folder(index, folder) if index else None
        if not item:
            return None
        # Tags of the Jellyfin images, which change when an image is replaced there. Empty: the item has none
        tags = item.get("ImageTags") or {}
        return {"id": item.get("Id"), "name": item.get("Name"), "year": item.get("ProductionYear"), "type": item.get("Type"),
                "image": tags.get("Primary", ""), "thumb": tags.get("Thumb", ""), "logo": tags.get("Logo", ""),
                "backdrop": (item.get("BackdropImageTags") or [""])[0]}

    def library_overview(self, fresh=False):
        """Every media folder of every library folder, with its themes and its Jellyfin item. fresh: ask Jellyfin again"""
        index = self._jellyfin_index(fresh)
        libraries, media = [], []
        for root in self.get_library_folders():
            check_media_read(root)
            libraries.append({"name": os.path.basename(root) or root, "path": root})
            try:
                names = sorted((n for n in os.listdir(root) if os.path.isdir(os.path.join(root, n)) and not n.startswith('.')),
                               key=str.lower)
            except OSError as e:
                print(f"[LIBRARY] Could not read {root}: {e}")
                continue
            for name in names:
                entry = _media_entry(os.path.join(root, name))
                entry.update(library=os.path.basename(root), jellyfin=self._jellyfin_info(index, entry["folder_path"]))
                media.append(entry)
        return {"success": True, "libraries": libraries, "media": media}

    def media_details(self, folder):
        folder = os.path.realpath(folder or '')
        check_media_read(folder)
        if not os.path.isdir(folder):
            return {"success": False, "message": "This media folder no longer exists."}
        entry = _media_entry(folder)
        entry.update(library=os.path.basename(os.path.dirname(folder)), seasons=_list_season_folders(folder),
                     jellyfin=self._jellyfin_info(self._jellyfin_index(), folder))
        return {"success": True, "media": entry}

    # Size asked from Jellyfin for each image type: the poster of a grid, a full width background, a title logo
    JELLYFIN_IMAGE_SIZES = {"Primary": {"maxHeight": 450, "quality": 90}, "Backdrop": {"maxWidth": 1920, "quality": 85},
                            "Thumb": {"maxWidth": 1920, "quality": 85}, "Logo": {"maxWidth": 800}}

    def jellyfin_image(self, item_id, kind="Primary"):
        """Image of a Jellyfin item (poster, backdrop, thumb or logo), fetched with the server's API key so the
        browser never needs it"""
        config = load_config()
        if kind not in self.JELLYFIN_IMAGE_SIZES:
            return None
        if not (config.get("jelly_check") and config.get("jelly_url") and config.get("jelly_api")):
            return None
        try:
            res = requests.get(f"{config['jelly_url'].rstrip('/')}/Items/{item_id}/Images/{kind}",
                               headers={"X-Emby-Token": config["jelly_api"]},
                               params=self.JELLYFIN_IMAGE_SIZES[kind], timeout=10)
            if res.status_code == 200 and res.headers.get('Content-Type', '').startswith('image/'):
                return res.content, res.headers['Content-Type']
        except Exception as e:
            print(f"[JELLYFIN] ⚠️ Could not load the {kind.lower()} image of {item_id}: {e}")
        return None

    def rename_track(self, file_path, new_name):
        """Renames a theme file (never over another one) and writes the new title tag"""
        new_name = _track_file_name(new_name)
        if not file_path or not os.path.isfile(file_path):
            return {"success": False, "message": "Track not found."}
        if new_name == '.mp3':
            return {"success": False, "message": "Type a name for the track."}

        new_path = os.path.join(os.path.dirname(file_path), new_name)
        if os.path.basename(file_path) == new_name:
            return {"success": True, "file_path": file_path}
        # A case-only rename points to the same file on Windows and is allowed
        if os.path.exists(new_path) and not os.path.samefile(file_path, new_path):
            return {"success": False, "message": f"A track named '{new_name}' already exists here."}
        check_theme_write(file_path, "rename")
        check_theme_write(new_path, "rename")
        os.rename(file_path, new_path)
        print(f"[LIBRARY] Renamed '{os.path.basename(file_path)}' to '{new_name}'.")

        self.retag_track(new_path)
        return {"success": True, "file_path": new_path}

    def move_track(self, file_path, destination, new_name=''):
        """Moves a theme between the main theme and the season folders of its own media, optionally renaming it.
        Never over another file and never out of the media"""
        if not file_path or not os.path.isfile(file_path):
            return {"success": False, "message": "Track not found."}
        media_folder = _media_folder_of_track(file_path)
        if not media_folder:
            return {"success": False, "message": "This file is not in a theme folder."}
        check_media_read(media_folder)
        to_main = destination == 'Main Theme'
        if not to_main and destination not in _list_season_folders(media_folder):
            return {"success": False, "message": f"Season folder not found: {destination}"}

        new_name = _track_file_name(new_name or os.path.splitext(os.path.basename(file_path))[0])
        if new_name == '.mp3':
            return {"success": False, "message": "Type a name for the track."}
        if _track_destination(file_path, media_folder) == destination:
            return self.rename_track(file_path, new_name)

        target_folder = os.path.join(media_folder, 'theme-music') if to_main else os.path.join(media_folder, destination, 'theme-music')
        target = os.path.join(target_folder, new_name)
        loose_main = os.path.join(media_folder, 'theme.mp3')
        place = 'Main theme' if to_main else destination
        if os.path.exists(target) or (to_main and new_name.lower() == 'theme.mp3' and os.path.isfile(loose_main)):
            return {"success": False, "message": f"A track named '{new_name}' already exists in {place}."}

        check_theme_write(file_path, "move")
        check_theme_write(target, "move")
        os.makedirs(target_folder, exist_ok=True)
        # Two main themes live in theme-music/, like after a download: the loose theme.mp3 goes in there first
        if to_main and os.path.isfile(loose_main):
            migrated = os.path.join(target_folder, 'theme.mp3')
            check_theme_write(loose_main, "move")
            check_theme_write(migrated, "move")
            if safe_move(loose_main, migrated):
                print("[LIBRARY] Moved 'theme.mp3' into 'theme-music' to hold more than one main theme.")
        if not safe_move(file_path, target):
            return {"success": False, "message": f"A track named '{new_name}' already exists in {place}."}

        source_folder = os.path.dirname(file_path)
        if os.path.basename(source_folder).lower() == 'theme-music' and not os.listdir(source_folder):
            os.rmdir(source_folder)
        print(f"[LIBRARY] Moved '{os.path.basename(file_path)}' to {place} as '{new_name}'.")

        # The season cover goes into the tags, and Jellyfin picks the theme up in its new place
        self.retag_track(target)
        _start_background(_refresh_jellyfin, media_folder)
        return {"success": True, "file_path": target, "message": f"Moved to {place}."}

    def retag_track(self, file_path):
        """Writes title, album, genres and cover into one theme file, without re-encoding the audio"""
        if not file_path or not os.path.isfile(file_path):
            return {"success": False, "message": "Track not found."}
        check_theme_write(file_path, "tag")
        media_folder = _media_folder_of_track(file_path)
        if not media_folder:
            return {"success": False, "message": "This file is not in a theme folder."}
        process_folder_artwork(media_folder, os.path.basename(media_folder), _artwork_config(), only_file=file_path)
        return {"success": True, "message": "Tags written."}

    # ------------------------------------------------------------------
    # Bulk actions on media folders (Library selection and media page)
    # ------------------------------------------------------------------
    def run_media_action(self, folders, action):
        """normalize, fx, retag, organize or remove, on explicit media folders. Only theme files are touched"""
        if action not in MEDIA_ACTIONS:
            return {"success": False, "message": "Unknown action."}
        targets = []
        for folder in folders or []:
            folder = os.path.realpath(str(folder))
            check_media_read(folder)
            if os.path.isdir(folder):
                targets.append(folder)
        if not targets:
            return {"success": False, "message": "No media selected."}
        if global_state["is_processing"]:
            return {"success": False, "message": "Another task is running. Try again when it finishes."}

        global_state.update(is_processing=True, percentage=0, statusText=f"{MEDIA_ACTIONS[action]}...", percentageText="0%")
        _start_background(self._media_action_thread, targets, action)
        return {"success": True, "message": f"{MEDIA_ACTIONS[action]} {len(targets)} media..."}

    def _media_action_thread(self, folders, action):
        label = MEDIA_ACTIONS[action]
        config = self.get_settings()
        lufs = config.get("lufs", -24)
        changed = 0
        try:
            print(f"\n[TASK] {label} {len(folders)} media folder(s)...")
            if action == 'refresh':
                # Names, posters and folder matches read again from Jellyfin, not from the 10 minute cache
                self._jellyfin_index(fresh=True)
            for i, folder in enumerate(folders):
                name = os.path.basename(folder)
                percentage = int(i / len(folders) * 100)
                global_state.update(percentage=percentage, statusText=f"{label}: {name}", percentageText=f"{i}/{len(folders)}")

                if action == 'organize':
                    self._auto_organize_single_season(folder)
                elif action == 'remove':
                    changed += remove_theme_files(folder)
                elif action == 'retag':
                    themes = theme_files_in(folder)
                    if themes:
                        process_folder_artwork(folder, name, _artwork_config())
                        changed += len(themes)
                elif action == 'refresh':
                    # Tags only where Jellyfin changed something, then Jellyfin rescans the folder for moved or new themes
                    if theme_files_in(folder):
                        changed += process_folder_artwork(folder, name, _artwork_config(), only_changed=True)
                    _refresh_jellyfin(folder)
                else:
                    effects = config.get("audio_fx", {}) if action == 'fx' else {}
                    for mp3 in theme_files_in(folder):
                        print(f"[TASK] 🎚️ {os.path.basename(mp3)}")
                        normalize_audio_ffmpeg(mp3, lufs, effects, normalize_enabled=(action == 'normalize'))
                        changed += 1

            if action == 'refresh':
                print(f"[TASK] Done: refresh finished, tags updated in {changed} theme file(s).\n")
            else:
                print(f"[TASK] Done: {label.lower()} finished ({changed} theme file(s)).\n")
            global_state.update(percentage=100, statusText=f"{label} finished", percentageText=f"{len(folders)}/{len(folders)}")
        except Exception as e:
            print(f"\n[TASK] ❌ {label} stopped: {e}")
            global_state["statusText"] = f"Error: {e}"
        finally:
            global_state["is_processing"] = False

    # ------------------------------------------------------------------
    # Download queue
    # ------------------------------------------------------------------
    def queue_add(self, media_folder, items):
        media_folder = os.path.realpath(media_folder or '')
        check_media_read(media_folder)
        if not os.path.isdir(media_folder):
            return {"success": False, "message": "This media folder no longer exists."}

        clean = []
        for item in items or []:
            link = str(item.get('link', '')).strip()
            name = str(item.get('name', '')).strip()
            destination = str(item.get('destination') or 'Main Theme')
            if not link.startswith(('http://', 'https://')):
                return {"success": False, "message": "Choose a YouTube video or paste its link."}
            if not name:
                return {"success": False, "message": "Give the theme a name."}
            if destination != 'Main Theme' and (os.path.basename(destination) != destination or destination in ('.', '..')):
                return {"success": False, "message": "Invalid destination."}
            clean.append({
                "link": link, "name": name, "destination": destination,
                "lufs": item.get('lufs') if item.get('lufs') not in (None, '') else load_config().get("lufs", -24),
                "audio_fx": item.get('audio_fx'),
                "startTime": item.get('startTime') or None, "endTime": item.get('endTime') or None,
                "normalize": item.get('normalize', True) is not False, "tag": item.get('tag', True) is not False,
            })
        if not clean:
            return {"success": False, "message": "Nothing to add."}
        ids = theme_queue().add(media_folder, clean)
        return {"success": True, "ids": ids, "message": f"Added {len(ids)} theme(s) to the queue."}

    def queue_list(self):
        return theme_queue().snapshot()

    def queue_remove(self, item_id):
        return {"success": theme_queue().remove(item_id)}

    def queue_retry(self, item_id):
        return {"success": theme_queue().retry(item_id)}

    def queue_clear_finished(self):
        theme_queue().clear_finished()
        return {"success": True}

    def queue_pause(self, paused):
        theme_queue().set_paused(paused)
        return {"success": True, "paused": theme_queue().paused}

    def get_status(self):
        chunks = []
        while not log_queue.empty():
            chunks.append(log_queue.get())

        return {
            "logs": "".join(chunks),
            "is_processing": global_state["is_processing"],
            "percentage": global_state["percentage"],
            "statusText": global_state["statusText"],
            "percentageText": global_state["percentageText"],
            "item_statuses": global_state["item_statuses"]
        }
    
    def test_jellyfin(self, url, api_key):
        try:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
                
            url = str(url).strip().strip('"').strip("'")
            api_key = str(api_key).strip().strip('"').strip("'")
                
            if not url.startswith('http'):
                url = 'http://' + url
            clean_url = url.rstrip('/')
                
            headers = {
                "X-Emby-Token": api_key,
                "Accept": "application/json"
            }
                
            response = requests.get(f"{clean_url}/System/Info", headers=headers, timeout=5, verify=False)
                
            if response.status_code == 200:
                return {"status": "success", "message": "✅ Connected Successfully!"}
            else:
                return {"status": "error", "message": f"❌ Error {response.status_code}: API Key rejected by server."}
                    
        except Exception as e:
            return {"status": "error", "message": f"❌ Connection Error: {str(e)}"}
            
    def jellyfin_buttons_script(self):
        """jellyfin/themarr-buttons.js with THEMARR_URL_SETTING filled from THEMARR_PUBLIC_URL"""
        with open(os.path.join(BUNDLE_DIR, 'jellyfin', 'themarr-buttons.js'), 'r', encoding='utf-8') as f:
            script = f.read()
        return re.sub(r"const THEMARR_URL_SETTING = '[^']*';",
                      lambda _: f"const THEMARR_URL_SETTING = {json.dumps(PUBLIC_URL)};", script, count=1)

    def install_jellyfin_buttons(self):
        config = load_config()
        if not (config.get("jelly_url") and config.get("jelly_api")):
            return {"success": False, "message": "Fill in the Jellyfin URL and API key first."}
        return install_jellyfin_buttons(config["jelly_url"], config["jelly_api"], self.jellyfin_buttons_script())

    def get_settings(self):
        return load_config()

    def save_settings(self, data):
        save_config(data)
        return True

    def search(self, query, source=None):
        """Text search in one source (Settings > Sources sets the default)"""
        source = source or self.get_settings().get("search_source") or "youtube"
        return search_source(query, source)

    def search_youtube(self, query):
        return search_source(query, "youtube")

    def get_stream_info(self, url):
        """Direct audio URL of a link, for the preview"""
        if not url:
            return {"success": False, "error": "No URL provided"}
        return get_streaming_url(url)

    def list_local_library(self, base_path, scope="all", selected_folders=None):
        check_media_read(base_path or MEDIA_ROOT or '.')
        """
        Scan media folders and return a structured list of media folders and their associated theme music tracks.
        Detects intelligently if the inserted path is the media root or a specific media folder.
        """
        if not base_path or not os.path.exists(base_path):
            return {"success": False, "message": "Media Directory not found or not selected."}
            
        if selected_folders is None:
            selected_folders = []
            
        try:
            is_single_media = _is_single_media_folder(base_path)
        except Exception:
            is_single_media = False

        if is_single_media:
            real_root_path = os.path.dirname(base_path)
            if not selected_folders:
                selected_folders = [os.path.basename(base_path)]
        else:
            real_root_path = base_path
            
        library_data = []
        
        try:
            all_items = os.listdir(real_root_path)
            media_folders = [d for d in all_items if os.path.isdir(os.path.join(real_root_path, d))]
            
            for folder in media_folders:
                if scope == "selected" and folder not in selected_folders:
                    continue
                    
                library_data.append(_media_entry(os.path.join(real_root_path, folder)))

            library_data.sort(key=lambda x: x["media_name"].lower())
            return {"success": True, "library": library_data}
            
        except Exception as e:
            print(f"[LIBRARY] Error listing library: {e}")
            return {"success": False, "message": str(e)}

    def process_local_file(self, file_path, target_lufs, audio_effects, normalize_enabled, tag_enabled, new_name=None):
        """
        Trims, normalizes, applies fades, and injects metadata on local MP3 files.
        """
        if not file_path or not os.path.exists(file_path):
            return {"success": False, "message": "Target file not found."}
            
        try:
            normalize_audio_ffmpeg(file_path, target_lufs, audio_effects, normalize_enabled)
            
            # Rename the file on disk only if the name changed
            old_base = os.path.basename(file_path)
            print(f"[LIBRARY] Rename check - Old Name: '{old_base}', New Name: '{new_name}'")
            
            if new_name and old_base != new_name:
                new_file_path = os.path.join(os.path.dirname(file_path), new_name)
                print(f"[LIBRARY] Renaming physical file from '{file_path}' to '{new_file_path}'")
                
                # Never overwrite another track. A case-only rename points to the same file on Windows and is allowed
                if os.path.exists(new_file_path) and not os.path.samefile(file_path, new_file_path):
                    print(f"[LIBRARY] Rename aborted: '{new_name}' already exists in this folder.")
                    return {"success": False, "message": f"A track named '{new_name}' already exists in this folder."}

                check_theme_write(file_path, "rename")
                check_theme_write(new_file_path, "rename")
                os.rename(file_path, new_file_path)
                file_path = new_file_path  # Keep the path current for the tag writing below
                print(f"[LIBRARY] Rename completed successfully!")
            else:
                print(f"[LIBRARY] Rename skipped (name matches or empty new_name)")
            
            if tag_enabled:
                media_folder = _media_folder_of_track(file_path)
                if media_folder:
                    process_folder_artwork(media_folder, os.path.basename(media_folder), _artwork_config(), only_file=file_path)
                else:
                    print(f"[LIBRARY] Could not resolve the media folder of '{file_path}'. Skipping tags.")

            return {"success": True, "message": "Track processed!"}
            
        except Exception as e:
            print(f"[LIBRARY] Processing execution error: {e}")
            return {"success": False, "message": str(e)}

    def export_media_backup(self, base_path, save_path=''):
        """Starts the backup of one library; the page follows it through backup.state"""
        check_media_read(base_path or MEDIA_ROOT or '.')
        if not base_path or not os.path.isdir(base_path):
            return {"success": False, "message": "Media folder is not configured."}
        if backup.running():
            return {"success": False, "message": "A backup or restore is already running."}

        if SERVER_MODE or not save_path:
            os.makedirs(BACKUP_DIR, exist_ok=True)
            if SERVER_MODE:
                _remove_server_backups()
            zip_path = os.path.join(BACKUP_DIR, _backup_name(base_path))
        else:
            zip_path = save_path if save_path.lower().endswith('.zip') else save_path + '.zip'

        root = _library_root(base_path)

        def list_files():
            # Only file names: reading every MP3 as the Library page does takes minutes on a big library
            folders = [base_path] if root != base_path else [os.path.join(root, f) for f in sorted(os.listdir(root))]
            return [path for folder in folders if os.path.isdir(folder) for path in theme_files_in(folder)]

        backup.start_export(list_files, root, zip_path)
        return {"success": True}

    def choose_backup_destination(self, base_path):
        """Desktop: asks where to save the backup before it is made"""
        if SERVER_MODE:
            return {"success": False, "path": ""}
        name = _backup_name(base_path)
        path = ""
        try:
            if webview and len(webview.windows) > 0:
                result = next(iter(webview.windows)).create_file_dialog(
                    webview.SAVE_DIALOG, save_filename=name, file_types=('Zip files (*.zip)',))
                path = result if isinstance(result, str) else (next(iter(result), "") if result else "")
            else:
                cmd = (
                    "[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null;"
                    " $dialog = New-Object System.Windows.Forms.SaveFileDialog;"
                    " $dialog.Filter = 'Themarr Backup (*.zip)|*.zip';"
                    " $dialog.Title = 'Save Themarr Backup';"
                    f" $dialog.FileName = '{name}';"
                    " if($dialog.ShowDialog() -eq 'OK') { $dialog.FileName }"
                )
                path = _powershell_dialog(cmd)
        except Exception as e:
            print(f"[BACKUP] Could not open the save dialog: {e}")
        return {"success": bool(path), "path": path}

    def select_backup_file(self):
        file_path = ""
        try:
            if SERVER_MODE:
                return {"success": False, "file_path": ""}
            if webview and len(webview.windows) > 0:
                active_window = next(iter(webview.windows))
                result = active_window.create_file_dialog(
                    webview.OPEN_DIALOG,
                    file_types=('Zip files (*.zip)', 'All files (*.*)')
                )
                if result:
                    file_path = next(iter(result))
            else:
                cmd = (
                    "[System.Reflection.Assembly]::LoadWithPartialName('System.windows.forms') | Out-Null;"
                    " $dialog = New-Object System.Windows.Forms.OpenFileDialog;"
                    " $dialog.Filter = 'Themarr Backup (*.zip)|*.zip';"
                    " $dialog.Title = 'Select Themarr Backup File';"
                    " if($dialog.ShowDialog() -eq 'OK') { $dialog.FileName }"
                )
                file_path = _powershell_dialog(cmd)
        except Exception as e:
            print(f"[BACKUP] Could not select the file: {e}")
        return {"success": bool(file_path), "file_path": file_path}

    def analyze_backup(self, zip_path, base_path):
        """Reads the list of themes in the zip, without extracting it, so the page can ask before restoring"""
        check_media_read(base_path or MEDIA_ROOT or '.')
        if not zip_path or not os.path.exists(zip_path):
            return {"success": False, "message": "Invalid backup file."}
        if SERVER_MODE and not _is_uploaded_backup(zip_path):
            return {"success": False, "message": "Upload the backup file through the browser."}
        if not base_path or not os.path.exists(base_path):
            return {"success": False, "message": "Media folder is not configured."}

        try:
            folders, missing, themes = backup.read_backup(zip_path, _library_root(base_path))
        except zipfile.BadZipFile:
            return {"success": False, "message": "This file is not a valid .zip."}
        except Exception as e:
            print(f"[BACKUP] Could not analyze the backup: {e}")
            return {"success": False, "message": str(e)}
        if not themes:
            return {"success": False, "message": "This .zip has no Themarr themes."}
        return {"success": True, "zip_path": zip_path, "media_count": len(folders), "theme_count": themes, "missing_folders": missing}

    def restore_backup(self, zip_path, base_path, decision):
        uploaded = _is_uploaded_backup(zip_path)
        if SERVER_MODE and not uploaded:
            return {"success": False, "message": "Upload the backup file through the browser."}
        if not zip_path or not os.path.isfile(zip_path):
            return {"success": False, "message": "The backup file is gone. Please choose it again."}
        check_media_read(base_path or MEDIA_ROOT or '.')

        if decision == "cancel":
            if uploaded:
                os.remove(zip_path)
            return {"success": True, "message": "Restore cancelled."}
        if backup.running():
            return {"success": False, "message": "A backup or restore is already running."}
        # Media folders are never created on the server
        create_missing = decision == "create_all" and not SERVER_MODE
        backup.start_restore(zip_path, _library_root(base_path), create_missing, uploaded)
        return {"success": True}

    def get_assistant_search_query(self, folder_name, folder_path=None):
        try:
            config = self.get_settings()
            jelly_url = config.get("jelly_url")
            jelly_api = config.get("jelly_api")
            
            official_name = folder_name
            series_id = None
            image_url = None
            genres = ""
            
            clean_fallback = clean_search_name(folder_name, remove_year=True)
            
            if jelly_url and jelly_api and config.get("jelly_check"):
                search_result = fetch_jellyfin_data(folder_name, jelly_url, jelly_api, folder_path=folder_path)
                if search_result.get("success"):
                    official_name = search_result.get("official_name")
                    series_id = search_result.get("series_id")
                    image_url = search_result.get("image_url")
                    genres = search_result.get("genres", "")
            
            if not official_name or official_name == folder_name:
                official_name = clean_fallback
                
            # The year from "Title (1926)" tells apart films with common names
            year = re.search(r"\((\d{4})\)", folder_name)
            if year and year.group(1) not in official_name:
                official_name_for_search = f"{official_name} {year.group(1)}"
            else:
                official_name_for_search = official_name
            search_query = f"{official_name_for_search} official theme song opening"
            
            return {
                "success": True,
                "folder_name": folder_name,
                "official_name": official_name,
                "search_query": search_query,
                "image_url": image_url,
                "genres": genres,
                "series_id": series_id
            }
        except Exception as e:
            print(f"[ASSISTANT] Error getting search query for {folder_name}: {e}")
            return {"success": False, "message": str(e)}

    def get_suggested_theme(self, folder_name, folder_path=None):
        """The ThemerrDB theme of a media, or None. Ids come from the folder name tags, then from the Jellyfin item
        whose folder is exactly this one (a name search could land on another title, so it is not used here)"""
        config = self.get_settings()
        if config.get("use_themerrdb") is False:
            return None

        ids = ids_from_folder_name(folder_name)
        kind = None
        if config.get("jelly_check") and config.get("jelly_url") and config.get("jelly_api"):
            item = match_media_folder(get_library_index(config["jelly_url"], config["jelly_api"]), folder_path or folder_name)
            if item:
                kind = "movie" if item.get("Type") == "Movie" else "tv"
                ids = {**ids_from_jellyfin(item.get("ProviderIds")), **ids}
        if not ids:
            return None
        if not kind:
            seasons = _list_season_folders(folder_path) if folder_path and os.path.isdir(folder_path) else []
            kind = guess_media_kind(folder_path, seasons) if folder_path else "movie"

        try:
            return themerrdb_theme(kind, ids)
        except Exception as e:
            print(f"[THEMERRDB] Lookup failed for {folder_name}: {e}")
            return None

    def get_media_theme_suggestions(self, folder_name, folder_path=None):
        try:
            meta = self.get_assistant_search_query(folder_name, folder_path)
            if not meta.get("success"):
                return {"success": False, "message": meta.get("message")}
                
            query = meta["search_query"]
            yt_results = self.search_youtube(query)
            top_results = yt_results[:3] if yt_results else []

            # The ThemerrDB pick goes first, so it is the one already selected on the Missing page
            suggested = self.get_suggested_theme(folder_name, folder_path)
            if suggested:
                top_results = [suggested] + [r for r in top_results
                                             if youtube_video_id(r.get('url')) != youtube_video_id(suggested['url'])][:3]

            return {
                "success": True,
                "folder_name": folder_name,
                "official_name": meta["official_name"],
                "search_query": query,
                "image_url": meta["image_url"],
                "genres": meta["genres"],
                "series_id": meta["series_id"],
                "suggestions": top_results
            }
        except Exception as e:
            print(f"[ASSISTANT] Error getting suggestions for {folder_name}: {e}")
            return {"success": False, "message": str(e)}
