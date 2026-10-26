// Add Theme drawer: the ThemerrDB pick when there is one, then search YouTube (or paste a link), listen, trim,
// name it, choose where it goes, queue it.
// Nothing is downloaded until "Add to queue": the preview streams straight from YouTube.

App.pages.addTheme = {
    media: null,
    results: [],
    shown: 0,
    suggested: null,    // ThemerrDB pick for this media, shown above the search results
    choice: null,       // { url, title, channel, duration, thumbnail }
    stream: null,       // { url, duration }
    loadingStream: false,
    lastQuery: '',
    searchToken: 0,
    memory: new Map(),  // media folder -> last search, so reopening the panel picks up where it was

    open(media, destination = 'Main Theme') {
        this.media = media;
        this.results = [];
        this.shown = 0;
        this.lastQuery = '';
        this.suggested = null;
        this.choice = null;
        this.stream = null;
        this.destination = destination;

        const drawer = document.getElementById('drawer');
        drawer.innerHTML = `
            <div class="px-5 py-4 border-b border-line flex items-center gap-3">
                <div class="min-w-0"><h2 class="font-semibold">Add theme</h2><p class="text-xs text-faint truncate">${esc(mediaTitle(media))}</p></div>
                <button data-close class="ml-auto icon-btn">${icon('x')}</button>
            </div>
            <form id="atSearchForm" class="px-5 pt-4">
                <div class="relative">
                    ${icon('search', 'absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none')}
                    <input id="atQuery" class="field w-full pl-9 pr-20 py-2" placeholder="Search YouTube or paste a link" autocomplete="off">
                    <button class="absolute right-1.5 top-1/2 -translate-y-1/2 btn py-1">Search</button>
                </div>
            </form>
            <div id="atSuggested" class="hidden px-5 pt-3"></div>
            <div id="atResults" class="flex-1 overflow-y-auto scroll px-5 py-3 space-y-1"></div>
            <div id="atSelected" class="hidden border-t border-line bg-surface px-5 py-4 space-y-4"></div>
            <div class="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
                <button data-close class="btn btn-ghost">Cancel</button>
                <button id="atAdd" class="btn btn-primary" disabled>${icon('plus')}Add to queue</button>
            </div>`;

        drawer.querySelectorAll('[data-close]').forEach(b => b.onclick = () => this.close());
        drawer.querySelector('#atSearchForm').onsubmit = event => { event.preventDefault(); this.search(); };
        // Leaving the field after changing it searches too, like pressing Enter
        drawer.querySelector('#atQuery').onchange = () => this.search();
        drawer.querySelector('#atAdd').onclick = () => this.addToQueue();
        // Reaching the end of the list loads the next results, same as "Show more results"
        const list = drawer.querySelector('#atResults');
        const loadMoreAtEnd = () => {
            if (this.shown >= this.results.length || list.scrollTop + list.clientHeight < list.scrollHeight - 80) return;
            const top = list.scrollTop;
            this.shown += 10;
            this.drawResults();
            list.scrollTop = top;
            this.remember();
        };
        list.addEventListener('scroll', loadMoreAtEnd);
        // The wheel also counts when the list is too short to scroll at all
        list.addEventListener('wheel', event => { if (event.deltaY > 0) loadMoreAtEnd(); }, { passive: true });
        document.getElementById('drawerOverlay').onclick = () => this.close();

        document.getElementById('drawerOverlay').classList.remove('hidden');
        drawer.classList.remove('translate-x-full');
        refreshIcons();

        this.loadSuggested(media);
        const saved = this.memory.get(media.folder_path);
        if (saved) {
            drawer.querySelector('#atQuery').value = saved.query;
            Object.assign(this, { results: saved.results, shown: saved.shown, lastQuery: saved.lastQuery });
            this.drawResults();
            requestAnimationFrame(() => { document.getElementById('atResults').scrollTop = saved.scroll; });
            return;
        }
        const season = destination !== 'Main Theme' ? ` ${destination.replace(/^season\s*0*(\d+).*$/i, 'season $1')}` : '';
        drawer.querySelector('#atQuery').value = `${mediaTitle(media)}${season} opening theme`;
        this.search();
    },

    // Asked once per media while the app is open: the answer only changes when ThemerrDB publishes, once a day
    suggestedCache: new Map(),

    async loadSuggested(media) {
        let suggestion = this.suggestedCache.get(media.folder_path);
        if (suggestion === undefined) {
            const result = await api('/api/sources/suggested', { folder_path: media.folder_path, folder_name: media.media_name })
                .catch(() => ({}));
            suggestion = result.success ? result.suggestion : null;
            if (result.success) this.suggestedCache.set(media.folder_path, suggestion);
        }
        if (this.media !== media) return;
        this.suggested = suggestion;
        this.drawSuggested();
    },

    drawSuggested() {
        const box = document.getElementById('atSuggested');
        if (!box) return;
        const r = this.suggested;
        box.classList.toggle('hidden', !r);
        if (!r) return box.innerHTML = '';
        box.innerHTML = `
            <div class="text-[11px] uppercase tracking-wide text-faint mb-1.5">Suggested</div>
            <button data-suggested class="w-full text-left flex gap-3 p-2 rounded-md border border-line ${this.choice?.url === r.url ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-surface'}">
                <div class="w-28 aspect-video rounded bg-raised flex-shrink-0 overflow-hidden">
                    ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" class="w-full h-full object-cover">` : ''}
                </div>
                <div class="min-w-0"><div class="text-[13px] leading-snug line-clamp-2">${esc(r.title)}</div>
                    <div class="text-[11px] text-faint mt-1 flex items-center gap-1.5 flex-wrap">${sourceBadge(r)}<span>${resultInfo(r)}</span></div></div>
            </button>`;
        box.querySelector('[data-suggested]').onclick = () => this.select(r);
    },

    remember() {
        if (!this.media || !this.lastQuery) return;
        this.memory.set(this.media.folder_path, {
            query: document.getElementById('atQuery')?.value ?? this.lastQuery,
            lastQuery: this.lastQuery,
            results: this.results,
            shown: this.shown,
            scroll: document.getElementById('atResults')?.scrollTop || 0,
        });
    },

    close() {
        const drawer = document.getElementById('drawer');
        if (drawer.classList.contains('translate-x-full')) return;
        this.remember();
        if (Player.key === 'preview') Player.stop();
        drawer.classList.add('translate-x-full');
        document.getElementById('drawerOverlay').classList.add('hidden');
    },

    async search() {
        const query = document.getElementById('atQuery').value.trim();
        // Enter and leaving the field can both fire: search each text once
        if (!query || query === this.lastQuery) return;
        this.lastQuery = query;
        const token = ++this.searchToken;
        const list = document.getElementById('atResults');

        if (/^https?:\/\//i.test(query)) {
            list.innerHTML = '';
            return this.select({ url: query, title: 'Video from the pasted link', channel: '', duration: '', thumbnail: '' });
        }

        list.innerHTML = `<div class="py-10 text-center text-faint flex items-center justify-center gap-2">${icon('loader-circle', 'animate-spin')}Searching YouTube...</div>`;
        refreshIcons();
        let results;
        try {
            results = await api('/api/search_youtube', { query });
        } catch {
            results = [];
        }
        if (token !== this.searchToken) return;  // a newer search replaced this one
        this.results = results;
        this.shown = 10;
        this.drawResults();
        this.remember();
    },

    drawResults() {
        const list = document.getElementById('atResults');
        if (!list) return;
        this.drawSuggested();
        if (!this.results.length) {
            list.innerHTML = `<div class="py-10 text-center text-faint">No results. Try other words, or paste a YouTube link.</div>`;
            return;
        }
        list.innerHTML = this.results.slice(0, this.shown).map((r, i) => `
            <button data-result="${i}" class="w-full text-left flex gap-3 p-2 rounded-md ${this.choice?.url === r.url ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-surface'}">
                <div class="w-28 aspect-video rounded bg-raised flex-shrink-0 relative overflow-hidden">
                    ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy" class="w-full h-full object-cover">` : ''}
                    <span class="absolute bottom-1 right-1 text-[10px] bg-black/80 px-1 rounded font-mono">${esc(r.duration)}</span>
                </div>
                <div class="min-w-0"><div class="text-[13px] leading-snug line-clamp-2">${esc(r.title)}</div><div class="text-[11px] text-faint mt-1">${esc(r.channel)}</div></div>
            </button>`).join('') +
            (this.results.length > this.shown ? `<button id="atMore" class="w-full btn btn-ghost justify-center mt-2">Show more results</button>` : '');

        list.querySelectorAll('[data-result]').forEach(b => b.onclick = () => this.select(this.results[+b.dataset.result]));
        const more = list.querySelector('#atMore');
        if (more) more.onclick = () => { this.shown += 10; this.drawResults(); this.remember(); };
    },

    // Default name: the title for the main theme, "Title - Opening" in a season, numbered when the name is taken there
    nextName(destination) {
        const title = mediaTitle(this.media)
            .replace(/\[.*?\]|\{.*?\}|\(\d{4}\)/g, '')
            .replace(/\s*:\s*/g, ' - ')
            .replace(/[<>"\/\\|?*]/g, '')
            .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
        const base = destination === 'Main Theme' ? title : `${title} - Opening`;
        const taken = new Set([
            ...this.media.tracks.filter(t => destination === 'Main Theme'
                ? t.location_type.startsWith('Main Theme') : t.location_type === destination)
                .map(t => t.file_name.replace(/\.mp3$/i, '')),
            ...App.pendingFor(this.media.folder_path).filter(i => i.destination === destination).map(i => i.name),
        ].map(name => name.toLowerCase()));
        let name = base;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
        return name;
    },

    destinations() {
        const options = [['Main Theme', 'Main theme']];
        this.media.seasons.forEach(s => options.push([s, s]));
        if (!this.media.seasons.length) {
            const folder = `Season 01. ${this.media.media_name}`;
            options.push([folder, `New season folder: ${folder}`]);
        }
        return options;
    },

    async select(choice) {
        this.choice = choice;
        this.stream = null;
        this.drawResults();
        if (Player.key === 'preview') Player.stop();

        const settings = App.settings;
        const fx = settings.audio_fx || {};
        const panel = document.getElementById('atSelected');
        panel.classList.remove('hidden');
        panel.innerHTML = `
            <div class="flex items-center gap-3">
                <button id="atPlay" class="w-9 h-9 rounded-full bg-accent hover:bg-accent-hover text-white grid place-items-center flex-shrink-0" title="Play or pause">${icon('loader-circle', 'animate-spin')}</button>
                <div class="flex-1 min-w-0 pt-5">
                    <div id="atTimeline">${Timeline.html()}</div>
                    <div class="flex justify-between items-center text-[11px] text-faint mt-1.5 gap-2">
                        <span class="flex items-center gap-1">Start <input id="atStart" class="field py-0.5 px-1.5 w-16 font-mono text-[11px]" placeholder="0:00.0">
                            <button id="atMarkStart" class="icon-btn p-1" title="Start at the white line">${icon('map-pin', 'icon-sm')}</button></span>
                        <span id="atClock" class="font-mono">0:00.0 / 0:00.0</span>
                        <span class="flex items-center gap-1"><button id="atMarkEnd" class="icon-btn p-1" title="End at the white line">${icon('map-pin', 'icon-sm')}</button>
                            <input id="atEnd" class="field py-0.5 px-1.5 w-16 font-mono text-[11px]" placeholder="end"> End</span>
                    </div>
                </div>
                <div class="self-start pt-5 h-14 flex items-center">${Volume.html()}</div>
            </div>
            <div class="grid grid-cols-2 gap-3">
                <label class="text-xs text-muted space-y-1"><span class="block">Name</span><input id="atName" class="field w-full"></label>
                <label class="text-xs text-muted space-y-1"><span class="block">Save to</span><select id="atDest" class="field w-full">
                    ${this.destinations().map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('')}</select></label>
            </div>
            <details id="atAudio" class="text-xs text-muted">
                <summary class="cursor-pointer select-none hover:text-ink">Audio options <span class="text-faint">· defaults from Settings</span></summary>
                <div class="mt-3 flex flex-wrap items-center gap-4">
                    <label class="flex items-center gap-2">Loudness <input id="atLufs" class="field py-1 w-14 text-center" value="${esc(settings.lufs)}"> LUFS</label>
                    <label class="flex items-center gap-2">Fade in <input id="atFadeIn" class="field py-1 w-12 text-center" value="${esc(fx.fade_in || 0)}"></label>
                    <label class="flex items-center gap-2">Fade out <input id="atFadeOut" class="field py-1 w-12 text-center" value="${esc(fx.fade_out || 0)}"> s</label>
                    <label class="flex items-center gap-1.5"><input id="atSilence" type="checkbox" ${fx.remove_silence ? 'checked' : ''}> Remove silence at the start</label>
                </div>
            </details>`;

        const dest = panel.querySelector('#atDest');
        dest.value = this.destinations().some(([v]) => v === this.destination) ? this.destination : 'Main Theme';
        const nameInput = panel.querySelector('#atName');
        nameInput.value = this.nextName(dest.value);
        // A name typed by hand stays when the destination changes; an empty field goes back to the default
        let typed = false;
        nameInput.oninput = () => { typed = nameInput.value.trim() !== ''; };
        dest.onchange = () => {
            if (!typed) nameInput.value = this.nextName(dest.value);
        };
        ['#atStart', '#atEnd'].forEach(id => panel.querySelector(id).oninput = () => this.drawTimeline());
        panel.querySelector('#atMarkStart').onclick = () => this.mark('atStart');
        panel.querySelector('#atMarkEnd').onclick = () => this.mark('atEnd');
        Timeline.bind(panel.querySelector('[data-timeline]'), {
            duration: () => this.duration(),
            current: () => Player.position('preview'),
            seek: seconds => this.stream && Player.seekTo('preview', this.stream.url, seconds),
        });
        Volume.bind(panel.querySelector('[data-volume]'));
        panel.querySelector('#atPlay').onclick = () => {
            if (!this.stream) return;
            const start = parseTime(document.getElementById('atStart').value);
            Player.toggle('preview', this.stream.url, Player.key === 'preview' ? null : start);
        };
        document.getElementById('atAdd').disabled = false;
        refreshIcons();

        this.loadingStream = true;
        const result = await api('/api/get_stream_info', { url: choice.url }).catch(() => ({ success: false }));
        if (this.choice !== choice) return;
        this.loadingStream = false;
        if (result.success && result.url) {
            this.stream = { url: result.url, duration: result.duration };
            if (choice.title === 'Video from the pasted link') nameInput.focus();
            // Clicking a result means "let me hear it": start as soon as it loads, unless the panel was closed meanwhile
            if (!document.getElementById('drawer').classList.contains('translate-x-full') && Player.key !== 'preview') {
                Player.toggle('preview', this.stream.url, parseTime(document.getElementById('atStart').value));
            }
        } else {
            toast('This video cannot be previewed. You can still add it.', 'error');
        }
        this.syncPlayer();
    },

    duration() {
        return this.stream?.duration || (Player.key === 'preview' ? Player.el.duration : 0) || 0;
    },

    mark(inputId) {
        if (Player.key !== 'preview') return toast('Play the preview or click on the bar first, then mark the position.', 'info');
        document.getElementById(inputId).value = fmtTimePrecise(Player.position('preview'));
        this.drawTimeline();
    },

    drawTimeline() {
        const timeline = document.querySelector('#atTimeline [data-timeline]');
        const duration = this.duration();
        if (!timeline || !duration) return;
        const current = Player.position('preview');
        Timeline.draw(timeline, {
            duration, current,
            start: parseTime(document.getElementById('atStart').value),
            end: parseTime(document.getElementById('atEnd').value),
        });
        document.getElementById('atClock').textContent = `${fmtTimePrecise(current)} / ${fmtTimePrecise(duration)}`;
    },

    syncPlayer() {
        const button = document.getElementById('atPlay');
        if (!button) return;
        const state = this.loadingStream ? 'loading' : (Player.isPlaying('preview') ? 'pause' : 'play');
        if (button.dataset.state !== state) {
            button.dataset.state = state;
            button.innerHTML = state === 'loading' ? icon('loader-circle', 'animate-spin') : icon(state);
            refreshIcons();
        }
        // Stop at the chosen end, like the trimmed file will
        const end = parseTime(document.getElementById('atEnd').value);
        if (Player.isPlaying('preview') && end != null && Player.el.currentTime >= end) Player.el.pause();
        this.drawTimeline();
    },

    async addToQueue() {
        if (!this.choice) return;
        const value = id => document.getElementById(id).value.trim();
        const start = value('atStart');
        const end = value('atEnd');
        if ((start && parseTime(start) == null) || (end && parseTime(end) == null)) return toast('Use times like 0:05 or 1:32.', 'error');
        if (start && end && parseTime(end) <= parseTime(start)) return toast('The end must come after the start.', 'error');
        if (!value('atName')) return toast('Give the theme a name.', 'error');

        const settings = App.settings;
        const fx = settings.audio_fx || {};
        const custom = {
            fade_in: parseFloat(value('atFadeIn')) || 0,
            fade_out: parseFloat(value('atFadeOut')) || 0,
            remove_silence: document.getElementById('atSilence').checked,
        };
        const fxChanged = custom.fade_in !== (+fx.fade_in || 0) || custom.fade_out !== (+fx.fade_out || 0) || custom.remove_silence !== !!fx.remove_silence;

        const item = {
            link: this.choice.url,
            name: value('atName'),
            destination: document.getElementById('atDest').value,
            lufs: value('atLufs') || settings.lufs,
            audio_fx: fxChanged ? { enabled: true, ...custom } : null,
            startTime: start,
            endTime: end,
        };
        const button = document.getElementById('atAdd');
        button.disabled = true;
        const result = await api('/api/queue/add', { media_folder: this.media.folder_path, items: [item] });
        button.disabled = false;
        if (!result.success) return toast(result.message, 'error');

        toast(`'${item.name}' added to the queue. It downloads in the background.`, 'success');
        this.close();
        App.queue = await api('/api/queue');
        App.updateIndicator();
        App.pages[App.route.name]?.onQueue?.();
    },
};

Player.listeners.add(() => App.pages.addTheme.syncPlayer());
