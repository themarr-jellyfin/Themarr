"""Theme backups: export, restore into the same media folders, and zips that try to write elsewhere.
Run from the repo root:
    PYTHONIOENCODING=utf-8 venv/Scripts/python.exe -m unittest discover tests"""
import os
import tempfile
import time
import unittest
import zipfile

from core import backup

THEMES = ("Show/theme.mp3", "Show/Season 1/theme-music/Opening.mp3", "Film (1999)/theme-music/Main.mp3")


def wait():
    for _ in range(200):
        if not backup.running():
            return backup.state
        time.sleep(0.02)
    raise AssertionError("backup thread did not finish")


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.library = os.path.join(self.tmp.name, "TV")
        for rel in THEMES + ("Show/Season 1/ep01.mkv",):
            path = os.path.join(self.library, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(rel.encode())
        self.zip_path = os.path.join(self.tmp.name, "backup.zip")

    def tearDown(self):
        self.tmp.cleanup()

    def export(self):
        files = [os.path.join(self.library, rel) for rel in THEMES]
        self.assertTrue(backup.start_export(lambda: files, self.library, self.zip_path))
        return wait()

    def test_export_reports_progress_and_keeps_paths(self):
        state = self.export()
        self.assertEqual((state["stage"], state["done"], state["total"]), ("done", 3, 3))
        with zipfile.ZipFile(self.zip_path) as zipf:
            self.assertEqual(sorted(n.replace("\\", "/") for n in zipf.namelist()), sorted(THEMES))

    def test_restore_skips_missing_media_folders(self):
        self.export()
        target = os.path.join(self.tmp.name, "Other")
        os.makedirs(os.path.join(target, "Show"))
        folders, missing, themes = backup.read_backup(self.zip_path, target)
        self.assertEqual((folders, missing, themes), (["Film (1999)", "Show"], ["Film (1999)"], 3))

        backup.start_restore(self.zip_path, target, False, False)
        state = wait()
        self.assertEqual((state["stage"], state["total"]), ("done", 2))
        with open(os.path.join(target, "Show", "Season 1", "theme-music", "Opening.mp3"), "rb") as f:
            self.assertEqual(f.read(), b"Show/Season 1/theme-music/Opening.mp3")
        self.assertFalse(os.path.exists(os.path.join(target, "Film (1999)")))
        self.assertTrue(os.path.isfile(self.zip_path))

    def test_restore_creates_missing_folders_and_removes_upload(self):
        self.export()
        target = os.path.join(self.tmp.name, "Empty")
        os.makedirs(target)
        backup.start_restore(self.zip_path, target, True, True)
        self.assertEqual(wait()["done"], 3)
        self.assertTrue(os.path.isfile(os.path.join(target, "Film (1999)", "theme-music", "Main.mp3")))
        self.assertFalse(os.path.exists(self.zip_path))

    def test_zip_cannot_write_outside_the_library_or_other_files(self):
        with zipfile.ZipFile(self.zip_path, "w") as zipf:
            for name in ("../evil/theme.mp3", "/abs/theme.mp3", "C:/x/theme.mp3", "Show/ep02.mkv",
                         "Show/song.mp3", "theme.mp3", "Show/theme-music/Good.mp3"):
                zipf.writestr(name, b"x")
        with zipfile.ZipFile(self.zip_path) as zipf:
            names = ["/".join(parts) for _, parts in backup.theme_members(zipf)]
        self.assertEqual(names, ["abs/theme.mp3", "Show/theme-music/Good.mp3"])


if __name__ == "__main__":
    unittest.main()
