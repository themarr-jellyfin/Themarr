"""Moving a theme between the main theme and the seasons of its media, and tag writing only when something changed.
Run from the repo root:
    PYTHONIOENCODING=utf-8 venv/Scripts/python.exe -m unittest discover tests"""
import os
import shutil
import tempfile
import unittest
from unittest import mock

from mutagen.id3 import ID3, TIT2

import api_controller
from api_controller import Api
from core.audio import inject_mp3_metadata

SILENT_MP3 = None


def silent_mp3():
    """One second of silence made with the bundled FFmpeg, shared by the tests"""
    global SILENT_MP3
    if SILENT_MP3 is None:
        import subprocess
        from core.config import FFMPEG_PATH
        fd, SILENT_MP3 = tempfile.mkstemp(suffix='.mp3')
        os.close(fd)
        subprocess.run([FFMPEG_PATH, '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                        '-t', '1', '-q:a', '9', SILENT_MP3], check=True)
    return SILENT_MP3


def tearDownModule():
    if SILENT_MP3 and os.path.exists(SILENT_MP3):
        os.remove(SILENT_MP3)


class MoveTrackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.show = os.path.join(self.tmp.name, "Show")
        os.makedirs(os.path.join(self.show, "Season 1"))
        os.makedirs(os.path.join(self.show, "Season 2"))
        self.api = Api()
        # No tagging or Jellyfin in these tests: only where the files end up
        self.patches = [mock.patch.object(Api, 'retag_track'), mock.patch.object(api_controller, '_start_background')]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def make(self, rel):
        path = os.path.join(self.show, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(rel.encode())
        return path

    def files(self):
        return sorted(os.path.relpath(os.path.join(d, f), self.show).replace(os.sep, "/")
                      for d, _, names in os.walk(self.show) for f in names)

    def test_main_to_season(self):
        opening = self.make("theme-music/Opening.mp3")
        self.make("theme-music/Ending.mp3")
        result = self.api.move_track(opening, "Season 1")
        self.assertTrue(result["success"], result)
        self.assertEqual(self.files(), ["Season 1/theme-music/Opening.mp3", "theme-music/Ending.mp3"])

    def test_last_main_theme_leaves_no_empty_folder(self):
        opening = self.make("theme-music/Opening.mp3")
        self.assertTrue(self.api.move_track(opening, "Season 1", "Opening 1")["success"])
        self.assertEqual(self.files(), ["Season 1/theme-music/Opening 1.mp3"])
        self.assertFalse(os.path.exists(os.path.join(self.show, "theme-music")))

    def test_season_to_main_moves_loose_theme_into_theme_music(self):
        self.make("theme.mp3")
        opening = self.make("Season 2/theme-music/Opening.mp3")
        self.assertTrue(self.api.move_track(opening, "Main Theme")["success"])
        self.assertEqual(self.files(), ["theme-music/Opening.mp3", "theme-music/theme.mp3"])

    def test_never_overwrites(self):
        self.make("Season 1/theme-music/Opening.mp3")
        opening = self.make("theme-music/Opening.mp3")
        result = self.api.move_track(opening, "Season 1")
        self.assertFalse(result["success"])
        with open(os.path.join(self.show, "Season 1/theme-music/Opening.mp3"), "rb") as f:
            self.assertEqual(f.read(), b"Season 1/theme-music/Opening.mp3")
        self.assertTrue(os.path.exists(opening))

    def test_loose_theme_name_clash(self):
        self.make("theme.mp3")
        other = self.make("Season 1/theme-music/theme.mp3")
        self.assertFalse(self.api.move_track(other, "Main Theme")["success"])
        self.assertEqual(self.files(), ["Season 1/theme-music/theme.mp3", "theme.mp3"])

    def test_only_seasons_of_the_same_media(self):
        opening = self.make("theme-music/Opening.mp3")
        for destination in ("Extras", "../Other/Season 1", "Season 9"):
            self.assertFalse(self.api.move_track(opening, destination)["success"], destination)
        self.assertEqual(self.files(), ["theme-music/Opening.mp3"])

    def test_same_place_is_a_rename(self):
        opening = self.make("Season 1/theme-music/Opening.mp3")
        self.assertTrue(self.api.move_track(opening, "Season 1", "OP")["success"])
        self.assertEqual(self.files(), ["Season 1/theme-music/OP.mp3"])


class TagOnlyIfChangedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mp3 = os.path.join(self.tmp.name, "theme.mp3")
        shutil.copy(silent_mp3(), self.mp3)
        self.cover = os.path.join(self.tmp.name, "cover.jpg")
        with open(self.cover, "wb") as f:
            f.write(b"\xff\xd8" + b"\x00" * 2048)

    def tearDown(self):
        self.tmp.cleanup()

    def test_writes_only_when_different(self):
        args = (self.mp3, self.cover, "Opening", "Show", "Drama")
        self.assertTrue(inject_mp3_metadata(*args, only_if_changed=True))
        self.assertFalse(inject_mp3_metadata(*args, only_if_changed=True))

        tags = ID3(self.mp3)
        tags.add(TIT2(encoding=3, text="Old title"))
        tags.save(v2_version=3)
        self.assertTrue(inject_mp3_metadata(*args, only_if_changed=True))

        with open(self.cover, "wb") as f:
            f.write(b"\xff\xd8" + b"\x01" * 2048)
        self.assertTrue(inject_mp3_metadata(*args, only_if_changed=True))
        self.assertFalse(inject_mp3_metadata(*args, only_if_changed=True))
        self.assertTrue(inject_mp3_metadata(self.mp3, self.cover, "Opening", "Show (2024)", "Drama", only_if_changed=True))


if __name__ == "__main__":
    unittest.main()
