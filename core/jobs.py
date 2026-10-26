"""Download queue. Themes added from any page wait here and are processed one at a time in the background, so the
queue keeps going when the page is closed. When the last theme of a media folder is done, that folder gets its
finishing pass (season cleanup, cover art and tags, Jellyfin rescan) once."""
import itertools
import os
import threading

ACTIVE = ('waiting', 'processing')


def _log(text):
    # The worker thread must survive a console that cannot print emojis (the app's own log redirector already
    # ignores that, a plain stdout does not)
    try:
        print(text)
    except (UnicodeEncodeError, OSError):
        pass


class ThemeQueue:
    def __init__(self, process_item, finish_media):
        self._process_item = process_item    # (item, set_stage) -> None, raises on failure
        self._finish_media = finish_media    # (media_folder, finished_items) -> None
        self._items = []
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._ids = itertools.count(1)
        self.paused = False
        threading.Thread(target=self._run, daemon=True).start()

    def add(self, media_folder, entries):
        with self._lock:
            ids = []
            for entry in entries:
                item = dict(entry, id=next(self._ids), media_folder=media_folder,
                            media_name=os.path.basename(media_folder), status='waiting', stage='', progress=None, message='')
                self._items.append(item)
                ids.append(item['id'])
        self._wake.set()
        return ids

    def snapshot(self):
        with self._lock:
            return {"paused": self.paused, "items": [dict(i) for i in self._items]}

    def busy(self):
        with self._lock:
            return any(i['status'] == 'processing' for i in self._items) or \
                (not self.paused and any(i['status'] == 'waiting' for i in self._items))

    def remove(self, item_id):
        with self._lock:
            item = self._find(item_id)
            if not item or item['status'] == 'processing':
                return False
            self._items.remove(item)
            return True

    def retry(self, item_id):
        with self._lock:
            item = self._find(item_id)
            if not item or item['status'] != 'error':
                return False
            item.update(status='waiting', stage='', progress=None, message='', finished=False)
        self._wake.set()
        return True

    def clear_finished(self):
        with self._lock:
            self._items = [i for i in self._items if i['status'] in ACTIVE or i['status'] == 'error']

    def set_paused(self, paused):
        self.paused = bool(paused)
        self._wake.set()

    def _find(self, item_id):
        return next((i for i in self._items if i['id'] == item_id), None)

    def _next(self):
        with self._lock:
            if self.paused:
                return None
            item = next((i for i in self._items if i['status'] == 'waiting'), None)
            if not item:
                return None
            item['status'] = 'processing'
            # Several main themes queued for one media all go to theme-music/, as when they were sent together
            item['multi_main'] = sum(1 for i in self._items if i['media_folder'] == item['media_folder']
                                     and i.get('destination') == 'Main Theme'
                                     and (i['status'] in ACTIVE or (i['status'] == 'completed' and not i.get('finished')))) > 1
            return item

    def _run(self):
        while True:
            item = self._next()
            if not item:
                self._wake.wait(1)
                self._wake.clear()
                continue

            def set_stage(text, progress=None, item=item):
                item['stage'] = text
                item['progress'] = progress

            try:
                self._process_item(dict(item), set_stage)
                item.update(status='completed', stage='', progress=None)
            except Exception as e:
                # The status first: if logging fails too, the item must not stay "processing" forever
                item.update(status='error', stage='', progress=None, message=str(e))
                _log(f"[QUEUE] ❌ '{item.get('name')}' failed: {e}")

            try:
                self._finish_if_done(item['media_folder'])
            except Exception as e:
                _log(f"[QUEUE] ⚠️ Finishing '{os.path.basename(item['media_folder'])}' failed: {e}")

    def _finish_if_done(self, media_folder):
        with self._lock:
            if any(i['media_folder'] == media_folder and i['status'] in ACTIVE for i in self._items):
                return
            done = [i for i in self._items if i['media_folder'] == media_folder
                    and i['status'] == 'completed' and not i.get('finished')]
            for i in done:
                i['finished'] = True
        if done:
            try:
                self._finish_media(media_folder, [dict(i) for i in done])
            except Exception as e:
                _log(f"[QUEUE] ⚠️ Finishing '{os.path.basename(media_folder)}' failed: {e}")
