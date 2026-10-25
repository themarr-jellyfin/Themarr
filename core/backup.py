"""Theme backups: every theme of one library in a .zip, with paths relative to the library folder, and the restore
that puts each theme back in the media folder of the same name. Both run in a background thread, one at a time, and
report their progress in `state`, which the Settings page polls."""
import os
import re
import shutil
import threading
import time
import zipfile

from core.safety import is_theme_file, check_theme_write, UnsafeMediaOperation

NAME = re.compile(r'Themarr_Backup_(?:[A-Za-z0-9-]+_)?\d{8}_\d{6}\.zip')

state = {"task": "", "stage": "idle", "done": 0, "total": 0, "size": 0, "message": "", "filename": "", "path": ""}
_lock = threading.Lock()
_cancel = threading.Event()


def running():
    return state["stage"] in ("scanning", "working")


def cancel():
    if running():
        _cancel.set()


def _start(task, target, *args):
    with _lock:
        if running():
            return False
        _cancel.clear()
        state.update(task=task, stage="scanning", done=0, total=0, size=0, message="", filename="", path="")
    threading.Thread(target=_guard, args=(target,) + args, daemon=True).start()
    return True


def _guard(target, *args):
    try:
        target(*args)
    except Exception as e:
        print(f"[BACKUP] {state['task'].capitalize()} failed: {e}")
        state.update(stage="error", message=str(e))


def theme_members(zipf):
    """(member, path parts) of every theme file in the zip. Other files and paths that would leave the library are skipped."""
    found = []
    for info in zipf.infolist():
        if info.is_dir():
            continue
        parts = [p for p in info.filename.replace('\\', '/').split('/') if p]
        if len(parts) < 2 or any(p in ('.', '..') or ':' in p for p in parts):
            continue
        if is_theme_file('/'.join(parts)):
            found.append((info, parts))
    return found


def read_backup(zip_path, root):
    """Media folders in the backup, the ones this library does not have, and the number of themes"""
    with zipfile.ZipFile(zip_path) as zipf:
        members = theme_members(zipf)
    folders = sorted({parts[0] for _, parts in members})
    missing = [f for f in folders if not os.path.isdir(os.path.join(root, f))]
    return folders, missing, len(members)


# ---------------- Export ----------------
def start_export(list_files, root, zip_path):
    """list_files() returns the theme files; it runs in the thread too, since reading a big library takes a while"""
    return _start("export", _export, list_files, root, zip_path)


def _export(list_files, root, zip_path):
    files = [f for f in list_files() if os.path.isfile(f)]
    if not files:
        return state.update(stage="error", message="No theme audio files found to back up.")
    state.update(stage="working", total=len(files), filename=os.path.basename(zip_path), path=zip_path)

    # MP3 is already compressed: storing is much faster and the zip comes out the same size
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zipf:
        for path in files:
            if _cancel.is_set():
                break
            zipf.write(path, os.path.relpath(path, root))
            state["done"] += 1

    if _cancel.is_set():
        os.remove(zip_path)
        return state.update(stage="cancelled", message="Backup cancelled.")
    state.update(stage="done", size=os.path.getsize(zip_path), message=f"Backup created with {len(files)} theme(s).")


# ---------------- Restore ----------------
def start_restore(zip_path, root, create_missing, remove_zip):
    """Themes of media folders this library does not have are skipped, unless create_missing (desktop only)"""
    return _start("restore", _restore, zip_path, root, create_missing, remove_zip)


def _restore(zip_path, root, create_missing, remove_zip):
    restored = 0
    try:
        with zipfile.ZipFile(zip_path) as zipf:
            members = [(info, parts) for info, parts in theme_members(zipf)
                       if create_missing or os.path.isdir(os.path.join(root, parts[0]))]
            state.update(stage="working", total=len(members))
            for info, parts in members:
                if _cancel.is_set():
                    break
                if _restore_one(zipf, info, parts, root):
                    restored += 1
                state["done"] += 1
    finally:
        if remove_zip and os.path.isfile(zip_path):
            os.remove(zip_path)

    if _cancel.is_set():
        return state.update(stage="cancelled", message=f"Restore stopped. {restored} theme(s) restored.")
    state.update(stage="done", message=f"Restore complete. {restored} theme(s) restored.")


def _restore_one(zipf, info, parts, root):
    media = os.path.join(root, parts[0])
    if not os.path.isdir(media):
        os.makedirs(media, exist_ok=True)
        print(f"[IMPORT] Creating missing media folder: '{parts[0]}'")

    dest = os.path.join(root, *parts)
    try:
        check_theme_write(dest, "import")
    except UnsafeMediaOperation as blocked:
        print(f"[IMPORT] {blocked}")
        return False

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # Written beside the theme and swapped in at the end, so a failure never leaves a half-written theme
    partial = dest + '.part'
    try:
        with zipf.open(info) as src, open(partial, 'wb') as out:
            shutil.copyfileobj(src, out)
        os.replace(partial, dest)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    stamp = time.mktime(info.date_time + (0, 0, -1))
    os.utime(dest, (stamp, stamp))
    return True
