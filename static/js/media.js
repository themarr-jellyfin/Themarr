// Media page: one series or movie with its themes, main and per season, and the actions on each track

App.pages.media = {
    media: null,
    editing: null,    // { path, mode: 'trim' | 'rename' }

    async render(view, folder) {
        if (!folder) return App.go('library');
        if (this.media?.folder_path !== folder) {
            this.media = null;
            this.editing = null;
            view.innerHTML = `<div class="p-10 text-center text-faint">Loading...</div>`;
        }
        const result = await api('/api/media', { path: folder });
        if (App.route.name !== 'media' || App.route.arg !== folder) return;
        if (!result.success) {
            view.innerHTML = `<div class="p-10 text-center text-muted">${esc(result.message)}<div class="mt-4"><a href="#/library" class="btn">${icon('chevron-left')}Back to Library</a></div></div>`;
            refreshIcons();
            return;
        }
        this.media = result.media;
        this.draw(view);
    },

    draw(view = document.getElementById('view')) {
        const m = this.media;
        const jf = m.jellyfin;
        const seasons = m.seasons;
        const mainTracks = m.tracks.filter(t => t.location_type.startsWith('Main Theme'));
        const pending = App.pendingFor(m.folder_path);
        const wide = backdropUrl(m);
        const logo = logoUrl(m);
        const art = posterUrl(m);
        // With background art: the image sharp at the top, fading into the same image blurred behind the tracks.
        // Without it: the poster blurred, as before
        const backdrop = wide
            ? `<img src="${wide}" alt="" class="hero-art" onerror="this.remove()">`
            : art ? `<img src="${art}" alt="" class="absolute inset-0 w-full h-full object-cover opacity-20 blur-2xl scale-110" onerror="this.remove()">` : '';
        const year = jf?.year ? ` <span class="text-faint font-normal">(${jf.year})</span>` : '';
        // A logo that fails to load gives its place back to the name
        const title = logo
            ? `<h1 class="hidden text-2xl font-semibold truncate">${esc(mediaTitle(m))}${year}</h1>
               <img src="${logo}" alt="${esc(mediaTitle(m))}" class="title-logo" onerror="this.previousElementSibling.classList.remove('hidden'); this.remove()">`
            : `<h1 class="text-2xl font-semibold truncate ${wide ? 'drop-shadow-lg' : ''}">${esc(mediaTitle(m))}${year}</h1>`;
        App.setBackdrop(wide);

        view.innerHTML = `
            <div class="relative overflow-hidden ${wide ? 'hero' : 'border-b border-line'}">
                ${backdrop}
                ${wide ? '' : '<div class="absolute inset-0 bg-gradient-to-b from-transparent to-page/80"></div>'}
                <div class="relative px-6 pt-4 pb-6 ${wide ? 'min-h-[300px] flex flex-col' : ''}">
                    <a href="#/library" class="inline-flex items-center gap-1 text-xs text-muted hover:text-ink mb-4 ${wide ? 'self-start' : ''}">${icon('chevron-left', 'icon-sm')}Library</a>
                    <div class="flex gap-6 items-end ${wide ? 'mt-auto' : ''}">
                        <div class="w-[120px] flex-shrink-0 shadow-xl">${posterHtml(m, 'border border-white/10')}</div>
                        <div class="flex-1 min-w-0">
                            ${title}
                            <div class="mt-1 text-muted text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span>${esc(m.library)}${logo && jf?.year ? ` · ${jf.year}` : ''}${seasons.length ? ` · ${seasons.length} season folder${seasons.length > 1 ? 's' : ''}` : ''}</span>
                                ${jf ? `<span class="flex items-center gap-1 text-accent-text">${icon('link', 'icon-sm')}Matched in Jellyfin</span>`
                                     : App.settings.jelly_check ? `<span class="flex items-center gap-1 text-faint" title="Covers and official names come from Jellyfin">${icon('unlink', 'icon-sm')}Not found in Jellyfin</span>` : ''}
                                <span class="font-mono text-faint truncate" title="${esc(m.folder_path)}">${esc(m.folder_path)}</span>
                            </div>
                            <div class="mt-4 flex items-center gap-2">
                                <button id="addThemeBtn" class="btn btn-primary">${icon('plus')}Add Theme</button>
                                <button id="refreshScanBtn" class="btn" title="Read the name, poster and genres from Jellyfin again, fix the theme tags that changed and rescan this folder in Jellyfin">${icon('refresh-cw')}Refresh &amp; Scan</button>
                                <button id="mediaMenuBtn" class="btn" title="More actions">${icon('ellipsis')}</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="px-6 py-5 space-y-4 ${wide ? 'over-art' : ''}">
                ${this.section('Main theme', 'Main Theme', mainTracks, pending, 'music',
                    mainTracks.length ? '' : 'Plays on the series or movie page in Jellyfin.')}
                ${seasons.map(season => this.section(season, season,
                    m.tracks.filter(t => t.location_type === season), pending, 'folder', 'No theme for this season yet.')).join('')}
            </div>`;

        view.querySelector('#addThemeBtn').onclick = () => App.pages.addTheme.open(m);
        view.querySelector('#refreshScanBtn').onclick = () => App.mediaAction([m.folder_path], 'refresh', `'${mediaTitle(m)}'`);
        view.querySelector('#mediaMenuBtn').onclick = event => {
            event.stopPropagation();
            const folders = [m.folder_path];
            const name = `'${mediaTitle(m)}'`;
            showMenu(event.currentTarget, [
                { label: 'Normalize all themes', icon: 'audio-lines', onClick: () => App.mediaAction(folders, 'normalize', name) },
                { label: 'Apply audio effects', icon: 'wand-sparkles', onClick: () => App.mediaAction(folders, 'fx', name) },
                { label: 'Organize into seasons', icon: 'folder-tree', onClick: () => App.mediaAction(folders, 'organize', name) },
                'divider',
                { label: 'Remove all themes...', icon: 'trash-2', danger: true, onClick: () => App.mediaAction(folders, 'remove', name) },
            ]);
        };
        view.querySelectorAll('[data-add]').forEach(button => button.onclick = () => App.pages.addTheme.open(m, button.dataset.add));
        view.querySelectorAll('[data-track]').forEach(row => this.bindTrack(row));
        view.querySelectorAll('[data-volume]').forEach(el => Volume.bind(el));
        view.querySelectorAll('[data-queue-retry]').forEach(b => b.onclick = () => this.queueAction('retry', +b.dataset.queueRetry));
        view.querySelectorAll('[data-queue-remove]').forEach(b => b.onclick = () => this.queueAction('remove', +b.dataset.queueRemove));
        refreshIcons();
        this.syncPlayers();
    },

    section(title, destination, tracks, pending, iconName, emptyText) {
        const queued = pending.filter(item => item.destination === destination);
        const count = tracks.length;
        const rows = tracks.map(t => this.trackRow(t)).join('') + queued.map(item => this.queuedRow(item)).join('');
        return `
            <div class="card">
                <div class="px-4 py-3 ${rows ? 'border-b border-line' : ''} flex items-center gap-2">
                    <span class="text-muted">${icon(iconName)}</span>
                    <h2 class="font-medium">${esc(title)}</h2>
                    <span class="text-faint text-xs">${count ? `${count} track${count > 1 ? 's' : ''}` : esc(emptyText)}</span>
                    <button data-add="${esc(destination)}" class="ml-auto btn btn-ghost text-accent-text">${icon('plus', 'icon-sm')}Add</button>
                </div>
                ${rows}
            </div>`;
    },

    trackRow(track) {
        const key = `track:${track.file_path}`;
        const editing = this.editing?.path === track.file_path ? this.editing.mode : null;
        const name = track.file_name.replace(/\.mp3$/i, '');
        const where = track.location_type.startsWith('Main Theme')
            ? (track.file_name.toLowerCase() === 'theme.mp3' && track.location_type.endsWith('(Single)') ? 'theme.mp3' : `theme-music/${track.file_name}`)
            : `${track.location_type}/theme-music/${track.file_name}`;

        // Edit: the name and, when the media has season folders, where the theme lives
        const here = this.destinationOf(track);
        const seasons = this.media.seasons.includes(here) || here === 'Main Theme' ? this.media.seasons : [here, ...this.media.seasons];
        const folderSelect = this.media.seasons.length
            ? `<select data-move-select class="field py-1 w-44" title="Move the theme to the main theme or a season">
                   ${[['Main Theme', 'Main theme'], ...seasons.map(s => [s, s])].map(([value, label]) =>
                       `<option value="${esc(value)}" ${value === here ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`
            : '';
        const title = editing === 'rename'
            ? `<div class="flex flex-wrap gap-2"><input data-rename-input value="${esc(name)}" class="field py-1 flex-1 min-w-[12rem] max-w-sm">${folderSelect}</div>`
            : `<div class="truncate">${esc(name)}</div><div class="text-[11px] text-faint truncate">${esc(where)}</div>`;

        const actions = editing === 'rename'
            ? `<button data-rename-save class="btn btn-primary py-1 text-xs">Save</button><button data-edit-cancel class="btn btn-ghost">Cancel</button>`
            : `<button data-trim class="icon-btn ${editing === 'trim' ? 'text-accent-text' : ''}" title="Trim">${icon('scissors')}</button>
               <button data-rename class="icon-btn" title="${this.media.seasons.length ? 'Rename or move' : 'Rename'}">${icon('pencil')}</button>
               <button data-more class="icon-btn" title="More">${icon('ellipsis-vertical')}</button>`;

        return `
            <div data-track="${esc(track.file_path)}" class="border-b border-line last:border-0">
                <div class="px-4 py-2.5 flex items-center gap-3 group">
                    <button data-play class="w-8 h-8 rounded-full border border-line hover:border-accent hover:text-accent-text grid place-items-center flex-shrink-0" data-key="${esc(key)}">${icon('play', 'icon-sm')}</button>
                    <div class="flex-1 min-w-0">${title}
                        ${editing === 'trim' ? '' : `<div data-progress class="hidden mt-1 flex items-center gap-3">
                            <input data-seek type="range" class="range flex-1 min-w-0" min="0" max="${track.duration || 0}" step="any" value="0" aria-label="Position" title="Drag to move. Arrow keys: 1 second">
                            <span data-clock class="font-mono text-[11px] text-faint whitespace-nowrap">0:00 / ${fmtTime(track.duration)}</span>
                            ${Volume.html()}
                        </div>`}
                    </div>
                    <span class="text-xs text-faint font-mono w-12 text-right">${fmtTime(track.duration)}</span>
                    <div class="flex items-center gap-0.5">${actions}</div>
                </div>
                ${editing === 'trim' ? this.trimEditor(track) : ''}
            </div>`;
    },

    trimEditor(track) {
        const { start = '', end = '' } = this.editing || {};
        return `
            <div data-trim-editor class="px-4 pb-4 pt-1">
                <div class="bg-page/60 border border-line rounded-md p-3 space-y-3">
                    <div class="flex items-center gap-3 pt-5">
                        <div class="flex-1">${Timeline.html()}</div>
                        <span data-trim-clock class="font-mono text-xs text-muted whitespace-nowrap">0:00.0 / ${fmtTimePrecise(track.duration)}</span>
                        ${Volume.html()}
                    </div>
                    <div class="flex flex-wrap items-end gap-3">
                        <label class="text-xs text-muted space-y-1"><span class="block">Start</span>
                            <span class="flex gap-1"><input data-trim-start class="field py-1 w-24 font-mono" placeholder="0:00.0" value="${esc(start)}"><button data-mark="start" class="btn" title="Start at the white line">${icon('map-pin', 'icon-sm')}</button></span></label>
                        <label class="text-xs text-muted space-y-1"><span class="block">End</span>
                            <span class="flex gap-1"><input data-trim-end class="field py-1 w-24 font-mono" placeholder="${fmtTimePrecise(track.duration)}" value="${esc(end)}"><button data-mark="end" class="btn" title="End at the white line">${icon('map-pin', 'icon-sm')}</button></span></label>
                        <span class="text-xs text-faint pb-2 max-w-xs">Drag the bar to find the spot, then mark it. Empty keeps the original start or end.</span>
                        <div class="ml-auto flex gap-2">
                            <button data-edit-cancel class="btn btn-ghost">Cancel</button>
                            <button data-trim-save class="btn btn-primary py-1.5 text-xs">${icon('scissors', 'icon-sm')}Save trim</button>
                        </div>
                    </div>
                </div>
            </div>`;
    },

    queuedRow(item) {
        const states = {
            waiting: `<span class="text-faint flex items-center gap-1.5">${icon('clock', 'icon-sm')}Queued</span>`,
            processing: `<span class="text-accent-text flex items-center gap-1.5">${icon('loader-circle', 'icon-sm animate-spin')}${esc(item.stage || 'Working')}...</span>`,
            error: `<span class="text-red-400 flex items-center gap-1.5" title="${esc(item.message)}">${icon('circle-alert', 'icon-sm')}Failed</span>`,
        };
        return `
            <div class="px-4 py-2.5 flex items-center gap-3 border-b border-line last:border-0 bg-accent-soft/40">
                <span class="w-8 h-8 grid place-items-center text-faint flex-shrink-0">${icon('download', 'icon-sm')}</span>
                <div class="flex-1 min-w-0 truncate">${esc(item.name)}</div>
                <span class="text-xs">${states[item.status] || ''}</span>
                ${item.status === 'error' ? `<button data-queue-retry="${item.id}" class="btn btn-ghost text-accent-text">Retry</button>` : ''}
                ${item.status !== 'processing' ? `<button data-queue-remove="${item.id}" class="icon-btn" title="Remove from queue">${icon('x')}</button>` : ''}
            </div>`;
    },

    bindTrack(row) {
        const path = row.dataset.track;
        const track = this.media.tracks.find(t => t.file_path === path);
        const key = `track:${path}`;
        const streamUrl = `/api/library/stream?path=${encodeURIComponent(path)}`;

        row.querySelector('[data-play]').onclick = () => Player.toggle(key, streamUrl);

        // Seek bar of the playing track: while the thumb is held, playback does not pull it back
        const seek = row.querySelector('[data-seek]');
        if (seek) {
            const release = () => { delete seek.dataset.dragging; };
            seek.addEventListener('pointerdown', () => { seek.dataset.dragging = '1'; });
            seek.addEventListener('pointerup', release);
            seek.addEventListener('change', release);
            seek.oninput = () => {
                seek.style.setProperty('--level', `${(seek.value / (seek.max || 1)) * 100}%`);
                Player.seekTo(key, streamUrl, Number(seek.value));
            };
        }
        row.querySelector('[data-trim]')?.addEventListener('click', () => this.setEditing(path, 'trim'));
        row.querySelector('[data-rename]')?.addEventListener('click', () => this.setEditing(path, 'rename'));
        row.querySelectorAll('[data-edit-cancel]').forEach(b => b.onclick = () => this.setEditing(null));
        row.querySelector('[data-more]')?.addEventListener('click', event => {
            event.stopPropagation();
            showMenu(event.currentTarget, [
                { label: 'Normalize', icon: 'audio-lines', onClick: () => this.processTrack(track, { normalize: true, fades: false, tag: false }, 'Normalized') },
                { label: 'Apply audio effects', icon: 'wand-sparkles', onClick: () => this.processTrack(track, { normalize: false, fades: true, tag: false }, 'Effects applied to') },
                { label: 'Re-tag', icon: 'tag', onClick: () => this.retag(track) },
                'divider',
                { label: 'Delete...', icon: 'trash-2', danger: true, onClick: () => this.deleteTrack(track) },
            ]);
        });

        const renameInput = row.querySelector('[data-rename-input]');
        if (renameInput) {
            const moveSelect = row.querySelector('[data-move-select]');
            const save = () => this.rename(track, renameInput.value, moveSelect?.value);
            renameInput.focus();
            renameInput.select();
            [renameInput, moveSelect].filter(Boolean).forEach(field => field.onkeydown = event => {
                if (event.key === 'Enter') save();
                if (event.key === 'Escape') { event.stopPropagation(); this.setEditing(null); }
            });
            row.querySelector('[data-rename-save]').onclick = save;
        }

        const editor = row.querySelector('[data-trim-editor]');
        if (editor) {
            const duration = () => (Player.key === key && Player.el.duration) || track.duration;
            Timeline.bind(editor.querySelector('[data-timeline]'), {
                duration,
                current: () => Player.position(key),
                seek: seconds => Player.seekTo(key, streamUrl, seconds),
            });
            ['start', 'end'].forEach(which => editor.querySelector(`[data-trim-${which}]`).oninput = event => {
                this.editing[which] = event.target.value;
                this.syncPlayers();
            });
            editor.querySelectorAll('[data-mark]').forEach(button => button.onclick = () => {
                if (Player.key !== key) return toast('Play the track or click on the bar first, then mark the position.', 'info');
                const value = fmtTimePrecise(Player.position(key));
                editor.querySelector(`[data-trim-${button.dataset.mark}]`).value = value;
                this.editing[button.dataset.mark] = value;
                this.syncPlayers();
            });
            editor.querySelector('[data-trim-save]').onclick = () => {
                const start = editor.querySelector('[data-trim-start]').value.trim();
                const end = editor.querySelector('[data-trim-end]').value.trim();
                if (!start && !end) return toast('Set a start or an end first.', 'info');
                if ((start && parseTime(start) == null) || (end && parseTime(end) == null)) return toast('Use times like 0:05 or 1:32.', 'error');
                if (start && end && parseTime(end) <= parseTime(start)) return toast('The end must come after the start.', 'error');
                this.processTrack(track, { normalize: true, fades: true, tag: true, startTime: start, endTime: end }, 'Trimmed');
            };
        }
    },

    setEditing(path, mode) {
        this.editing = path ? { path, mode, start: '', end: '' } : null;
        this.draw();
    },

    syncPlayers() {
        document.querySelectorAll('#view [data-track]').forEach(row => {
            const key = `track:${row.dataset.track}`;
            const playing = Player.isPlaying(key);
            const button = row.querySelector('[data-play]');
            const wanted = playing ? 'pause' : 'play';
            if (button.dataset.state !== wanted) {
                button.dataset.state = wanted;
                button.innerHTML = icon(wanted, 'icon-sm');
                button.classList.toggle('border-accent', playing);
                refreshIcons();
            }
            const active = Player.key === key;
            const track = this.media.tracks.find(t => t.file_path === row.dataset.track);
            const progress = row.querySelector('[data-progress]');
            if (progress) {
                progress.classList.toggle('hidden', !active);
                if (active) {
                    const seek = progress.querySelector('[data-seek]');
                    const duration = Player.el.duration || track.duration || 0;
                    if (!seek.dataset.dragging) {
                        seek.max = duration;
                        seek.value = Player.position(key);
                    }
                    seek.style.setProperty('--level', `${duration ? (seek.value / duration) * 100 : 0}%`);
                    progress.querySelector('[data-clock]').textContent = `${fmtTime(Number(seek.value))} / ${fmtTime(duration)}`;
                }
            }

            const editor = row.querySelector('[data-trim-editor]');
            if (editor) {
                const duration = (active && Player.el.duration) || track.duration;
                const current = Player.position(key);
                Timeline.draw(editor.querySelector('[data-timeline]'), {
                    duration, current,
                    start: parseTime(editor.querySelector('[data-trim-start]').value),
                    end: parseTime(editor.querySelector('[data-trim-end]').value),
                });
                editor.querySelector('[data-trim-clock]').textContent = `${fmtTimePrecise(current)} / ${fmtTimePrecise(duration)}`;
                // Stop at the chosen end, like the trimmed file will
                const end = parseTime(editor.querySelector('[data-trim-end]').value);
                if (Player.isPlaying(key) && end != null && current >= end) Player.el.pause();
            }
        });
    },

    async processTrack(track, options, doneLabel) {
        Player.stop();
        toast(`Working on ${track.file_name}...`, 'info');
        const result = await api('/api/library/process', { file_path: track.file_path, ...options });
        if (result.success) {
            toast(`${doneLabel} ${track.file_name}.`, 'success');
            this.editing = null;
            await this.refresh();
        } else {
            toast(result.message || 'Could not process the track.', 'error');
        }
    },

    async retag(track) {
        const result = await api('/api/library/retag', { file_path: track.file_path });
        toast(result.success ? `Tags written to ${track.file_name}.` : (result.message || 'Could not write the tags.'), result.success ? 'success' : 'error');
    },

    // 'Main Theme' or the season folder, the same values the Add Theme destination uses
    destinationOf(track) {
        return track.location_type.startsWith('Main Theme') ? 'Main Theme' : track.location_type;
    },

    async rename(track, newName, destination) {
        if (!newName.trim()) return toast('Type a name for the track.', 'error');
        Player.stop();
        const moving = destination && destination !== this.destinationOf(track);
        const result = moving
            ? await api('/api/library/move', { file_path: track.file_path, destination, new_name: newName })
            : await api('/api/library/rename', { file_path: track.file_path, new_name: newName });
        if (!result.success) return toast(result.message, 'error');
        if (moving) toast(`${newName.trim()}: ${result.message}`, 'success');
        this.editing = null;
        App.library = null;
        await this.refresh();
    },

    async deleteTrack(track) {
        const ok = await confirmDialog({
            title: 'Delete theme',
            message: `<strong class="text-ink">${esc(track.file_name)}</strong> will be permanently deleted from disk.`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        Player.stop();
        const result = await api('/api/library/delete', { file_path: track.file_path });
        toast(result.message, result.success ? 'success' : 'error');
        App.library = null;
        await this.refresh();
    },

    async queueAction(action, id) {
        await api(`/api/queue/${action}`, { id });
        App.queue = await api('/api/queue');
        this.draw();
    },

    async refresh() {
        if (App.route.name === 'media') await this.render(document.getElementById('view'), App.route.arg);
    },

    onQueue(finishedMedia) {
        if (!this.media) return;
        if (finishedMedia?.has(this.media.folder_path)) return this.refresh();
        // Keep an open rename or trim editor: only redraw when this media has queue rows to update
        if (!this.editing) this.draw();
    },

    onTaskDone() {
        return this.refresh();
    },
};

Player.listeners.add(() => {
    if (App.route.name === 'media') App.pages.media.syncPlayers();
});
