// Themarr web UI: shared helpers, router and the background polling of the queue and logs.
// Each page lives in its own file and registers itself in App.pages with a render(view, arg) function.

const App = {
    info: {},
    settings: {},
    library: null,          // { libraries, media } from /api/library
    queue: { paused: false, items: [] },
    status: {},
    logs: [],
    pages: {},
    route: { name: null, arg: null },
    search: '',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function icon(name, cls = '') {
    return `<i data-lucide="${name}" class="${cls}"></i>`;
}

// Text search sources of Add Theme, as in core/sources.py SEARCH_SOURCES
const SEARCH_SOURCES = [['youtube', 'YouTube'], ['youtube_music', 'YouTube Music'], ['soundcloud', 'SoundCloud']];

// Small tag naming where a suggestion came from; plain YouTube search results have none
function sourceBadge(result) {
    if (result?.source !== 'themerrdb') return '';
    return `<span class="inline-block align-middle text-[10px] leading-4 px-1.5 rounded bg-accent-soft text-accent-text font-medium" title="Community pick from ThemerrDB">ThemerrDB</span>`;
}

// "1:32 · Channel", leaving out what is unknown (ThemerrDB picks come without a duration)
function resultInfo(result) {
    return [result.duration, result.channel].filter(Boolean).map(esc).join(' · ');
}

function refreshIcons() {
    if (window.lucide) lucide.createIcons();
}

function fmtTime(seconds) {
    if (seconds == null || isNaN(seconds)) return '0:00';
    seconds = Math.max(0, Math.round(seconds));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// 65.43 -> "1:05.4", for trim points
function fmtTimePrecise(seconds) {
    if (seconds == null || isNaN(seconds)) return '0:00.0';
    seconds = Math.max(0, Math.round(seconds * 10) / 10);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

// "75", "1:15" or "0:01:15" -> 75. Empty or invalid -> null
function parseTime(text) {
    text = String(text ?? '').trim();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) return parseFloat(text);
    const parts = text.split(':').map(Number);
    if (parts.some(isNaN) || parts.length > 3) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

async function api(path, body) {
    const options = body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    };
    const response = await fetch(path, options);
    if (response.status === 401) {
        location.href = '/login';
        throw new Error('Login required');
    }
    const data = await response.json().catch(() => null);
    if (data === null) throw new Error(`Unexpected answer from the server (${response.status})`);
    return data;
}

// ---------------------------------------------------------------------------
// Toasts, dialogs and menus
// ---------------------------------------------------------------------------
function toast(message, type = 'info') {
    const colors = { success: 'text-green-400', error: 'text-red-400', info: 'text-accent-text' };
    const icons = { success: 'circle-check', error: 'circle-alert', info: 'info' };
    const el = document.createElement('div');
    el.className = 'toast-enter pointer-events-auto card shadow-2xl px-4 py-3 flex items-start gap-3 max-w-sm text-[13px]';
    el.innerHTML = `<span class="${colors[type] || colors.info} mt-0.5">${icon(icons[type] || 'info')}</span><span>${esc(message)}</span>`;
    document.getElementById('toasts').appendChild(el);
    refreshIcons();
    setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
}

function openDialog(html, { wide = false } = {}) {
    const dialog = document.getElementById('dialog');
    dialog.className = `card w-full ${wide ? 'max-w-2xl' : 'max-w-md'} shadow-2xl`;
    dialog.innerHTML = html;
    document.getElementById('dialogOverlay').classList.remove('hidden');
    refreshIcons();
    return dialog;
}

function closeDialog() {
    document.getElementById('dialogOverlay').classList.add('hidden');
    document.getElementById('dialog').innerHTML = '';
}

// Promise<boolean>. Replaces window.confirm, which would freeze the desktop window
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise(resolve => {
        const dialog = openDialog(`
            <div class="p-5">
                <h2 class="font-semibold text-[15px]">${esc(title)}</h2>
                <p class="text-muted mt-2 leading-relaxed">${message}</p>
            </div>
            <div class="px-5 py-3 border-t border-line flex justify-end gap-2">
                <button data-answer="no" class="btn btn-ghost">Cancel</button>
                <button data-answer="yes" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirmLabel)}</button>
            </div>`);
        dialog.querySelectorAll('[data-answer]').forEach(button => button.onclick = () => {
            closeDialog();
            resolve(button.dataset.answer === 'yes');
        });
    });
}

let openMenuEl = null;

function closeMenu() {
    if (openMenuEl) openMenuEl.remove();
    openMenuEl = null;
}

// items: [{ label, icon, onClick, danger }] or 'divider'
function showMenu(anchor, items) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'menu';
    items.forEach(item => {
        if (item === 'divider') {
            menu.appendChild(document.createElement('hr'));
            return;
        }
        const button = document.createElement('button');
        if (item.danger) button.className = 'danger';
        button.innerHTML = `${icon(item.icon)}<span>${esc(item.label)}</span>`;
        button.onclick = event => { event.stopPropagation(); closeMenu(); item.onClick(); };
        menu.appendChild(button);
    });
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    const below = rect.bottom + 4 + menu.offsetHeight < window.innerHeight;
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = below ? `${rect.bottom + 4}px` : `${rect.top - menu.offsetHeight - 4}px`;
    openMenuEl = menu;
    refreshIcons();
}

document.addEventListener('click', event => {
    if (openMenuEl && !openMenuEl.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    closeMenu();
    if (!document.getElementById('dialogOverlay').classList.contains('hidden')) closeDialog();
    else if (App.pages.addTheme) App.pages.addTheme.minimize();
});

// ---------------------------------------------------------------------------
// Posters
// ---------------------------------------------------------------------------
const POSTER_COLORS = ['#3b2a6b', '#1e4d5c', '#5c3a1e', '#2a4d2a', '#5c1e3a', '#2a3a5c', '#4d4d1e', '#1e5c4d'];

function posterHtml(media, extraClass = '') {
    const name = media.jellyfin?.name || media.media_name;
    let hash = 0;
    for (const ch of media.media_name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const color = POSTER_COLORS[hash % POSTER_COLORS.length];
    const src = posterUrl(media);
    const image = src ? `<img src="${src}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<div class="poster ${extraClass}" style="background: linear-gradient(160deg, ${color}, #14141c)">
        <span class="poster-letter">${esc(name.trim()[0] || '?')}</span>${image}</div>`;
}

// Jellyfin poster first, then artwork saved in the media folder (poster.jpg, folder.jpg, cover.jpg).
// The version in the URL changes with the image, so a poster replaced in Jellyfin is not kept from the browser cache
function posterUrl(media) {
    const jf = media.jellyfin;
    if (jf?.id) return `/api/jellyfin/image/${jf.id}?v=${encodeURIComponent(jf.image || '')}`;
    if (media.has_cover) return `/api/media/cover?path=${encodeURIComponent(media.folder_path)}&v=${media.cover_version || 0}`;
    return '';
}

// Wide background art: the Jellyfin backdrop, its thumb when there is no backdrop, then fanart.jpg and the like
// saved in the media folder. Empty when Backdrops is off in Settings
function backdropUrl(media) {
    if (App.settings.show_backdrops === false) return '';
    const jf = media.jellyfin;
    if (jf?.backdrop) return `/api/jellyfin/image/${jf.id}?type=Backdrop&v=${encodeURIComponent(jf.backdrop)}`;
    if (jf?.thumb) return `/api/jellyfin/image/${jf.id}?type=Thumb&v=${encodeURIComponent(jf.thumb)}`;
    if (media.backdrop_version) return `/api/media/cover?path=${encodeURIComponent(media.folder_path)}&kind=backdrop&v=${media.backdrop_version}`;
    return '';
}

// Title logo from Jellyfin or logo.png in the media folder, shown in place of the name on the media page
function logoUrl(media) {
    const jf = media.jellyfin;
    if (jf?.logo) return `/api/jellyfin/image/${jf.id}?type=Logo&v=${encodeURIComponent(jf.logo)}`;
    if (media.logo_version) return `/api/media/cover?path=${encodeURIComponent(media.folder_path)}&kind=logo&v=${media.logo_version}`;
    return '';
}

// The art behind the whole page. style: 'media' (blurred and dark, under the track list) or 'library' (faint).
// The image fades in once loaded, so a slow image never flashes half drawn
App.setBackdrop = function (url, style = 'media') {
    const layer = document.getElementById('backdrop');
    if (layer.dataset.url === (url || '')) return;
    layer.dataset.url = url || '';
    layer.classList.remove('on');
    if (!url) return;
    const img = new Image();
    img.onload = () => {
        if (layer.dataset.url !== url) return;
        layer.className = `page-backdrop ${style}`;
        layer.replaceChildren(img);
        requestAnimationFrame(() => layer.classList.add('on'));
    };
    img.alt = '';
    img.src = url;
};

// Id tags in folder names ([tmdbid-603], {imdb-tt0133093}) are for the apps, not for reading
function mediaTitle(media) {
    return media.jellyfin?.name
        || media.media_name.replace(/\s*[\[{](tmdb|tvdb|imdb)(id)?[-=][^\]}]*[\]}]/gi, '').trim()
        || media.media_name;
}

// ---------------------------------------------------------------------------
// Audio player: one <audio> for the whole app, so only one preview plays at a time
// ---------------------------------------------------------------------------
const Player = {
    el: null,
    key: null,
    listeners: new Set(),

    init() {
        this.el = document.getElementById('player');
        ['timeupdate', 'play', 'pause', 'ended', 'loadedmetadata'].forEach(type =>
            this.el.addEventListener(type, () => this.notify()));
        this.el.addEventListener('error', () => {
            if (this.key) toast('Could not play this audio.', 'error');
            this.stop();
        });
        // The volume is saved in the settings (the desktop window forgets browser storage when it closes),
        // once the slider stops moving
        let saveTimer = null;
        this.el.addEventListener('volumechange', () => {
            Volume.sync();
            if (this.restoringVolume) return;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => App.saveSettings({ preview_volume: { level: this.el.volume, muted: this.el.muted } }), 600);
        });
    },

    restoreVolume(saved) {
        if (!saved) return;
        this.restoringVolume = true;
        this.el.volume = Math.min(1, Math.max(0, Number(saved.level ?? 1)));
        this.el.muted = !!saved.muted;
        // volumechange arrives after this returns
        setTimeout(() => { this.restoringVolume = false; });
    },

    // Moving the volume above zero unmutes, like YouTube and Jellyfin
    setVolume(level) {
        level = Math.min(1, Math.max(0, level));
        this.el.volume = level;
        this.el.muted = level === 0;
    },

    // Unmuting at zero volume comes back at half, otherwise nothing would be heard
    setMuted(muted) {
        if (!muted && this.el.volume === 0) this.el.volume = 0.5;
        this.el.muted = muted;
    },

    // Plays url for `key`; calling again with the same key pauses or resumes
    toggle(key, url, startAt = null) {
        if (this.key === key && this.el.src) {
            this.el.paused ? this.el.play() : this.el.pause();
            return;
        }
        this.key = key;
        this.pendingSeek = null;
        this.el.src = url;
        if (startAt != null) this.el.addEventListener('loadedmetadata', () => { this.el.currentTime = startAt; }, { once: true });
        this.el.play().catch(() => {});
        this.notify();
    },

    seek(seconds) {
        if (this.el.src) this.el.currentTime = Math.max(0, seconds);
    },

    // Moves `key` to `seconds` without starting it, loading it first when another audio is loaded
    seekTo(key, url, seconds) {
        seconds = Math.max(0, seconds);
        if (this.key !== key || !this.el.src) {
            this.key = key;
            this.el.src = url;
            this.el.load();
        }
        // Before the metadata arrives the browser ignores currentTime: keep the last position asked for
        if (this.el.readyState < 1) {
            this.pendingSeek = seconds;
            this.el.addEventListener('loadedmetadata', () => {
                if (this.pendingSeek != null) this.el.currentTime = this.pendingSeek;
                this.pendingSeek = null;
                this.notify();
            }, { once: true });
        } else {
            this.el.currentTime = seconds;
        }
        this.notify();
    },

    position(key) {
        if (this.key !== key) return 0;
        return this.pendingSeek ?? this.el.currentTime;
    },

    stop() {
        this.pendingSeek = null;
        this.el.pause();
        this.el.removeAttribute('src');
        this.el.load();
        this.key = null;
        this.notify();
    },

    isPlaying(key) {
        return this.key === key && !this.el.paused;
    },

    notify() {
        this.listeners.forEach(listener => listener(this));
    },
};

// ---------------------------------------------------------------------------
// Volume: speaker button (mute) and slider. One volume for every preview, remembered on this computer.
// ---------------------------------------------------------------------------
const Volume = {
    html() {
        return `<div class="volume" data-volume>
            <button type="button" class="icon-btn p-1" data-mute>${icon('volume-2', 'icon-sm')}</button>
            <input type="range" class="range" min="0" max="100" step="1" aria-label="Volume">
        </div>`;
    },

    bind(el) {
        const slider = el.querySelector('input');
        slider.oninput = () => Player.setVolume(slider.value / 100);
        el.querySelector('[data-mute]').onclick = () => Player.setMuted(!Player.el.muted);
        this.sync();
    },

    sync() {
        const { volume, muted } = Player.el;
        const percent = Math.round((muted ? 0 : volume) * 100);
        const name = percent === 0 ? 'volume-x' : percent < 50 ? 'volume-1' : 'volume-2';
        let changed = false;
        document.querySelectorAll('[data-volume]').forEach(el => {
            const slider = el.querySelector('input');
            slider.value = percent;
            slider.style.setProperty('--level', `${percent}%`);
            slider.title = `Volume ${percent}%`;
            const button = el.querySelector('[data-mute]');
            button.title = muted ? 'Unmute' : 'Mute';
            if (button.dataset.icon !== name) {
                button.dataset.icon = name;
                button.innerHTML = icon(name, 'icon-sm');
                changed = true;
            }
        });
        if (changed) refreshIcons();
    },
};

// ---------------------------------------------------------------------------
// Timeline: the seek bar used to trim (Add Theme preview and the trim editor of a track).
// Click or drag to move, hover shows the time under the mouse, arrow keys move 1 s.
// ---------------------------------------------------------------------------
const Timeline = {
    html() {
        return `<div class="timeline" data-timeline tabindex="0" title="Click or drag to move. Arrow keys: 1 second">
            <div class="rail"></div><div class="trim-region" style="left:0;right:0"></div>
            <div class="playhead" style="left:0"></div><div class="hover-time hidden"></div></div>`;
    },

    // options: duration() -> seconds, current() -> seconds, seek(seconds)
    bind(el, options) {
        const timeAt = clientX => {
            const rect = el.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
            return ratio * (options.duration() || 0);
        };
        const tip = el.querySelector('.hover-time');
        const showTip = event => {
            if (!options.duration()) return;
            const rect = el.getBoundingClientRect();
            tip.textContent = fmtTimePrecise(timeAt(event.clientX));
            tip.style.left = `${Math.min(rect.width - 24, Math.max(24, event.clientX - rect.left))}px`;
            tip.classList.remove('hidden');
        };
        let dragging = false;
        el.addEventListener('pointerdown', event => {
            if (!options.duration()) return;
            dragging = true;
            el.setPointerCapture(event.pointerId);
            options.seek(timeAt(event.clientX));
            showTip(event);
        });
        el.addEventListener('pointermove', event => {
            showTip(event);
            if (dragging) options.seek(timeAt(event.clientX));
        });
        el.addEventListener('pointerup', () => { dragging = false; });
        el.addEventListener('pointerleave', () => { if (!dragging) tip.classList.add('hidden'); });
        el.addEventListener('keydown', event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' || !options.duration()) return;
            event.preventDefault();
            const step = event.key === 'ArrowLeft' ? -1 : 1;
            options.seek(Math.min(options.duration(), Math.max(0, options.current() + step)));
        });
    },

    draw(el, { duration, current, start, end }) {
        if (!el || !duration) return;
        const from = Math.min(start ?? 0, duration);
        const to = Math.max(from, Math.min(end ?? duration, duration));
        const region = el.querySelector('.trim-region');
        region.style.left = `${(from / duration) * 100}%`;
        region.style.right = `${100 - (to / duration) * 100}%`;
        el.querySelector('.playhead').style.left = `${(Math.min(current, duration) / duration) * 100}%`;
    },
};

// ---------------------------------------------------------------------------
// Data shared by the pages
// ---------------------------------------------------------------------------
App.loadLibrary = async function (force = false, fresh = false) {
    if (App.library && !force) return App.library;
    const result = await api(fresh ? '/api/library?fresh=1' : '/api/library');
    App.library = result.success ? result : { libraries: [], media: [] };
    const missing = App.library.media.filter(m => m.tracks.length === 0).length;
    const badge = document.getElementById('navMissingCount');
    badge.textContent = missing;
    badge.classList.toggle('hidden', missing === 0);
    return App.library;
};

App.saveSettings = async function (changes) {
    Object.assign(App.settings, changes);
    const result = await api('/api/save_settings', App.settings);
    if (!result.success) toast('Could not save the settings.', 'error');
    return result.success;
};

App.mediaAction = async function (folders, action, describe) {
    const labels = { normalize: 'normalize', fx: 'apply audio effects to', retag: 're-tag', refresh: 'refresh', organize: 'organize', remove: 'remove themes from' };
    if (action === 'remove') {
        const ok = await confirmDialog({
            title: 'Remove themes',
            message: `This permanently deletes every theme file of ${esc(describe)}. Your videos and other files are not touched.`,
            confirmLabel: 'Remove themes', danger: true,
        });
        if (!ok) return;
    }
    const result = await api('/api/media/action', { folders, action });
    toast(result.message || `Could not ${labels[action]} ${describe}.`, result.success ? 'info' : 'error');
};

// ---------------------------------------------------------------------------
// Router: #/library, #/media/<path>, #/missing, #/activity, #/settings
// ---------------------------------------------------------------------------
App.go = function (name, arg) {
    location.hash = arg != null ? `#/${name}/${encodeURIComponent(arg)}` : `#/${name}`;
};

App.render = function () {
    const [, name = 'library', ...rest] = location.hash.replace(/^#/, '').split('/');
    const page = App.pages[name] ? name : 'library';
    const arg = rest.length ? decodeURIComponent(rest.join('/')) : null;
    const changedPage = App.route.name !== page || App.route.arg !== arg;
    App.route = { name: page, arg };

    document.querySelectorAll('.nav-item').forEach(item =>
        item.classList.toggle('active', item.dataset.nav === page || (page === 'media' && item.dataset.nav === 'library')));
    if (changedPage) {
        closeMenu();
        // The Add theme preview goes along to the next page, in the minimized panel
        if (Player.key !== 'preview') Player.stop();
        App.pages.addTheme?.minimize();
        document.getElementById('view').scrollTop = 0;
        App.setBackdrop(null);
    }
    App.pages[page].render(document.getElementById('view'), arg);
    refreshIcons();
};

// ---------------------------------------------------------------------------
// Polling: queue, task progress and logs
// ---------------------------------------------------------------------------
let lastQueueSignature = '';
let taskWasRunning = false;

App.poll = async function () {
    try {
        const [queue, status] = await Promise.all([api('/api/queue'), api('/api/status')]);

        if (status.logs) {
            App.logs.push(...status.logs.split('\n').filter(line => line.trim()));
            if (App.logs.length > 3000) App.logs.splice(0, App.logs.length - 3000);
            App.pages[App.route.name]?.onLogs?.();
        }

        const previous = new Map(App.queue.items.map(item => [item.id, item.status]));
        App.queue = queue;
        App.status = status;
        const finishedMedia = new Set(queue.items
            .filter(item => item.status === 'completed' && previous.get(item.id) && previous.get(item.id) !== 'completed')
            .map(item => item.media_folder));

        const signature = JSON.stringify([queue.paused, queue.items.map(i => [i.id, i.status, i.stage]), status.is_processing, status.statusText]);
        const changed = signature !== lastQueueSignature;
        lastQueueSignature = signature;

        if (finishedMedia.size) App.library = null;
        if (taskWasRunning && !status.is_processing) {
            App.library = null;
            toast(status.statusText || 'Task finished.', status.statusText?.startsWith('Error') ? 'error' : 'success');
            App.pages[App.route.name]?.onTaskDone?.();
        }
        taskWasRunning = status.is_processing;

        App.updateIndicator();
        if (changed) App.pages[App.route.name]?.onQueue?.(finishedMedia);
    } catch (err) {
        console.error('Polling failed:', err);
    }
    const active = App.queue.items.some(i => i.status === 'waiting' || i.status === 'processing') || App.status.is_processing;
    setTimeout(App.poll, active ? 1000 : 3000);
};

App.updateIndicator = function () {
    const items = App.queue.items;
    const pending = items.filter(i => i.status === 'waiting' || i.status === 'processing');
    const current = items.find(i => i.status === 'processing');
    const indicator = document.getElementById('activityIndicator');
    let text = '';
    if (current) {
        const done = items.filter(i => i.status === 'completed' || i.status === 'error').length;
        text = `${current.stage || 'Working'} ${done + 1} of ${items.length}`;
    } else if (App.status.is_processing) {
        text = App.status.statusText;
    } else if (pending.length && App.queue.paused) {
        text = `Queue paused (${pending.length})`;
    }
    document.getElementById('activityIndicatorText').textContent = text;
    indicator.classList.toggle('hidden', !text);
    indicator.classList.toggle('flex', !!text);

    const badge = document.getElementById('navQueueCount');
    badge.textContent = pending.length;
    badge.classList.toggle('hidden', pending.length === 0);
};

// Refresh button in the top bar: reads the current page again (folders, Jellyfin, queue, settings)
App.refresh = async function () {
    const button = document.getElementById('refreshBtn');
    const svg = () => button.querySelector('svg');
    svg()?.classList.add('animate-spin');
    try {
        const [settings, queue] = await Promise.all([api('/api/get_settings'), api('/api/queue')]);
        App.settings = settings;
        App.queue = queue;
        App.library = null;
        App.updateIndicator();
        await App.loadLibrary(true, true);
        await App.pages[App.route.name].render(document.getElementById('view'), App.route.arg);
        refreshIcons();
    } catch (err) {
        toast('Could not refresh. Is Themarr still running?', 'error');
    } finally {
        setTimeout(() => svg()?.classList.remove('animate-spin'), 300);
    }
};

// Update check against the latest GitHub release (Settings > Updates can turn it off)
App.checkUpdates = async function (force = false) {
    if (!force && App.settings.check_updates === false) return null;
    const result = await api(force ? '/api/updates?force=1' : '/api/updates').catch(() => null);
    if (result?.success) App.update = result;
    const label = document.getElementById('appVersion');
    label.innerHTML = App.update?.newer
        ? `<a href="#/settings" class="flex items-center gap-1.5 text-accent-text hover:underline" title="Version ${esc(App.update.latest)} is available">${icon('circle-arrow-up', 'icon-sm')}Update available</a><span class="block mt-0.5">v${esc(App.info.version)}</span>`
        : `v${esc(App.info.version)}`;
    refreshIcons();
    return result;
};

// The few Markdown bits GitHub release notes use: headings, bullets, bold, code and links
function renderNotes(markdown) {
    const inline = text => esc(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong class="text-ink">$1</strong>')
        .replace(/`([^`]+)`/g, '<code class="text-[11px] bg-raised px-1 rounded">$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" class="text-accent-text hover:underline">$1</a>');
    let html = '';
    let inList = false;
    for (const raw of String(markdown || '').split(/\r?\n/)) {
        const line = raw.trim();
        const bullet = line.match(/^[*-]\s+(.*)/);
        if (inList && !bullet) { html += '</ul>'; inList = false; }
        if (bullet) {
            if (!inList) { html += '<ul class="list-disc pl-5 space-y-1">'; inList = true; }
            html += `<li>${inline(bullet[1])}</li>`;
        } else if (/^#{1,3}\s/.test(line)) {
            html += `<h4 class="font-medium text-ink mt-3 mb-1">${inline(line.replace(/^#+\s*/, ''))}</h4>`;
        } else if (line) {
            html += `<p class="my-1.5">${inline(line)}</p>`;
        }
    }
    return html + (inList ? '</ul>' : '');
}

// Queue items of one media folder that are not done yet (shown on its page)
App.pendingFor = function (folder) {
    return App.queue.items.filter(i => i.media_folder === folder && i.status !== 'completed');
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
App.start = async function () {
    Player.init();
    const [info, settings] = await Promise.all([api('/api/app_info'), api('/api/get_settings')]);
    App.info = info;
    App.settings = settings;
    Player.restoreVolume(settings.preview_volume);
    document.getElementById('appVersion').textContent = `v${info.version}`;

    document.getElementById('refreshBtn').onclick = () => App.refresh();
    const search = document.getElementById('globalSearch');
    search.addEventListener('input', () => {
        App.search = search.value.trim().toLowerCase();
        if (App.route.name !== 'library') App.go('library');
        else App.pages.library.applyFilters();
    });

    window.addEventListener('hashchange', App.render);
    document.getElementById('dialogOverlay').addEventListener('mousedown', event => {
        if (event.target.id === 'dialogOverlay') closeDialog();
    });

    // Links from the Jellyfin buttons: /?item=<Jellyfin item id> opens that media
    const itemId = new URLSearchParams(location.search).get('item');
    if (itemId) {
        history.replaceState(null, '', location.pathname + location.hash);
        const result = await api('/api/jellyfin/resolve_item', { item_id: itemId }).catch(() => ({}));
        if (result.success) {
            App.go('media', result.path);
        } else {
            toast(result.message || 'Could not open the media sent by Jellyfin.', 'error');
        }
    }

    if (!location.hash) location.hash = '#/library';
    App.render();
    App.poll();
    App.checkUpdates();
    setInterval(() => App.checkUpdates(), 6 * 3600 * 1000);
};
