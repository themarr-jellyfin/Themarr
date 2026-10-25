// Library page: every media folder as posters or a table, with a selection mode for bulk actions (like Sonarr)

App.pages.library = {
    selecting: false,
    selected: new Set(),
    viewMode: localStorage.getItem('themarr.view') || 'posters',
    libraryFilter: 'all',
    statusFilter: 'all',

    async render(view) {
        this.selecting = false;
        this.selected.clear();
        view.innerHTML = `<div class="min-h-full flex flex-col">
            <div class="sticky top-0 z-10 bg-page/95 backdrop-blur border-b border-line px-6 py-3 flex flex-wrap items-center gap-2">
                <h1 class="text-lg font-semibold mr-1">Library</h1>
                <span id="libCount" class="text-faint text-xs"></span>
                <div class="ml-auto flex flex-wrap items-center gap-1.5">
                    <select id="libFilter" class="field py-1.5 text-xs" title="Library"></select>
                    <select id="statusFilter" class="field py-1.5 text-xs" title="Themes">
                        <option value="all">All media</option>
                        <option value="with">With themes</option>
                        <option value="missing">Missing themes</option>
                    </select>
                    <div class="flex bg-surface border border-line rounded-md p-0.5">
                        <button data-view="posters" class="px-2 py-1 rounded" title="Posters">${icon('layout-grid')}</button>
                        <button data-view="table" class="px-2 py-1 rounded" title="Table">${icon('list')}</button>
                    </div>
                    <button id="libSelect" class="btn">${icon('square-check')}Select</button>
                </div>
            </div>
            <div id="libItems" class="flex-1"><div class="p-10 text-center text-faint">Loading library...</div></div>
            <div id="massBar" class="hidden sticky bottom-0 bg-side border-t border-line px-6 py-3 flex-wrap items-center gap-2"></div></div>`;

        view.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
            this.viewMode = button.dataset.view;
            localStorage.setItem('themarr.view', this.viewMode);
            this.applyFilters();
        });
        view.querySelector('#libSelect').onclick = () => this.toggleSelecting();
        view.querySelector('#statusFilter').value = this.statusFilter;
        view.querySelector('#statusFilter').onchange = event => { this.statusFilter = event.target.value; this.applyFilters(); };
        view.querySelector('#libFilter').onchange = event => { this.libraryFilter = event.target.value; this.applyFilters(); };

        await App.loadLibrary();
        if (App.route.name !== 'library') return;
        // Background art of a random media, a new one on each visit (a refresh keeps it), like the Jellyfin home
        if (!document.getElementById('backdrop').dataset.url) {
            const art = App.library.media.map(backdropUrl).filter(Boolean);
            if (art.length) App.setBackdrop(art[Math.floor(Math.random() * art.length)], 'library');
        }
        this.fillLibraryFilter();
        this.applyFilters();
    },

    fillLibraryFilter() {
        const select = document.getElementById('libFilter');
        if (!select) return;
        const libraries = App.library.libraries;
        if (!libraries.some(l => l.name === this.libraryFilter)) this.libraryFilter = 'all';
        select.innerHTML = `<option value="all">All libraries</option>` +
            libraries.map(l => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('');
        select.value = this.libraryFilter;
        select.classList.toggle('hidden', libraries.length < 2);
    },

    visibleMedia() {
        return App.library.media.filter(m =>
            (this.libraryFilter === 'all' || m.library === this.libraryFilter) &&
            (this.statusFilter === 'all' || (this.statusFilter === 'with') === (m.tracks.length > 0)) &&
            (!App.search || mediaTitle(m).toLowerCase().includes(App.search) || m.media_name.toLowerCase().includes(App.search)));
    },

    applyFilters() {
        const container = document.getElementById('libItems');
        if (!container || !App.library) return;
        document.querySelectorAll('[data-view]').forEach(button =>
            button.className = `px-2 py-1 rounded ${button.dataset.view === this.viewMode ? 'bg-raised text-ink' : 'text-faint hover:text-ink'}`);

        const { libraries, media } = App.library;
        const items = this.visibleMedia();
        const libText = libraries.length === 1 ? '1 library' : `${libraries.length} libraries`;
        document.getElementById('libCount').textContent = `${items.length} of ${media.length} media · ${libText}`;

        if (!libraries.length) {
            container.innerHTML = `
                <div class="max-w-md mx-auto mt-20 text-center">
                    <div class="text-faint inline-block icon-xl">${icon('folder-plus')}</div>
                    <h2 class="text-base font-medium mt-3">Add your media folders</h2>
                    <p class="text-muted mt-2">Tell Themarr where your series and movies are, one folder per library (for example TV and Movies).</p>
                    <a href="#/settings" class="btn btn-primary mt-5">${icon('settings')}Open Settings</a>
                </div>`;
        } else if (!items.length) {
            container.innerHTML = `<div class="p-10 text-center text-faint">${media.length ? 'Nothing matches these filters.' : 'No media folders found in your libraries.'}</div>`;
        } else if (this.viewMode === 'table') {
            container.innerHTML = this.tableHtml(items);
        } else {
            container.innerHTML = `<div class="p-6 grid gap-5 grid-cols-[repeat(auto-fill,minmax(140px,1fr))]">${items.map(m => this.posterCard(m)).join('')}</div>`;
        }

        container.querySelectorAll('[data-folder]').forEach(el => el.onclick = event => {
            const folder = el.dataset.folder;
            if (this.selecting || event.target.type === 'checkbox') {
                if (event.target.type !== 'checkbox') event.preventDefault();
                this.toggleSelected(folder);
            } else {
                App.go('media', folder);
            }
        });
        this.renderMassBar();
        refreshIcons();
    },

    themesBadge(media) {
        return media.tracks.length
            ? `<span class="flex items-center gap-1 text-accent-text">${icon('music-2', 'icon-sm')}${media.tracks.length}</span>`
            : `<span class="text-amber-400/90">Missing</span>`;
    },

    posterCard(media) {
        const checked = this.selected.has(media.folder_path);
        const year = media.jellyfin?.year ? ` <span class="text-faint">(${media.jellyfin.year})</span>` : '';
        return `
            <div data-folder="${esc(media.folder_path)}" class="group cursor-pointer select-none">
                <div class="relative">
                    ${posterHtml(media, `border border-white/5 group-hover:ring-2 ring-accent transition ${checked ? 'ring-2' : ''}`)}
                    <div class="absolute bottom-0 inset-x-0 h-1 rounded-b-md ${media.tracks.length ? 'bg-accent' : 'bg-amber-500/80'}"></div>
                    ${this.selecting ? `<input type="checkbox" ${checked ? 'checked' : ''} class="absolute top-2 left-2 w-4 h-4">` : ''}
                </div>
                <div class="mt-2 text-[13px] truncate" title="${esc(mediaTitle(media))}">${esc(mediaTitle(media))}${year}</div>
                <div class="text-xs text-muted flex items-center gap-2">${this.themesBadge(media)}<span class="text-faint">· ${esc(media.library)}</span></div>
            </div>`;
    },

    tableHtml(items) {
        const rows = items.map(m => `
            <tr data-folder="${esc(m.folder_path)}" class="hover:bg-surface cursor-pointer">
                ${this.selecting ? `<td class="pl-2 w-8"><input type="checkbox" ${this.selected.has(m.folder_path) ? 'checked' : ''}></td>` : ''}
                <td class="py-2.5 pl-2">${esc(mediaTitle(m))}${m.jellyfin?.year ? ` <span class="text-faint">(${m.jellyfin.year})</span>` : ''}</td>
                <td class="text-muted">${esc(m.library)}</td>
                <td class="text-xs">${this.themesBadge(m)}</td>
                ${App.settings.jelly_check ? `<td class="text-xs">${m.jellyfin ? '<span class="text-green-400">Matched</span>' : '<span class="text-faint">Not found</span>'}</td>` : ''}
            </tr>`).join('');
        return `
            <div class="p-6">
                <table class="w-full text-left">
                    <thead class="text-[11px] uppercase tracking-wider text-faint border-b border-line">
                        <tr>${this.selecting ? '<th></th>' : ''}<th class="py-2 pl-2 font-medium">Title</th><th class="font-medium">Library</th><th class="font-medium">Themes</th>${App.settings.jelly_check ? '<th class="font-medium">Jellyfin</th>' : ''}</tr>
                    </thead>
                    <tbody class="divide-y divide-line">${rows}</tbody>
                </table>
            </div>`;
    },

    toggleSelecting() {
        this.selecting = !this.selecting;
        this.selected.clear();
        document.getElementById('libSelect').classList.toggle('border-accent', this.selecting);
        this.applyFilters();
    },

    toggleSelected(folder) {
        this.selected.has(folder) ? this.selected.delete(folder) : this.selected.add(folder);
        this.applyFilters();
    },

    renderMassBar() {
        const bar = document.getElementById('massBar');
        if (!bar) return;
        bar.classList.toggle('hidden', !this.selecting);
        bar.classList.toggle('flex', this.selecting);
        if (!this.selecting) return;

        const count = this.selected.size;
        const visible = this.visibleMedia();
        bar.innerHTML = `
            <span class="text-xs text-muted mr-1"><strong class="text-ink">${count}</strong> selected</span>
            <button data-select="all" class="btn btn-ghost">${count === visible.length && count ? 'Select none' : 'Select all'}</button>
            <span class="w-px h-5 bg-line mx-1"></span>
            <button data-action="normalize" class="btn" ${count ? '' : 'disabled'} title="Level the loudness of every theme">${icon('audio-lines')}Normalize</button>
            <button data-action="fx" class="btn" ${count ? '' : 'disabled'} title="Apply the fades and silence removal from Settings">${icon('wand-sparkles')}Audio effects</button>
            <button data-action="refresh" class="btn" ${count ? '' : 'disabled'} title="Read names, posters and genres from Jellyfin again, fix the theme tags that changed and rescan the folders in Jellyfin">${icon('refresh-cw')}Refresh &amp; Scan</button>
            <button data-action="organize" class="btn" ${count ? '' : 'disabled'} title="Move loose episodes into a season folder">${icon('folder-tree')}Organize</button>
            <button data-action="remove" class="btn btn-danger ml-auto" ${count ? '' : 'disabled'}>${icon('trash-2')}Remove themes</button>
            <button id="massCancel" class="btn btn-ghost">Done</button>`;

        bar.querySelector('[data-select]').onclick = () => {
            if (count === visible.length && count) this.selected.clear();
            else visible.forEach(m => this.selected.add(m.folder_path));
            this.applyFilters();
        };
        bar.querySelectorAll('[data-action]').forEach(button => button.onclick = () =>
            App.mediaAction([...this.selected], button.dataset.action, `${count} media`));
        bar.querySelector('#massCancel').onclick = () => this.toggleSelecting();
        refreshIcons();
    },

    async onQueue(finishedMedia) {
        if (finishedMedia?.size) await this.reload();
    },

    async onTaskDone() {
        await this.reload();
    },

    async reload() {
        await App.loadLibrary(true);
        if (App.route.name === 'library') this.applyFilters();
    },
};
