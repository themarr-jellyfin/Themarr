import os
import re
import threading
import time
import requests

from core.files import clean_search_name

LIBRARY_INDEX_TTL = 600  # seconds before the series/movie list is fetched again

_index_lock = threading.Lock()
_index_cache = {}  # (url, api_key) -> (timestamp, index)


def _path_parts(path):
    """Folder components of a path, lower-cased, accepting both / and \\ separators"""
    return [p.casefold() for p in re.split(r'[\\/]+', str(path).strip()) if p]


def _item_result(item, clean_url):
    genres_list = item.get("Genres", [])
    return {
        "success": True,
        "official_name": item.get("Name"),
        "series_id": item.get("Id"),
        "image_url": f"{clean_url}/Items/{item.get('Id')}/Images/Primary?format=jpg",
        "genres": ", ".join(genres_list) if genres_list else ""
    }


def _build_library_index(items):
    """Maps each media folder of the Jellyfin library to its item. Series point to their folder; movies to the folder holding the file"""
    entries = []
    movie_dirs = {}

    for item in items:
        path = item.get("Path")
        if not path:
            continue
        if item.get("Type") == "Movie":
            folder = re.split(r'[\\/]+', path.rstrip('\\/'))[:-1]
            folder_path = "/".join(folder)
            movie_dirs[folder_path.casefold()] = movie_dirs.get(folder_path.casefold(), 0) + 1
        else:
            folder_path = path
        entries.append((folder_path, item))

    index = []
    for folder_path, item in entries:
        # Movies stored loose in a shared folder have no folder of their own to match
        if item.get("Type") == "Movie" and movie_dirs.get(folder_path.casefold(), 0) > 1:
            continue
        parts = _path_parts(folder_path)
        if parts:
            index.append((parts, folder_path, item))
    return index


def get_library_index(jellyfin_url, api_key, force_refresh=False):
    """Series and movies of the Jellyfin library with their paths, cached for LIBRARY_INDEX_TTL seconds. Empty list when unreachable"""
    clean_url = jellyfin_url.rstrip('/')
    key = (clean_url, api_key)

    with _index_lock:
        cached = _index_cache.get(key)
        if cached and not force_refresh and time.time() - cached[0] < LIBRARY_INDEX_TTL:
            return cached[1]

        try:
            res = requests.get(
                f"{clean_url}/Items",
                headers={"X-Emby-Token": api_key},
                params={"IncludeItemTypes": "Series,Movie", "Recursive": "true", "Fields": "Path,Genres,ProviderIds"},
                timeout=20
            )
            if res.status_code != 200:
                print(f"[JELLYFIN] ⚠️ Could not load the library index (status {res.status_code}). Using name search.")
                return []
            index = _build_library_index(res.json().get("Items", []))
        except Exception as e:
            print(f"[JELLYFIN] ⚠️ Could not load the library index: {e}. Using name search.")
            return []

        _index_cache[key] = (time.time(), index)
        print(f"[JELLYFIN] 📚 Library index loaded: {len(index)} media folder(s).")
        return index


def match_media_folder(index, folder):
    """Item whose media folder is `folder` (a full path or just the folder name). Compares from the end of the path, so
    D:\\Media\\TV\\X and /data/TV/X match each other. Returns None when nothing or more than one item fits"""
    target = _path_parts(folder)
    if not target:
        return None

    candidates = [entry for entry in index if entry[0][-1] == target[-1]]
    depth = 2
    while len(candidates) > 1 and depth <= len(target):
        candidates = [entry for entry in candidates if entry[0][-depth:] == target[-depth:]]
        depth += 1

    return candidates[0][2] if len(candidates) == 1 else None


def local_media_folder(jellyfin_path, media_root=None, path_map=()):
    """Where Themarr sees a folder that Jellyfin reports, or None. Jellyfin and Themarr may mount the media at
    different places (/media/tv/X on Jellyfin, /data/TV/X here), so after THEMARR_PATH_MAP and the path itself
    it tries the last folders of the path under media_root, then a single <media_root>/<any library>/<name>"""
    parts = [p for p in re.split(r'[\\/]+', str(jellyfin_path).strip()) if p]
    if not parts:
        return None

    candidates = []
    normalized = '/'.join(parts).casefold()
    for src, dst in path_map:
        src_norm = '/'.join(p for p in re.split(r'[\\/]+', src) if p).casefold()
        if normalized == src_norm or normalized.startswith(src_norm + '/'):
            rest = parts[len(src_norm.split('/')) if src_norm else 0:]
            candidates.append(os.path.join(dst, *rest))
            break
    candidates.append(jellyfin_path)
    if media_root:
        # <library>/<media> and deeper tails first: a bare <media_root>/<name> is never a media folder
        candidates += [os.path.join(media_root, *parts[-n:]) for n in range(len(parts), 1, -1)]

    def usable(path):
        if not os.path.isdir(path):
            return False
        if not media_root:
            return True
        real = os.path.realpath(path)
        return real != media_root and os.path.commonpath([real, media_root]) == media_root

    for candidate in candidates:
        if usable(candidate):
            return os.path.realpath(candidate)

    if media_root:
        try:
            hits = [os.path.join(media_root, lib, parts[-1]) for lib in os.listdir(media_root)]
        except OSError:
            hits = []
        hits = [h for h in hits if usable(h)]
        if len(hits) == 1:
            return os.path.realpath(hits[0])
    return None


def find_jellyfin_item(item_id, jellyfin_url, api_key):
    """Looks up one item by id. Seasons and episodes resolve to their series"""
    clean_url = jellyfin_url.rstrip('/')
    headers = {"X-Emby-Token": api_key}
    try:
        res = requests.get(f"{clean_url}/Items", headers=headers,
                           params={"Ids": item_id, "Recursive": "true", "Fields": "Path,Genres"}, timeout=10)
        items = res.json().get("Items", []) if res.status_code == 200 else []

        # Jellyfin ignores an invalid Ids filter and returns other items, so only the requested id is accepted
        wanted = str(item_id).replace("-", "").casefold()
        item = next((i for i in items if str(i.get("Id", "")).replace("-", "").casefold() == wanted), None)
        if not item:
            return None
        if item.get("Type") in ("Season", "Episode") and item.get("SeriesId"):
            return find_jellyfin_item(item["SeriesId"], jellyfin_url, api_key)
        return item if item.get("Type") in ("Series", "Movie") else None
    except Exception as e:
        print(f"[JELLYFIN] ❌ Error looking up item {item_id}: {e}")
        return None


def fetch_jellyfin_data(folder_name, jellyfin_url, api_key, folder_path=None):
    clean_url = jellyfin_url.rstrip('/')
    headers = {"X-Emby-Token": api_key}

    # STEP 0: Exact match by folder path against the library index
    item = match_media_folder(get_library_index(jellyfin_url, api_key), folder_path or folder_name)
    if item:
        print(f"[JELLYFIN] ✅ Matched by folder path: {item.get('Name')}")
        return _item_result(item, clean_url)

    def try_search(term):
        params = {
            "searchTerm": term,
            "IncludeItemTypes": "Series",
            "Recursive": "true",
            "Fields": "Genres"
        }
        try:
            res = requests.get(f"{clean_url}/Items", headers=headers, params=params, timeout=10)
            if res.status_code == 200:
                data = res.json()
                if data.get("Items") and len(data["Items"]) > 0:
                    series = data["Items"][0]
                    
                    genres_list = series.get("Genres", [])
                    genres_string = ", ".join(genres_list) if genres_list else ""

                    return {
                        "success": True, 
                        "official_name": series.get("Name"), 
                        "series_id": series.get("Id"),
                        "image_url": f"{clean_url}/Items/{series.get('Id')}/Images/Primary?format=jpg",
                        "genres": genres_string 
                    }
        except Exception:
            pass
        return {"success": False}

    # STEP 1: Precise Search
    precise_term = clean_search_name(folder_name, remove_year=False)
    print(f"\n[JELLYFIN] Searching (Precise Mode): '{precise_term}'...")
    result = try_search(precise_term)
    if result["success"]:
        print(f"[JELLYFIN] ✅ Found: {result['official_name']}")
        return result

    # STEP 2: Generic Search
    generic_term = clean_search_name(folder_name, remove_year=True)
    if generic_term != precise_term:
        print(f"[JELLYFIN] ⚠️ Not found. Trying Generic Search: '{generic_term}'...")
        result = try_search(generic_term)
        if result["success"]:
            print(f"[JELLYFIN] ✅ Found via Fallback: {result['official_name']}")
            return result

    # STEP 3: Significant Word Search (Smarter Fallback)
    words = generic_term.split()
    
    significant_words = [w for w in words if len(w) > 3]
    
    if len(significant_words) > 0:
        broad_term = significant_words[0]
        print(f"[JELLYFIN] ⚠️ Not found. Trying Broad Search: '{broad_term}'...")
        result = try_search(broad_term)
        if result["success"]:
            print(f"[JELLYFIN] ✅ Found via Broad Search: {result['official_name']}")
            return result
        
        if len(significant_words) > 1:
            broad_term_2 = f"{significant_words[0]} {significant_words[1]}"
            print(f"[JELLYFIN] ⚠️ Not found. Trying Ultra Broad Search: '{broad_term_2}'...")
            result = try_search(broad_term_2)
            if result["success"]:
                print(f"[JELLYFIN] ✅ Found via Ultra Broad Search: {result['official_name']}")
                return result

    print(f"[JELLYFIN] ❌ No series found for folder '{folder_name}'.")
    return {"success": False}

def download_jellyfin_image(image_url, api_key, dest_folder, file_name="cover.jpg"):
    headers = {"X-Emby-Token": api_key}
    full_path = os.path.join(dest_folder, file_name)
    
    try:
        print(f"[JELLYFIN] 📥 Starting cover image download...")
        res = requests.get(image_url, headers=headers, stream=True, timeout=15)
        
        if res.status_code == 200:
            content_type = res.headers.get('Content-Type', '').lower()
            if 'text' in content_type or 'html' in content_type:
                print(f"[JELLYFIN] ❌ Failed: Server returned HTML/text instead of an image. Auth/URL issue?")
                return None
                
            os.makedirs(dest_folder, exist_ok=True)
            with open(full_path, 'wb') as f:
                for chunk in res.iter_content(chunk_size=8192):
                    f.write(chunk)
            
            if os.path.exists(full_path) and os.path.getsize(full_path) > 1024:
                print(f"[JELLYFIN] 💾 Image saved successfully at: {full_path}")
                return full_path
            else:
                if os.path.exists(full_path): os.remove(full_path)
                return None
        else:
            print(f"[JELLYFIN] ❌ Failed to download image. Status: {res.status_code}")
            return None
    except Exception as e:
        print(f"[JELLYFIN] ❌ Error during image download: {e}")
        return None

def fetch_jellyfin_season_image(series_id, season_num, jellyfin_url, api_key):
    clean_url = jellyfin_url.rstrip('/')
    headers = {"X-Emby-Token": api_key}
    try:
        res = requests.get(f"{clean_url}/Shows/{series_id}/Seasons", headers=headers, timeout=10)
        if res.status_code == 200:
            data = res.json()
            for season in data.get("Items", []):
                if season.get("IndexNumber") == season_num:
                    season_id = season.get("Id")
                    if season_id:
                        print(f"[JELLYFIN] 🖼️ Found Season {season_num} specific cover!")
                        return f"{clean_url}/Items/{season_id}/Images/Primary?format=jpg"
    except Exception as e:
        print(f"[JELLYFIN] ❌ Error fetching season {season_num} data: {e}")
    return None


def refresh_jellyfin_media(folder, jellyfin_url, api_key):
    """Asks Jellyfin to rescan one media folder so new theme songs show up. Missing metadata only: customized
    images and fields are kept. Falls back to a full library scan when the folder has no item of its own"""
    clean_url = jellyfin_url.rstrip('/')
    headers = {"X-Emby-Token": api_key}
    try:
        item = match_media_folder(get_library_index(jellyfin_url, api_key), folder)
        if item:
            res = requests.post(f"{clean_url}/Items/{item['Id']}/Refresh", headers=headers, timeout=10, params={
                "Recursive": "true",
                "MetadataRefreshMode": "Default",
                "ImageRefreshMode": "Default",
                "ReplaceAllMetadata": "false",
                "ReplaceAllImages": "false"
            })
            target = f"'{item.get('Name')}'"
        else:
            res = requests.post(f"{clean_url}/Library/Refresh", headers=headers, timeout=10)
            target = "the whole library (folder not matched to an item)"

        if res.status_code in (200, 204):
            print(f"[JELLYFIN] 🔄 Rescan requested for {target}.")
            return True
        print(f"[JELLYFIN] ⚠️ Jellyfin refused the rescan of {target} (status {res.status_code}). The API key must be an admin key.")
    except Exception as e:
        print(f"[JELLYFIN] ⚠️ Could not request a rescan: {e}")
    return False


JS_INJECTOR_ID = 'f5a34f7b2e8a4e6aa7223a216a81b374'  # n00bcodr/Jellyfin-JavaScript-Injector
BUTTONS_SCRIPT_NAME = 'Themarr buttons'


def install_jellyfin_buttons(jellyfin_url, api_key, script):
    """Adds or updates the 'Themarr buttons' script in the JavaScript Injector plugin. Other scripts stay as they are"""
    clean_url = jellyfin_url.rstrip('/')
    headers = {"X-Emby-Token": api_key}
    try:
        res = requests.get(f"{clean_url}/Plugins", headers=headers, timeout=10)
        if res.status_code != 200:
            return {"success": False, "message": f"Jellyfin refused the plugin list (status {res.status_code}). The API key must be an admin key."}
        plugin = next((p for p in res.json() if str(p.get("Id", "")).replace("-", "").lower() == JS_INJECTOR_ID), None)
        if not plugin:
            return {"success": False, "message": "JavaScript Injector is not installed on Jellyfin. Add it under Dashboard > Plugins first."}

        config_url = f"{clean_url}/Plugins/{plugin['Id']}/Configuration"
        res = requests.get(config_url, headers=headers, timeout=10)
        if res.status_code != 200:
            return {"success": False, "message": f"Could not read the JavaScript Injector settings (status {res.status_code})."}
        config = res.json()
        scripts = config.get("CustomJavaScripts") or []

        entry = next((s for s in scripts if s.get("Name") == BUTTONS_SCRIPT_NAME), None)
        updated = entry is not None
        if not entry:
            entry = {"Name": BUTTONS_SCRIPT_NAME}
            scripts.append(entry)
        # Only signed-in users load it; the script itself shows the buttons to administrators only
        entry.update({"Script": script, "Enabled": True, "RequiresAuthentication": True})
        config["CustomJavaScripts"] = scripts

        res = requests.post(config_url, headers=headers, json=config, timeout=10)
        if res.status_code not in (200, 204):
            return {"success": False, "message": f"Jellyfin did not save the script (status {res.status_code})."}
        print(f"[JELLYFIN] 🔘 '{BUTTONS_SCRIPT_NAME}' {'updated' if updated else 'installed'} in JavaScript Injector {plugin.get('Version', '')}.")
        return {"success": True, "message": f"Buttons {'updated' if updated else 'installed'}. Reload the Jellyfin page (Ctrl+F5) to see them."}
    except Exception as e:
        return {"success": False, "message": f"Could not reach Jellyfin: {e}"}