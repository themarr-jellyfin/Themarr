import os
import re
import sys
import json
import shutil

def get_base_path():
    if getattr(sys, 'frozen', False):
        # Running as .exe (compiled by PyInstaller)
        return os.path.dirname(sys.executable)
    # Running as script
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

APP_VERSION = "1.14.7"

APP_ROOT_DIR = get_base_path()
# Files bundled by PyInstaller (templates, static, jellyfin) live in _internal next to the exe
BUNDLE_DIR = getattr(sys, '_MEIPASS', APP_ROOT_DIR)
IS_WINDOWS = os.name == 'nt'

# ==========================================
# SERVER MODE (Docker / headless Linux)
# ==========================================
# THEMARR_MODE=server turns on the headless web server: login, folder browser
# and the media safety guard (see core/safety.py). Desktop builds never set it.
SERVER_MODE = os.environ.get('THEMARR_MODE', '').strip().lower() == 'server'
MEDIA_ROOT = os.path.realpath(os.environ.get('THEMARR_MEDIA_ROOT', '/data')) if SERVER_MODE else None
SERVER_HOST = os.environ.get('THEMARR_HOST', '0.0.0.0')
SERVER_PORT = int(os.environ.get('THEMARR_PORT', '8686'))

def _parse_path_map(text):
    """THEMARR_PATH_MAP="/jellyfin/path=/themarr/path;...": where Themarr sees each folder Jellyfin reports. Longest prefix first"""
    pairs = []
    for entry in re.split(r'[;\n]+', text or ''):
        src, sep, dst = entry.partition('=')
        if sep and src.strip() and dst.strip():
            pairs.append((src.strip(), dst.strip()))
    return sorted(pairs, key=lambda pair: len(pair[0]), reverse=True)

PATH_MAP = _parse_path_map(os.environ.get('THEMARR_PATH_MAP'))

# Address the Jellyfin buttons open. Empty: the same host Jellyfin was opened on, port SERVER_PORT
PUBLIC_URL = os.environ.get('THEMARR_PUBLIC_URL', '').strip().rstrip('/')

def _find_ffmpeg():
    override = os.environ.get('THEMARR_FFMPEG')
    if override:
        return override
    if getattr(sys, 'frozen', False):
        bundled = os.path.join(APP_ROOT_DIR, '_internal', 'bin', 'ffmpeg.exe')
    else:
        bundled = os.path.join(APP_ROOT_DIR, 'bin', 'ffmpeg.exe')
    if os.path.exists(bundled) or IS_WINDOWS:
        return bundled
    return shutil.which('ffmpeg') or 'ffmpeg'

FFMPEG_PATH = _find_ffmpeg()

# User profile config folder (a mounted volume in Docker)
USER_HOME = os.path.expanduser('~')
CONFIG_FOLDER = os.environ.get('THEMARR_CONFIG_DIR') or os.path.join(USER_HOME, '.themarr_manager')
os.makedirs(CONFIG_FOLDER, exist_ok=True)

CONFIG_FILE = os.path.join(CONFIG_FOLDER, 'config.json')

# Exported backups: next to the app on desktop, inside the config volume on the server
BACKUP_DIR = os.path.join(CONFIG_FOLDER, 'backups') if SERVER_MODE else os.path.join(APP_ROOT_DIR, 'backups')

# ==========================================
# SETTINGS MANAGER
# ==========================================
def load_config():
    default_config = {
        "lufs": "-24",
        "jelly_check": False,
        "jelly_url": "",
        "jelly_api": "",
        "open_browser": True,
        "library_folders": [],
        "check_updates": True,
        "show_backdrops": True,
        "preview_volume": {"level": 1.0, "muted": False},
        "audio_fx": {
            "enabled": False,
            "remove_silence": False,
            "fade_in": 0,
            "fade_out": 0
        }
    }

    # Docker can preconfigure Jellyfin through the environment; saved settings still win
    if SERVER_MODE and os.environ.get('JELLYFIN_URL'):
        default_config["jelly_url"] = os.environ['JELLYFIN_URL']
        default_config["jelly_api"] = os.environ.get('JELLYFIN_API_KEY', '')
        default_config["jelly_check"] = bool(default_config["jelly_api"])

    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                for key in data:
                    if key in default_config:
                        default_config[key] = data[key]
        except Exception as e:
            print(f"[CONFIG] Error loading settings: {e}")

    return default_config

def save_config(data):
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        print(f"[CONFIG] Error saving settings: {e}")
