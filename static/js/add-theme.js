// Add Theme drawer: the ThemerrDB pick when there is one, then search YouTube, YouTube Music or SoundCloud (or paste
// a link), listen, trim, name it, choose where it goes, queue it.
// Nothing is downloaded until "Add to queue": the preview streams straight from the source.

App.pages.addTheme = {
    media: null,
    results: [],
    shown: 0,
    suggested: null,    // ThemerrDB pick for this media, shown above the search results
    choice: null,       // { url, title, channel, duration, thumbnail }
    stream: null,       // { url, duration }
    loadingStream: false,
    source: 'youtube',  // where the text search looks, one of SEARCH_SOURCES
    lastQuery: '',
    lastSource: '',
    searchToken: 0,
    memory: new Map(),  // media folder -> last search, so reopening the panel picks up where it was
    minimized: false,   // stepped aside to the tab on the right edge, with everything kept as it was
    unplayable: new Map(),  // url -> why the source would not hand it over ({reason, message, blocked, detail})

    open(media, destination = null) {
        // The minimized panel of this same media comes back as it was left
        if (this.minimized && this.media?.folder_path === media.folder_path) return this.restore(destination);
        this.close();
        this.media = media;
        this.results = [];
        this.shown = 0;
        this.lastQuery = '';
        this.lastSource = '';
        this.suggested = null;
        this.choice = null;
        this.stream = null;
        this.destination = destination || 'Main Theme';
        const saved = this.memory.get(media.folder_path);
        this.source = saved?.source || App.settings.search_source || 'youtube';

        const drawer = document.getElementById('drawer');
        drawer.innerHTML = `
            <div data-resize="drawer" class="resize-handle -left-1"></div>
            <div class="px-5 py-4 border-b border-line flex items-center gap-3">
                <div class="min-w-0"><h2 class="font-semibold">Add theme</h2><p class="text-xs text-faint truncate">${esc(mediaTitle(media))}</p></div>
                <div class="ml-auto flex items-center gap-1">
                    <button data-minimize class="icon-btn" title="Minimize">${icon('chevron-right')}</button>
                    <button data-close class="icon-btn" title="Close">${icon('x')}</button>
                </div>
            </div>
            <form id="atSearchForm" class="px-5 pt-4">
                <div class="relative">
                    ${icon('search', 'absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none')}
                    <input id="atQuery" class="field w-full pl-9 pr-20 py-2" autocomplete="off">
                    <button class="absolute right-1.5 top-1/2 -translate-y-1/2 btn py-1">Search</button>
                </div>
                <div id="atSources" class="flex gap-1 mt-2">
                    ${SEARCH_SOURCES.map(([id, label]) => `<button type="button" data-source="${id}" class="px-2.5 py-1 rounded text-[11px]">${label}</button>`).join('')}
                </div>
            </form>
            <div id="atSuggested" class="hidden px-5 pt-3"></div>
            <div id="atResults" class="flex-1 overflow-y-auto scroll px-5 py-3 space-y-1"></div>
            <div id="atSelected" class="hidden relative border-t border-line bg-surface px-5 py-4 space-y-4"></div>
            <div class="px-5 py-3 border-t border-line flex items-center justify-end gap-2">
                <button data-close class="btn btn-ghost">Cancel</button>
                <button id="atAdd" class="btn btn-primary" disabled>${icon('plus')}Add to queue</button>
            </div>`;

        Resizer.bind(drawer.querySelector('[data-resize]'), 'drawer');
        drawer.querySelectorAll('[data-close]').forEach(b => b.onclick = () => this.close());
        drawer.querySelector('[data-minimize]').onclick = () => this.minimize();
        drawer.querySelector('#atSearchForm').onsubmit = event => { event.preventDefault(); this.search(); };
        // Leaving the field after changing it searches too, like pressing Enter
        drawer.querySelector('#atQuery').onchange = () => this.search();
        drawer.querySelector('#atAdd').onclick = () => this.addToQueue();
        drawer.querySelectorAll('[data-source]').forEach(b => b.onclick = () => {
            if (b.dataset.source === this.source) return;
            this.source = b.dataset.source;
            this.drawSources();
            this.search();
        });
        this.drawSources();
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
        document.getElementById('drawerOverlay').onclick = () => this.minimize();

        document.getElementById('drawerOverlay').classList.remove('hidden');
        drawer.classList.remove('translate-x-full');
        refreshIcons();

        this.loadSuggested(media);
        if (saved) {
            drawer.querySelector('#atQuery').value = saved.query;
            Object.assign(this, { results: saved.results, shown: saved.shown, lastQuery: saved.lastQuery, lastSource: saved.source });
            this.drawResults();
            requestAnimationFrame(() => { document.getElementById('atResults').scrollTop = saved.scroll; });
            return;
        }
        const season = this.destination !== 'Main Theme' ? ` ${destination.replace(/^season\s*0*(\d+).*$/i, 'season $1')}` : '';
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

    sourceLabel() {
        return (SEARCH_SOURCES.find(([id]) => id === this.source) || SEARCH_SOURCES[0])[1];
    },

    drawSources() {
        document.querySelectorAll('#atSources [data-source]').forEach(b => {
            const active = b.dataset.source === this.source;
            b.className = `px-2.5 py-1 rounded text-[11px] ${active ? 'bg-raised text-ink ring-1 ring-line' : 'text-muted hover:text-ink'}`;
            b.setAttribute('aria-pressed', active);
        });
        const input = document.getElementById('atQuery');
        if (input) input.placeholder = `Search ${this.sourceLabel()} or paste a link`;
    },

    remember() {
        if (!this.media || !this.lastQuery) return;
        this.memory.set(this.media.folder_path, {
            query: document.getElementById('atQuery')?.value ?? this.lastQuery,
            lastQuery: this.lastQuery,
            source: this.lastSource || this.source,
            results: this.results,
            shown: this.shown,
            scroll: document.getElementById('atResults')?.scrollTop || 0,
        });
    },

    isOpen() {
        return !document.getElementById('drawer').classList.contains('translate-x-full');
    },

    // X, Cancel and Add to queue: the panel goes away and the preview stops
    close() {
        if (!this.isOpen() && !this.minimized) return;
        this.remember();
        if (Player.key === 'preview') Player.stop();
        this.minimized = false;
        this.hide();
        this.drawTab();
    },

    // The arrow, a click outside, Escape or going to another page: the panel steps aside to a tab on the right
    // edge, keeping the search, the pick, the trim and the preview (still playing if it was)
    minimize() {
        if (!this.isOpen()) return;
        this.remember();
        this.minimized = true;
        this.hide();
        this.drawTab();
    },

    // A season's "Add theme" button brings the panel back pointing at that season
    restore(destination = null) {
        this.minimized = false;
        this.drawTab();
        document.getElementById('drawerOverlay').classList.remove('hidden');
        document.getElementById('drawer').classList.remove('translate-x-full');
        if (!destination || destination === this.destination) return;
        this.destination = destination;
        const dest = document.getElementById('atDest');
        if (dest && [...dest.options].some(o => o.value === destination)) {
            dest.value = destination;
            dest.onchange();
        }
    },

    hide() {
        document.getElementById('drawer').classList.add('translate-x-full');
        document.getElementById('drawerOverlay').classList.add('hidden');
    },

    drawTab() {
        const tab = document.getElementById('drawerTab');
        if (!this.minimized) {
            tab.classList.add('hidden');
            tab.dataset.state = '';
            return;
        }
        const play = !this.stream ? '' : Player.isPlaying('preview') ? 'pause' : 'play';
        const state = `${play}|${this.media.folder_path}`;
        tab.classList.remove('hidden');
        if (tab.dataset.state === state) return;  // the player notifies many times a second
        tab.dataset.state = state;
        tab.title = 'Open Add theme again';
        tab.innerHTML = `
            <span class="text-muted">${icon('chevron-left', 'icon-sm')}</span>
            ${play ? `<button data-tab-play class="w-7 h-7 rounded-full grid place-items-center ${play === 'pause' ? 'bg-accent hover:bg-accent-hover text-white' : 'bg-raised hover:bg-line text-ink'}"
                title="${play === 'pause' ? 'Pause' : 'Play'} the preview">${icon(play, 'icon-sm')}</button>` : ''}
            <span class="text-[11px] text-muted whitespace-nowrap overflow-hidden text-ellipsis max-h-52 [writing-mode:vertical-rl] rotate-180">Add theme · ${esc(mediaTitle(this.media))}</span>`;
        tab.onclick = () => this.restore();
        const button = tab.querySelector('[data-tab-play]');
        if (button) button.onclick = event => { event.stopPropagation(); this.togglePreview(); };
        refreshIcons();
    },

    togglePreview() {
        if (!this.stream) return;
        const start = parseTime(document.getElementById('atStart').value);
        Player.toggle('preview', this.stream.url, Player.key === 'preview' ? null : start);
    },

    async search() {
        const query = document.getElementById('atQuery').value.trim();
        // Enter and leaving the field can both fire: search each text once per source
        if (!query || (query === this.lastQuery && this.source === this.lastSource)) return;
        this.lastQuery = query;
        this.lastSource = this.source;
        const token = ++this.searchToken;
        const list = document.getElementById('atResults');

        if (/^https?:\/\//i.test(query)) {
            list.innerHTML = '';
            return this.select({ url: query, title: 'Track from the pasted link', channel: '', duration: '', thumbnail: '' });
        }

        list.innerHTML = `<div class="py-10 text-center text-faint flex items-center justify-center gap-2">${icon('loader-circle', 'animate-spin')}Searching ${esc(this.sourceLabel())}...</div>`;
        refreshIcons();
        let results;
        try {
            results = await api('/api/search', { query, source: this.source });
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
            list.innerHTML = `<div class="py-10 text-center text-faint">No results on ${esc(this.sourceLabel())}. Try other words, another source, or paste a link.</div>`;
            return;
        }
        list.innerHTML = this.results.slice(0, this.shown).map((r, i) => {
            const blocked = this.unplayable.get(r.url)?.blocked;
            return `
            <button data-result="${i}" class="w-full text-left flex gap-3 p-2 rounded-md ${this.choice?.url === r.url ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-surface'}"
                ${blocked ? `title="${esc(this.unplayable.get(r.url).message)}"` : ''}>
                <div class="w-28 aspect-video rounded bg-raised flex-shrink-0 relative overflow-hidden">
                    ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy" class="w-full h-full object-cover ${blocked ? 'opacity-40 grayscale' : ''}">` : ''}
                    ${r.live ? `<span class="absolute bottom-1 right-1 text-[10px] bg-red-600 text-white px-1 rounded font-semibold">LIVE</span>`
                        : r.duration ? `<span class="absolute bottom-1 right-1 text-[10px] bg-black/80 px-1 rounded font-mono">${esc(r.duration)}</span>` : ''}
                    ${blocked ? `<span class="absolute inset-0 grid place-items-center text-ink">${icon('lock')}</span>` : ''}
                </div>
                <div class="min-w-0"><div class="text-[13px] leading-snug line-clamp-2 ${blocked ? 'text-muted' : ''}">${esc(r.title)}</div>
                    <div class="text-[11px] text-faint mt-1">${blocked ? `<span class="text-amber-400">Cannot be played here</span> · ` : ''}${esc(r.channel)}</div></div>
            </button>`;
        }).join('') +
            (this.results.length > this.shown ? `<button id="atMore" class="w-full btn btn-ghost justify-center mt-2">Show more results</button>` : '');

        list.querySelectorAll('[data-result]').forEach(b => b.onclick = () => this.select(this.results[+b.dataset.result]));
        const more = list.querySelector('#atMore');
        if (more) more.onclick = () => { this.shown += 10; this.drawResults(); this.remember(); };
        refreshIcons();
    },

    // The site a link belongs to, and its page for people (SoundCloud search results carry an API link instead)
    siteOf(url) {
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return { name: 'YouTube', page: url };
        if (/(^|\.)soundcloud\.com$/.test(host)) return { name: 'SoundCloud', page: host.startsWith('api') ? '' : url };
        return { name: 'the source', page: /^https?:/.test(url) ? url : '' };
    },

    // The source would not hand the track over: say so in place of the player, in its own words, with a way to watch it
    // there. Blocked tracks cannot be added either: the download asks the source the same way and fails the same way
    showUnavailable(choice, why) {
        const site = this.siteOf(choice.url);
        const title = why.reason === 'removed' ? 'This video is no longer available'
            : why.blocked ? `${site.name} does not let Themarr play this ${site.name === 'YouTube' ? 'video' : 'track'}`
            : 'Could not load the preview';
        const next = why.blocked ? 'Themarr cannot preview or download it. Pick another result.' : 'Try again, or add it anyway.';
        document.getElementById('atPlayer').classList.add('hidden');
        document.getElementById('atOpenSite')?.classList.add('hidden');  // the notice has its own, bigger button
        const notice = document.getElementById('atNotice');
        notice.classList.remove('hidden');
        notice.innerHTML = `
            <div class="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <span class="text-amber-400 mt-0.5">${icon(why.blocked ? 'lock' : 'triangle-alert')}</span>
                <div class="min-w-0 flex-1">
                    <div class="text-[13px] font-medium text-ink">${esc(title)}</div>
                    <p class="text-xs text-muted mt-1">${esc(why.message)} ${next}</p>
                    ${why.detail ? `<p class="text-[11px] text-faint mt-1 break-words">${esc(site.name === 'the source' ? 'The source' : site.name)} says: "${esc(why.detail)}"</p>` : ''}
                    <div class="flex flex-wrap gap-2 mt-3">
                        ${site.page && why.reason !== 'removed' ? `<a href="${esc(site.page)}" target="_blank" rel="noopener" class="btn">${icon('external-link')}Open on ${esc(site.name)}</a>` : ''}
                        ${why.blocked ? '' : `<button data-retry class="btn btn-ghost">${icon('rotate-cw')}Try again</button>`}
                    </div>
                </div>
            </div>`;
        const retry = notice.querySelector('[data-retry]');
        if (retry) retry.onclick = () => this.select(choice);
        // Leaving for the site: the preview of another track would play over the video
        notice.querySelector('a')?.addEventListener('click', () => { if (Player.key === 'preview') Player.el.pause(); });
        document.getElementById('atAdd').disabled = why.blocked;
        refreshIcons();
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
        const site = this.siteOf(choice.url);
        panel.innerHTML = `
            ${site.page ? `<a id="atOpenSite" href="${esc(site.page)}" target="_blank" rel="noopener" class="icon-btn p-1 absolute top-2 right-3 !mt-0"
                title="Open on ${esc(site.name)} (pauses the preview)">${icon('external-link', 'icon-sm')}</a>` : ''}
            <div id="atNotice" class="hidden"></div>
            <div id="atPlayer" class="flex items-center gap-3">
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
        panel.querySelector('#atPlay').onclick = () => this.togglePreview();
        // Watching the video there: the preview stops so the two do not play over each other
        panel.querySelector('#atOpenSite')?.addEventListener('click', () => { if (Player.key === 'preview') Player.el.pause(); });
        document.getElementById('atAdd').disabled = false;
        refreshIcons();

        // Known already (a live stream on the search page, or tried before): no need to ask the source again
        const known = choice.live
            ? { reason: 'live', blocked: true, detail: '', message: 'This is a live stream or a premiere that has not happened yet, so there is no track to take.' }
            : this.unplayable.get(choice.url);
        if (known?.blocked) {
            this.loadingStream = false;
            this.unplayable.set(choice.url, known);
            this.drawResults();
            this.showUnavailable(choice, known);
            return this.syncPlayer();
        }

        this.loadingStream = true;
        const result = await api('/api/get_stream_info', { url: choice.url }).catch(() => ({ success: false }));
        if (this.choice !== choice) return;
        this.loadingStream = false;
        if (result.success && result.url) {
            this.unplayable.delete(choice.url);
            this.stream = { url: result.url, duration: result.duration };
            if (choice.title === 'Track from the pasted link') nameInput.focus();
            // Clicking a result means "let me hear it": start as soon as it loads, unless the panel was closed meanwhile
            if (this.isOpen() && Player.key !== 'preview') {
                Player.toggle('preview', this.stream.url, parseTime(document.getElementById('atStart').value));
            }
        } else {
            const why = result.reason ? result : { reason: 'unknown', blocked: false, detail: '', message: 'Themarr could not reach the source.' };
            this.unplayable.set(choice.url, why);
            if (why.blocked) this.drawResults();
            this.showUnavailable(choice, why);
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
        if (this.minimized) this.drawTab();
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
