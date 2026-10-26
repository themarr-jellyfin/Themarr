"""Theme sources: the text search of each source, and ThemerrDB suggestions (ids from folder names and Jellyfin,
media kind, lookups, cache and removed videos). The network and yt-dlp are mocked. Run from the repo root:
    PYTHONIOENCODING=utf-8 venv/Scripts/python.exe -m unittest discover tests"""
import os
import tempfile
import unittest
from unittest import mock

import requests

from core import sources

THEME = "https://www.youtube.com/watch?v=SLBACEP6LsI"


def response(status, payload=None):
    res = mock.Mock(status_code=status)
    res.json.return_value = payload or {}
    return res


class FakeWeb:
    """requests.get stand-in: ThemerrDB answers from `entries` (url path -> theme link), oEmbed from `videos`"""
    def __init__(self, entries=None, videos=None):
        self.entries = entries or {}
        self.videos = videos if videos is not None else {THEME: {"title": "Main Title", "author_name": "Composer"}}
        self.calls = []

    def __call__(self, url, params=None, headers=None, timeout=None):
        self.calls.append(url if not params else f"{url}?{params.get('url')}")
        if url == sources.OEMBED_URL:
            video = self.videos.get(params["url"])
            return response(200, video) if video else response(404)
        path = url.replace(sources.THEMERRDB_URL + "/", "")
        link = self.entries.get(path)
        return response(200, {"youtube_theme_url": link}) if link else response(404)


class IdTests(unittest.TestCase):
    def test_folder_tags(self):
        self.assertEqual(sources.ids_from_folder_name("The Matrix (1999) [tmdbid-603]"), {"tmdb": "603"})
        self.assertEqual(sources.ids_from_folder_name("The Matrix [imdbid-tt0133093] [tmdbid-603]"),
                         {"imdb": "tt0133093", "tmdb": "603"})
        self.assertEqual(sources.ids_from_folder_name("The Matrix {tmdb-603}"), {"tmdb": "603"})
        self.assertEqual(sources.ids_from_folder_name("Show [tmdbid=1399]"), {"tmdb": "1399"})

    def test_no_tags(self):
        self.assertEqual(sources.ids_from_folder_name("The Matrix (1999)"), {})
        self.assertEqual(sources.ids_from_folder_name("Show [tvdbid-121361]"), {})

    def test_jellyfin_provider_ids(self):
        self.assertEqual(sources.ids_from_jellyfin({"Tmdb": "603", "Imdb": "tt0133093", "Tvdb": "1"}),
                         {"tmdb": "603", "imdb": "tt0133093"})
        self.assertEqual(sources.ids_from_jellyfin(None), {})
        self.assertEqual(sources.ids_from_jellyfin({"Tmdb": ""}), {})

    def test_video_id(self):
        self.assertEqual(sources.youtube_video_id(THEME), "SLBACEP6LsI")
        self.assertEqual(sources.youtube_video_id("https://youtu.be/SLBACEP6LsI"), "SLBACEP6LsI")
        self.assertIsNone(sources.youtube_video_id("https://soundcloud.com/x/y"))


class KindTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, name):
        open(os.path.join(self.folder, name), "w").close()

    def test_season_folders_mean_tv(self):
        self.assertEqual(sources.guess_media_kind(self.folder, ["Season 01"]), "tv")

    def test_episode_files_mean_tv(self):
        self.touch("Show S01E01.mkv")
        self.assertEqual(sources.guess_media_kind(self.folder), "tv")

    def test_single_video_is_a_movie(self):
        self.touch("The Matrix (1999).mkv")
        self.assertEqual(sources.guess_media_kind(self.folder), "movie")

    def test_missing_folder(self):
        self.assertEqual(sources.guess_media_kind(os.path.join(self.folder, "nope")), "movie")


class LookupTests(unittest.TestCase):
    def setUp(self):
        sources._cache.clear()

    def lookup(self, web, kind, ids):
        with mock.patch.object(sources.requests, "get", side_effect=web):
            return sources.themerrdb_theme(kind, ids)

    def test_movie_by_tmdb(self):
        web = FakeWeb({"movies/themoviedb/603.json": THEME})
        result = self.lookup(web, "movie", {"tmdb": "603"})
        self.assertEqual(result["url"], THEME)
        self.assertEqual(result["title"], "Main Title")
        self.assertEqual(result["channel"], "Composer")
        self.assertEqual(result["source"], "themerrdb")
        self.assertIn("SLBACEP6LsI", result["thumbnail"])

    def test_movie_falls_back_to_imdb(self):
        web = FakeWeb({"movies/imdb/tt0133093.json": THEME})
        self.assertEqual(self.lookup(web, "movie", {"tmdb": "603", "imdb": "tt0133093"})["url"], THEME)

    def test_tv_uses_tmdb_only(self):
        web = FakeWeb({"tv_shows/themoviedb/1399.json": THEME})
        self.assertEqual(self.lookup(web, "tv", {"tmdb": "1399"})["url"], THEME)
        # A TV show is never looked up in the movie list, where the same number is another title
        self.assertFalse(any("movies/" in call for call in web.calls))
        self.assertIsNone(self.lookup(FakeWeb(), "tv", {"imdb": "tt0944947"}))

    def test_not_listed(self):
        self.assertIsNone(self.lookup(FakeWeb(), "movie", {"tmdb": "1"}))

    def test_removed_video(self):
        web = FakeWeb({"movies/themoviedb/603.json": THEME}, videos={})
        self.assertIsNone(self.lookup(web, "movie", {"tmdb": "603"}))

    def test_answers_are_cached(self):
        web = FakeWeb({"movies/themoviedb/603.json": THEME})
        self.lookup(web, "movie", {"tmdb": "603"})
        self.lookup(web, "movie", {"tmdb": "603"})
        self.lookup(web, "movie", {"tmdb": "2"})
        self.lookup(web, "movie", {"tmdb": "2"})
        self.assertEqual(len(web.calls), 3)  # 603 + its oEmbed, then 2 once

    def test_offline_is_not_cached(self):
        with mock.patch.object(sources.requests, "get", side_effect=requests.ConnectionError("offline")):
            self.assertIsNone(sources.themerrdb_theme("movie", {"tmdb": "603"}))
        web = FakeWeb({"movies/themoviedb/603.json": THEME})
        self.assertEqual(self.lookup(web, "movie", {"tmdb": "603"})["url"], THEME)

    def test_youtube_unreachable_keeps_the_pick(self):
        def web(url, params=None, headers=None, timeout=None):
            if url == sources.OEMBED_URL:
                raise requests.ConnectionError("blocked")
            return response(200, {"youtube_theme_url": THEME})
        result = self.lookup(web, "movie", {"tmdb": "603"})
        self.assertEqual(result["url"], THEME)
        self.assertEqual(result["title"], "Theme picked by ThemerrDB")


class SearchTests(unittest.TestCase):
    def run_search(self, source, entries):
        with mock.patch.object(sources, "_flat_search", return_value=entries) as flat:
            return sources.search("charade theme", source), flat.call_args[0][0]

    def test_youtube(self):
        results, target = self.run_search("youtube", [
            {"id": "abc", "title": "Charade", "uploader": "Studio", "duration": 125}])
        self.assertEqual(target, "ytsearch35:charade theme")
        self.assertEqual(results, [{"title": "Charade", "url": "https://www.youtube.com/watch?v=abc", "channel": "Studio",
                                    "duration": "2:05", "thumbnail": "https://i.ytimg.com/vi/abc/mqdefault.jpg",
                                    "source": "youtube", "live": False}])

    def test_youtube_marks_live_streams(self):
        results, _ = self.run_search("youtube", [{"id": "live1", "title": "Radio", "live_status": "is_live"}])
        self.assertTrue(results[0]["live"])

    def test_youtube_music_links_to_youtube(self):
        results, target = self.run_search("youtube_music", [
            {"id": "eEP7OCfttdc", "title": "Charade (Main Title)", "url": "https://music.youtube.com/watch?v=eEP7OCfttdc"},
            {"title": "no id"}])
        self.assertEqual(target, "https://music.youtube.com/search?q=charade+theme#songs")
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["url"], "https://www.youtube.com/watch?v=eEP7OCfttdc")
        self.assertEqual(results[0]["duration"], "")
        self.assertEqual(results[0]["source"], "youtube_music")

    def test_soundcloud(self):
        results, target = self.run_search("soundcloud", [{
            "title": "Charade: Theme", "uploader": "Henry Mancini", "duration": 30.0,
            "url": "https://api.soundcloud.com/tracks/1", "webpage_url": "https://soundcloud.com/a/charade",
            "thumbnails": [{"id": "mini", "url": "m.jpg"}, {"id": "t300x300", "url": "t300.jpg"}]}])
        self.assertEqual(target, "scsearch20:charade theme")
        self.assertEqual(results[0]["url"], "https://api.soundcloud.com/tracks/1")
        self.assertEqual(results[0]["duration"], "0:30")
        self.assertEqual(results[0]["thumbnail"], "t300.jpg")
        self.assertEqual(results[0]["source"], "soundcloud")

    def test_unknown_source_searches_youtube(self):
        _, target = self.run_search("spotify", [])
        self.assertTrue(target.startswith("ytsearch"))

    def test_failure_and_empty_query(self):
        with mock.patch.object(sources, "_flat_search", side_effect=RuntimeError("blocked")):
            self.assertEqual(sources.search("x", "soundcloud"), [])
        self.assertEqual(sources.search("  ", "youtube"), [])


if __name__ == "__main__":
    unittest.main()
