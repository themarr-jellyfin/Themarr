"""Download queue: order, pause, retry, and the one finishing pass per media.
Run from the repo root:
    PYTHONIOENCODING=utf-8 venv/Scripts/python.exe -m unittest discover tests"""
import threading
import time
import unittest
from unittest import mock

from core.jobs import ThemeQueue


def wait_until(condition, timeout=5):
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.02)
    return False


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.processed = []
        self.finished = []
        self.fail_names = set()
        self.gate = threading.Event()
        self.gate.set()

        def process(item, set_stage):
            set_stage("Downloading")
            self.gate.wait(5)
            if item["name"] in self.fail_names:
                raise RuntimeError("download failed")
            self.processed.append((item["name"], item["multi_main"]))

        def finish(folder, items):
            self.finished.append((folder, sorted(i["name"] for i in items)))

        self.queue = ThemeQueue(process, finish)

    def statuses(self):
        return [i["status"] for i in self.queue.snapshot()["items"]]

    def test_processes_in_order_and_finishes_each_media_once(self):
        self.queue.add("/m/A", [{"name": "A1", "destination": "Main Theme"}, {"name": "A2", "destination": "Main Theme"}])
        self.queue.add("/m/B", [{"name": "B1", "destination": "Season 1"}])
        self.assertTrue(wait_until(lambda: self.statuses() == ["completed"] * 3))
        self.assertTrue(wait_until(lambda: len(self.finished) == 2))
        # Two main themes for the same media go to theme-music, like a batch sent together
        self.assertEqual(self.processed, [("A1", True), ("A2", True), ("B1", False)])
        self.assertEqual(self.finished, [("/m/A", ["A1", "A2"]), ("/m/B", ["B1"])])

    def test_pause_holds_waiting_items(self):
        self.queue.set_paused(True)
        self.queue.add("/m/A", [{"name": "A1", "destination": "Main Theme"}])
        time.sleep(0.3)
        self.assertEqual(self.statuses(), ["waiting"])
        self.queue.set_paused(False)
        self.assertTrue(wait_until(lambda: self.statuses() == ["completed"]))

    def test_failed_item_can_be_retried_and_removed(self):
        self.fail_names.add("A1")
        item_id = self.queue.add("/m/A", [{"name": "A1", "destination": "Main Theme"}])[0]
        self.assertTrue(wait_until(lambda: self.statuses() == ["error"]))
        self.assertEqual(self.finished, [])

        self.fail_names.clear()
        self.assertTrue(self.queue.retry(item_id))
        self.assertTrue(wait_until(lambda: self.statuses() == ["completed"]))
        self.assertTrue(wait_until(lambda: self.finished == [("/m/A", ["A1"])]))

        self.queue.clear_finished()
        self.assertEqual(self.statuses(), [])

    def test_failure_is_recorded_when_the_console_cannot_print_it(self):
        # A console without UTF-8 used to kill the worker on the emoji in the error line, leaving "processing"
        def broken_print(*args, **kwargs):
            raise UnicodeEncodeError("charmap", "❌", 0, 1, "character maps to <undefined>")

        self.fail_names.add("A1")
        with mock.patch("builtins.print", broken_print):
            self.queue.add("/m/A", [{"name": "A1", "destination": "Main Theme"}, {"name": "A2", "destination": "Main Theme"}])
            self.assertTrue(wait_until(lambda: self.statuses() == ["error", "completed"]))

    def test_processing_item_cannot_be_removed(self):
        self.gate.clear()
        item_id = self.queue.add("/m/A", [{"name": "A1", "destination": "Main Theme"}])[0]
        self.assertTrue(wait_until(lambda: self.statuses() == ["processing"]))
        self.assertFalse(self.queue.remove(item_id))
        self.gate.set()
        self.assertTrue(wait_until(lambda: self.statuses() == ["completed"]))
        self.assertTrue(self.queue.remove(item_id))


if __name__ == "__main__":
    unittest.main()
