"""Why a link cannot be played or downloaded: yt-dlp errors turned into a reason the Add Theme panel and the Activity
page can explain. Run from the repo root:
    PYTHONIOENCODING=utf-8 venv/Scripts/python.exe -m unittest discover tests"""
import unittest
from unittest import mock

import yt_dlp

from core import audio

CASES = [
    ("ERROR: [youtube] abc123DEF45: Sign in to confirm your age. This video may be inappropriate for some users.", 'age', True),
    ("ERROR: [youtube] abc123DEF45: Join this channel to get access to members-only content like this video, and other exclusive perks.", 'members', True),
    ("ERROR: [youtube] abc123DEF45: Private video. Sign in if you've been granted access to this video", 'private', True),
    ("ERROR: [youtube] abc123DEF45: The uploader has not made this video available in your country", 'region', True),
    ("ERROR: [youtube] abc123DEF45: Video unavailable. This video contains content from SomeLabel, who has blocked it in your country on copyright grounds", 'region', True),
    ("ERROR: [youtube] abc123DEF45: This live event will begin in a few moments.", 'live', True),
    ("ERROR: [youtube] abc123DEF45: Video unavailable. This video has been removed by the uploader", 'removed', True),
    ("ERROR: [youtube] abc123DEF45: Sign in to confirm you’re not a bot. Use --cookies-from-browser", 'bot', False),
    ("ERROR: Unable to download webpage: <urlopen error timed out>", 'unknown', False),
]


class ExplainUnavailable(unittest.TestCase):
    def test_reasons(self):
        for text, reason, blocked in CASES:
            with self.subTest(text=text):
                why = audio.explain_unavailable(yt_dlp.utils.DownloadError(text))
                self.assertEqual(why['reason'], reason)
                self.assertEqual(why['blocked'], blocked)
                self.assertTrue(why['message'])

    def test_detail_drops_the_prefix_and_colors(self):
        why = audio.explain_unavailable("\x1b[0;31mERROR:\x1b[0m [youtube] abc123DEF45: Private video. Sign in\nmore")
        self.assertEqual(why['detail'], "Private video. Sign in")

    def test_preview_failure_carries_the_reason(self):
        error = yt_dlp.utils.DownloadError(CASES[0][0])
        with mock.patch.object(audio.yt_dlp, 'YoutubeDL') as ydl:
            ydl.return_value.__enter__.return_value.extract_info.side_effect = error
            result = audio.get_streaming_url("https://www.youtube.com/watch?v=abc123DEF45")
        self.assertFalse(result['success'])
        self.assertEqual(result['reason'], 'age')
        self.assertTrue(result['blocked'])

    def test_download_failure_says_why(self):
        error = yt_dlp.utils.DownloadError(CASES[2][0])
        with mock.patch.object(audio.yt_dlp, 'YoutubeDL') as ydl:
            ydl.return_value.__enter__.return_value.extract_info.side_effect = error
            with self.assertRaises(RuntimeError) as raised:
                audio.download_music("https://www.youtube.com/watch?v=abc123DEF45")
        self.assertIn("This video is private.", str(raised.exception))


if __name__ == '__main__':
    unittest.main()
