// Missing page: media with no theme yet, with the ThemerrDB pick (when there is one) and the top results of one
// search source for each (the old Theme Assistant)

App.pages.missing = {
    source: '',               // search source of the page, one of SEARCH_SOURCES; starts as the Settings default
    bySource: new Map(),      // source -> Map(folder_path -> { loading, official_name, items: [] })
    picks: new Map(),         // folder_path -> index of the chosen suggestion, or -1 to skip
    names: new Map(),         // folder_path -> theme name typed by the user

    // Switching back to a source already searched shows its results again without searching
    get suggestions() {
        if (!this.bySource.has(this.source)) this.bySource.set(this.source, new Map());
        return this.bySource.get(this.source);
    },

    async render(view) {
        this.source ||= App.settings.search_source || 'youtube';
        view.innerHTML = `<div class="min-h-full flex flex-col">
            <div class="sticky top-0 z-10 bg-page/95 backdrop-blur border-b border-line px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 class="text-lg font-semibold">Missing</h1>
                <span class="text-faint text-xs">Media with no theme yet. Pick a suggestion, listen to it, and add the ones you like to the queue.</span>
                <div id="missingSources" class="ml-auto flex items-center gap-1">
                    <span class="text-[11px] text-faint mr-1">Search on</span>
                    ${SEARCH_SOURCES.map(([id, label]) => `<button type="button" data-source="${id}" class="px-2.5 py-1 rounded text-[11px]">${label}</button>`).join('')}
                </div>
            </div>
            <div id="missingList" class="flex-1 p-6 space-y-3"><div class="p-10 text-center text-faint">Loading library...</div></div>
            <div id="missingBar" class="hidden sticky bottom-0 bg-side border-t border-line px-6 py-3 items-center gap-3"></div></div>`;

        view.querySelectorAll('[data-source]').forEach(b => b.onclick = () => this.setSource(b.dataset.source));
        this.drawSources();
        await App.loadLibrary();
        if (App.route.name !== 'missing') return;
        this.draw();
        this.loadSuggestions();
    },

    drawSources() {
        document.querySelectorAll('#missingSources [data-source]').forEach(b => {
            const active = b.dataset.source === this.source;
            b.className = `px-2.5 py-1 rounded text-[11px] ${active ? 'bg-raised text-ink ring-1 ring-line' : 'text-muted hover:text-ink'}`;
            b.setAttribute('aria-pressed', active);
        });
    },

    // The picks point into the old lists: back to the first suggestion, but a skipped media stays skipped
    setSource(source) {
        if (source === this.source) return;
        this.source = source;
        for (const [folder, pick] of this.picks) if (pick >= 0) this.picks.delete(folder);
        Player.stop();
        this.drawSources();
        this.draw();
        this.loadSuggestions();
    },

    missingMedia() {
        return App.library.media.filter(m => m.tracks.length === 0 && !App.pendingFor(m.folder_path).length);
    },

    draw() {
        const list = document.getElementById('missingList');
        if (!list) return;
        const media = this.missingMedia();
        if (!App.library.libraries.length) {
            list.innerHTML = `<div class="p-10 text-center text-muted">Add your media folders in <a href="#/settings" class="text-accent-text hover:underline">Settings</a> first.</div>`;
        } else if (!media.length) {
            list.innerHTML = `
                <div class="max-w-md mx-auto mt-16 text-center">
                    <div class="text-green-400 inline-block icon-xl">${icon('circle-check')}</div>
                    <h2 class="text-base font-medium mt-3">Every media has a theme</h2>
                    <p class="text-muted mt-2">Nothing is missing in your libraries.</p>
                </div>`;
        } else {
            list.innerHTML = media.map(m => this.card(m)).join('');
            list.querySelectorAll('[data-card]').forEach(card => this.bindCard(card));
        }
        this.drawBar();
        refreshIcons();
        this.syncPlayers();
    },

    card(media) {
        const folder = media.folder_path;
        const state = this.suggestions.get(folder);
        const pick = this.picks.get(folder) ?? 0;
        let body;
        if (!state || state.loading) {
            body = `<div class="p-4 text-faint text-xs flex items-center gap-2">${icon('loader-circle', 'icon-sm animate-spin')}Finding suggestions...</div>`;
        } else if (!state.items.length) {
            body = `<div class="p-4 text-faint text-xs">No suggestions found. Use "Search manually".</div>`;
        } else {
            body = `
                <div class="p-2 grid gap-2 grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
                    ${state.items.map((r, i) => `
                        <label class="flex gap-2.5 p-2 rounded-md cursor-pointer ${pick === i ? 'bg-accent-soft ring-1 ring-accent' : 'hover:bg-raised'}">
                            <input type="radio" name="pick-${esc(folder)}" value="${i}" ${pick === i ? 'checked' : ''} class="mt-1">
                            <div class="w-20 aspect-video rounded bg-raised flex-shrink-0 relative overflow-hidden">
                                ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="" loading="lazy" class="w-full h-full object-cover">` : ''}
                                <button type="button" data-preview="${i}" class="absolute inset-0 grid place-items-center text-white/90 hover:text-white bg-black/30 hover:bg-black/10" title="Listen">${icon('play')}</button>
                            </div>
                            <div class="min-w-0 text-[12px] leading-snug"><div class="line-clamp-2">${esc(r.title)}</div><div class="text-[11px] text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">${sourceBadge(r)}<span>${resultInfo(r)}</span></div></div>
                        </label>`).join('')}
                    <label class="flex items-center gap-2.5 p-2 rounded-md cursor-pointer text-xs text-muted ${pick === -1 ? 'bg-raised' : 'hover:bg-raised'}">
                        <input type="radio" name="pick-${esc(folder)}" value="-1" ${pick === -1 ? 'checked' : ''}>Skip this one
                    </label>
                </div>
                ${pick >= 0 ? `<div class="px-4 pb-3 flex items-center gap-2 text-xs text-muted">Save as
                    <input data-name class="field py-1 w-48" value="${esc(this.names.get(folder) ?? 'Main Theme')}"> in the main theme</div>` : ''}`;
        }
        return `
            <div data-card="${esc(folder)}" class="card">
                <div class="px-4 py-3 flex items-center gap-3 border-b border-line">
                    <div class="w-8 flex-shrink-0">${posterHtml(media)}</div>
                    <div class="min-w-0"><a href="#/media/${encodeURIComponent(folder)}" class="font-medium hover:underline">${esc(mediaTitle(media))}</a><div class="text-[11px] text-faint">${esc(media.library)}</div></div>
                    <button data-manual class="ml-auto btn btn-ghost">${icon('search', 'icon-sm')}Search manually</button>
                </div>
                ${body}
            </div>`;
    },

    bindCard(card) {
        const folder = card.dataset.card;
        const media = App.library.media.find(m => m.folder_path === folder);
        card.querySelector('[data-manual]').onclick = async () => {
            const result = await api('/api/media', { path: folder });
            if (result.success) App.pages.addTheme.open(result.media);
        };
        card.querySelectorAll('input[type=radio]').forEach(radio => radio.onchange = () => {
            this.picks.set(folder, +radio.value);
            this.redrawCard(folder);
        });
        card.querySelector('[data-name]')?.addEventListener('input', event => this.names.set(folder, event.target.value));
        card.querySelectorAll('[data-preview]').forEach(button => button.onclick = event => {
            event.preventDefault();
            this.preview(folder, +button.dataset.preview);
        });
        if (!media) card.remove();
    },

    redrawCard(folder) {
        const card = document.querySelector(`[data-card="${CSS.escape(folder)}"]`);
        const media = App.library.media.find(m => m.folder_path === folder);
        if (!card || !media) return;
        card.outerHTML = this.card(media);
        this.bindCard(document.querySelector(`[data-card="${CSS.escape(folder)}"]`));
        this.drawBar();
        refreshIcons();
        this.syncPlayers();
    },

    async preview(folder, index) {
        const item = this.suggestions.get(folder)?.items[index];
        if (!item) return;
        const key = `missing:${this.source}:${folder}:${index}`;
        if (Player.key === key) return Player.toggle(key);
        const result = await api('/api/get_stream_info', { url: item.url }).catch(() => ({}));
        if (!result.success) return toast('This video cannot be previewed.', 'error');
        Player.toggle(key, result.url);
    },

    syncPlayers() {
        document.querySelectorAll('#missingList [data-preview]').forEach(button => {
            const folder = button.closest('[data-card]').dataset.card;
            const playing = Player.isPlaying(`missing:${this.source}:${folder}:${button.dataset.preview}`);
            const wanted = playing ? 'pause' : 'play';
            if (button.dataset.state !== wanted) {
                button.dataset.state = wanted;
                button.innerHTML = icon(wanted);
                refreshIcons();
            }
        });
    },

    // Two at a time: each search takes a few seconds and the server is small
    // A source switch stops these workers after their current search and starts new ones for the new source
    async loadSuggestions() {
        const source = this.source;
        const suggestions = this.suggestions;
        const queue = this.missingMedia().filter(m => !suggestions.has(m.folder_path));
        const current = () => App.route.name === 'missing' && this.source === source;
        const worker = async () => {
            while (queue.length && current()) {
                const media = queue.shift();
                suggestions.set(media.folder_path, { loading: true, items: [] });
                const result = await api('/api/library/assistant/suggestions', {
                    folder_name: media.media_name, folder_path: media.folder_path, source,
                }).catch(() => ({}));
                suggestions.set(media.folder_path, {
                    loading: false, official_name: result.official_name, items: result.success ? result.suggestions : [],
                });
                if (current()) this.redrawCard(media.folder_path);
            }
        };
        await Promise.all([worker(), worker()]);
        // Cards left half loaded by leaving the page or switching source are fetched again next time
        for (const [folder, state] of suggestions) if (state.loading) suggestions.delete(folder);
    },

    chosen() {
        return this.missingMedia().flatMap(m => {
            const state = this.suggestions.get(m.folder_path);
            const pick = this.picks.get(m.folder_path) ?? 0;
            if (!state || state.loading || pick < 0 || !state.items[pick]) return [];
            return [{ media: m, result: state.items[pick], name: (this.names.get(m.folder_path) ?? 'Main Theme').trim() || 'Main Theme' }];
        });
    },

    drawBar() {
        const bar = document.getElementById('missingBar');
        if (!bar) return;
        const chosen = this.chosen();
        const show = this.missingMedia().length > 0;
        bar.classList.toggle('hidden', !show);
        bar.classList.toggle('flex', show);
        bar.innerHTML = `
            <span class="text-xs text-muted"><strong class="text-ink">${chosen.length}</strong> theme${chosen.length === 1 ? '' : 's'} selected</span>
            <span class="text-[11px] text-faint hidden md:inline">Loudness and fades follow your Settings.</span>
            <button id="missingAdd" class="ml-auto btn btn-primary" ${chosen.length ? '' : 'disabled'}>${icon('download')}Add ${chosen.length || ''} to queue</button>`;
        bar.querySelector('#missingAdd').onclick = () => this.addChosen();
        refreshIcons();
    },

    async addChosen() {
        const chosen = this.chosen();
        let added = 0;
        for (const { media, result, name } of chosen) {
            const response = await api('/api/queue/add', {
                media_folder: media.folder_path,
                items: [{ link: result.url, name, destination: 'Main Theme' }],
            });
            if (response.success) added++;
            else toast(`${mediaTitle(media)}: ${response.message}`, 'error');
        }
        if (added) toast(`${added} theme${added > 1 ? 's' : ''} added to the queue.`, 'success');
        Player.stop();
        App.queue = await api('/api/queue');
        App.updateIndicator();
        this.draw();
    },

    onQueue(finishedMedia) {
        if (finishedMedia?.size) App.loadLibrary(true).then(() => App.route.name === 'missing' && this.draw());
    },
};

Player.listeners.add(() => {
    if (App.route.name === 'missing') App.pages.missing.syncPlayers();
});
