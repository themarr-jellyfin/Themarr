// Settings page: library folders, audio defaults, Jellyfin, backup and account. Changes save on their own.

function fmtSize(bytes) {
    return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1048576))} MB`;
}

App.pages.settings = {
    async render(view) {
        const s = App.settings;
        const fx = s.audio_fx || {};
        const server = App.info.server_mode;
        const folders = await api('/api/library/folders').then(r => r.folders || []).catch(() => []);
        if (App.route.name !== 'settings') return;

        view.innerHTML = `
            <div class="sticky top-0 z-10 bg-page/95 backdrop-blur border-b border-line px-6 py-3"><h1 class="text-lg font-semibold">Settings</h1></div>
            <div class="p-6 max-w-3xl space-y-5">

                <section class="card">
                    <div class="px-5 py-3 border-b border-line"><h2 class="font-medium">Media folders</h2>
                        <p class="text-xs text-faint mt-0.5">The folders that hold your series and movies, one per library. Each subfolder is one media.</p></div>
                    <div id="setFolders" class="divide-y divide-line">
                        ${folders.length ? folders.map(f => `
                            <div class="px-5 py-3 flex items-center gap-3">
                                <span class="text-faint">${icon('folder')}</span>
                                <div class="min-w-0"><div>${esc(f.split(/[\\/]/).filter(Boolean).pop())}</div><div class="font-mono text-[11px] text-faint truncate" title="${esc(f)}">${esc(f)}</div></div>
                                <button data-remove-folder="${esc(f)}" class="ml-auto icon-btn hover:text-red-400" title="Remove from Themarr (nothing is deleted)">${icon('x')}</button>
                            </div>`).join('') : `<div class="px-5 py-4 text-xs text-muted">No folders yet.</div>`}
                        <div class="px-5 py-3"><button id="setAddFolder" class="btn btn-ghost text-accent-text">${icon('plus', 'icon-sm')}Add folder</button></div>
                    </div>
                    ${server && !(App.settings.library_folders || []).length && folders.length ? `<p class="px-5 pb-3 text-[11px] text-faint">Showing every folder under ${esc(App.info.media_root)} until you choose your own.</p>` : ''}
                </section>

                <section class="card">
                    <div class="px-5 py-3 border-b border-line"><h2 class="font-medium">Audio</h2>
                        <p class="text-xs text-faint mt-0.5">Defaults for every new theme. You can still change them for one track when you add it.</p></div>
                    <div class="p-5 grid grid-cols-[180px_1fr] gap-x-6 gap-y-4 items-center max-[700px]:grid-cols-1">
                        <label class="text-muted" for="setLufs">Loudness</label>
                        <div class="flex items-center gap-2"><input id="setLufs" type="number" min="-70" max="0" step="1" class="field w-20 text-center" value="${esc(s.lufs)}">
                            <span class="text-xs text-faint">LUFS. -24 matches TV loudness; closer to 0 is louder.</span></div>
                        <label class="text-muted">Fade in / fade out</label>
                        <div class="flex items-center gap-2"><input id="setFadeIn" type="number" min="0" max="10" class="field w-16 text-center" value="${esc(fx.fade_in || 0)}">
                            <span class="text-faint">/</span><input id="setFadeOut" type="number" min="0" max="10" class="field w-16 text-center" value="${esc(fx.fade_out || 0)}">
                            <span class="text-xs text-faint">seconds, 0 for none</span></div>
                        <label class="text-muted" for="setSilence">Silence at the start</label>
                        <label class="flex items-center gap-2 text-xs"><input id="setSilence" type="checkbox" class="w-4 h-4" ${fx.remove_silence ? 'checked' : ''}>Remove it</label>
                    </div>
                </section>

                <section class="card">
                    <div class="px-5 py-3 border-b border-line flex items-center gap-3">
                        <div><h2 class="font-medium">Jellyfin</h2><p class="text-xs text-faint mt-0.5">Official names, posters, genres and a rescan after new themes.</p></div>
                        <label class="ml-auto flex items-center gap-2 text-xs text-muted"><input id="setJellyOn" type="checkbox" class="w-4 h-4" ${s.jelly_check ? 'checked' : ''}>Use Jellyfin</label>
                    </div>
                    <div class="p-5 grid grid-cols-[180px_1fr] gap-x-6 gap-y-4 items-center max-[700px]:grid-cols-1">
                        <label class="text-muted" for="setJellyUrl">Server address</label>
                        <input id="setJellyUrl" class="field" placeholder="http://192.168.1.20:8096" value="${esc(s.jelly_url)}">
                        <label class="text-muted" for="setJellyKey">API key</label>
                        <div><input id="setJellyKey" type="password" class="field w-full" placeholder="Jellyfin Dashboard, API Keys" value="${esc(s.jelly_api)}">
                            <p class="text-[11px] text-faint mt-1">Use an administrator key: rescans and the buttons need it.</p></div>
                        <span></span>
                        <div class="flex items-center gap-3"><button id="setTest" class="btn">${icon('plug-zap')}Test connection</button><span id="setTestResult" class="text-xs"></span></div>
                        ${server ? `
                        <label class="text-muted">Buttons in Jellyfin</label>
                        <div>
                            <div class="flex items-center gap-3"><button id="setButtons" class="btn">${icon('mouse-pointer-click')}Install</button><span id="setButtonsResult" class="text-xs"></span></div>
                            <p class="text-[11px] text-faint mt-1">Adds a Themarr button to series, season and movie pages, for administrators. Needs the JavaScript Injector plugin. <a href="/jellyfin/themarr-buttons.js" target="_blank" class="text-accent-text hover:underline">View the script</a> to paste it by hand.</p>
                        </div>` : ''}
                    </div>
                </section>

                <section class="card">
                    <div class="px-5 py-3 border-b border-line"><h2 class="font-medium">Sources</h2>
                        <p class="text-xs text-faint mt-0.5">Where Themarr searches for themes, and where its suggestions come from.</p></div>
                    <div class="p-5 grid grid-cols-[180px_1fr] gap-x-6 gap-y-4 items-start max-[700px]:grid-cols-1">
                        <label class="text-muted pt-1" for="setSearchSource">Search</label>
                        <div>
                            <select id="setSearchSource" class="field w-48">
                                ${SEARCH_SOURCES.map(([id, label]) => `<option value="${id}" ${(s.search_source || 'youtube') === id ? 'selected' : ''}>${label}</option>`).join('')}
                            </select>
                            <p class="text-[11px] text-faint mt-1">Where Add Theme searches first. You can switch for each search; the Missing page uses YouTube. Some SoundCloud tracks only play a 30 s clip.</p>
                        </div>
                        <label class="text-muted" for="setThemerrDB">ThemerrDB</label>
                        <div>
                            <label class="flex items-center gap-2 text-xs"><input id="setThemerrDB" type="checkbox" class="w-4 h-4" ${s.use_themerrdb !== false ? 'checked' : ''}>Suggest the community pick for each movie and show</label>
                            <p class="text-[11px] text-faint mt-1"><a href="https://github.com/LizardByte/ThemerrDB" target="_blank" rel="noopener" class="text-accent-text hover:underline">ThemerrDB</a> is a shared list of themes by the LizardByte project. Its pick shows first in Add Theme and on the Missing page. Needs a TMDB or IMDb id, from Jellyfin or from the folder name, like <span class="font-mono">Movie (1999) [tmdbid-603]</span>.</p>
                        </div>
                    </div>
                </section>

                <section class="card">
                    <div class="px-5 py-3 border-b border-line"><h2 class="font-medium">Display</h2>
                        <p class="text-xs text-faint mt-0.5">Artwork from Jellyfin, or saved in the media folder (fanart.jpg, logo.png).</p></div>
                    <div class="p-5 grid grid-cols-[180px_1fr] gap-x-6 gap-y-4 items-center max-[700px]:grid-cols-1">
                        <label class="text-muted" for="setBackdrops">Backdrops</label>
                        <label class="flex items-center gap-2 text-xs"><input id="setBackdrops" type="checkbox" class="w-4 h-4" ${s.show_backdrops !== false ? 'checked' : ''}>Show background art on the Library and media pages</label>
                    </div>
                </section>

                <section class="card">
                    <div class="px-5 py-3 border-b border-line"><h2 class="font-medium">Backup</h2>
                        <p class="text-xs text-faint mt-0.5">All the themes of one library in a .zip. Restore puts each theme back in its media folder, on this computer or another one.</p></div>
                    <div class="p-5">
                        <div class="flex flex-wrap items-center gap-2">
                            <select id="setBackupLib" class="field py-1.5 text-xs">${folders.map(f => `<option value="${esc(f)}">${esc(f.split(/[\\/]/).pop())}</option>`).join('')}</select>
                            <button id="setExport" class="btn" ${folders.length ? '' : 'disabled'}>${icon('download')}Export</button>
                            <button id="setImport" class="btn" ${folders.length ? '' : 'disabled'}>${icon('upload')}Restore</button>
                        </div>
                        <div id="setBackupProgress"></div>
                    </div>
                </section>

                <section id="updates" class="card">
                    <div class="px-5 py-3 border-b border-line flex items-center gap-3">
                        <div><h2 class="font-medium">Updates</h2><p class="text-xs text-faint mt-0.5">Themarr asks GitHub for new versions when it opens and every 6 hours.</p></div>
                        <label class="ml-auto flex items-center gap-2 text-xs text-muted"><input id="setCheckUpdates" type="checkbox" class="w-4 h-4" ${s.check_updates !== false ? 'checked' : ''}>Check automatically</label>
                    </div>
                    <div id="setUpdateBody" class="p-5 text-muted">Checking for updates...</div>
                </section>

                ${server ? `
                <section class="card px-5 py-4 flex items-center gap-3">
                    <div><h2 class="font-medium">Account</h2><p class="text-xs text-faint mt-0.5">Signed in as <span class="text-ink">${esc(App.info.user)}</span>, a Jellyfin administrator.</p></div>
                    <form method="post" action="/logout" class="ml-auto"><button class="btn">${icon('log-out')}Sign out</button></form>
                </section>` : `
                <section class="card px-5 py-4 flex items-center gap-3">
                    <div><h2 class="font-medium">Tray app</h2><p class="text-xs text-faint mt-0.5">Themarr_Server.exe runs from the tray and opens Themarr in your browser.</p></div>
                    <label class="ml-auto flex items-center gap-2 text-xs text-muted"><input id="setOpenBrowser" type="checkbox" class="w-4 h-4" ${s.open_browser ? 'checked' : ''}>Open the browser on start</label>
                </section>`}

                <p class="text-[11px] text-faint text-center pt-2">Themarr ${esc(App.info.version)} · <a href="https://github.com/themarr-jellyfin/Themarr" target="_blank" class="hover:text-muted">GitHub</a></p>
            </div>`;

        this.bind(view, folders);
        refreshIcons();
        this.resumeBackup();
        this.drawUpdates(App.update || await App.checkUpdates(true));
    },

    drawUpdates(info) {
        const body = document.getElementById('setUpdateBody');
        if (!body) return;
        const check = `<button id="setCheckNow" class="btn">${icon('refresh-cw')}Check now</button>`;

        if (!info?.success) {
            body.innerHTML = `<div class="flex flex-wrap items-center gap-3"><span>Could not check for updates${info?.message ? `: ${esc(info.message)}` : '.'}</span>${check}</div>`;
        } else if (!info.newer) {
            body.innerHTML = `<div class="flex flex-wrap items-center gap-3">
                <span class="flex items-center gap-2 text-green-400">${icon('circle-check')}You have the latest version (${esc(info.current)}).</span>
                ${check}<a href="${esc(info.url)}" target="_blank" class="btn btn-ghost">${icon('external-link')}Release notes</a></div>`;
        } else {
            const size = info.asset_size ? ` (${Math.round(info.asset_size / 1048576)} MB)` : '';
            let action;
            if (info.can_self_update) {
                action = `<button id="setInstall" class="btn btn-primary">${icon('download')}Update now${size}</button>`;
            } else if (App.info.server_mode) {
                action = `<div class="w-full text-xs space-y-2">
                    <p>Update the container on the server, in the folder where you installed Themarr:</p>
                    <pre class="log-view bg-page border border-line rounded-md px-3 py-2 text-ink select-text whitespace-pre-wrap">git pull
docker compose up -d --build</pre>
                    <p class="text-faint">Then reload this page. If the release notes say the Jellyfin buttons changed, click Install again under Jellyfin.</p></div>`;
            } else {
                action = `<p class="w-full text-xs">This copy runs from the source code: update it with <code class="bg-raised px-1 rounded">git pull</code>, or download the new zip.</p>`;
            }
            body.innerHTML = `
                <div class="flex flex-wrap items-center gap-3">
                    <span class="flex items-center gap-2 text-accent-text">${icon('circle-arrow-up')}Version ${esc(info.latest)} is available. You have ${esc(info.current)}.</span>
                    <a href="${esc(info.url)}" target="_blank" class="btn btn-ghost">${icon('external-link')}Release page</a>
                    ${check}
                    ${action}
                </div>
                <div id="setInstallProgress"></div>
                <details class="mt-4" open>
                    <summary class="cursor-pointer select-none text-xs hover:text-ink">What's new in ${esc(info.name)}</summary>
                    <div class="mt-2 text-[13px] leading-relaxed max-h-80 overflow-y-auto scroll pr-2">${renderNotes(info.notes)}</div>
                </details>`;
        }
        refreshIcons();
        body.querySelector('#setCheckNow')?.addEventListener('click', async () => {
            body.querySelector('#setCheckNow').disabled = true;
            this.drawUpdates(await App.checkUpdates(true));
        });
        body.querySelector('#setInstall')?.addEventListener('click', () => this.installUpdate(info));
    },

    async installUpdate(info) {
        const ok = await confirmDialog({
            title: `Update to ${info.latest}`,
            message: 'Themarr downloads the new version, closes and opens again on its own in a few seconds. Your settings, themes and backups are kept. Wait for the queue to finish first if it is running.',
            confirmLabel: 'Update now',
        });
        if (!ok) return;
        const result = await api('/api/updates/install', {});
        if (!result.success) return toast(result.message, 'error');

        const box = document.getElementById('setInstallProgress');
        const button = document.getElementById('setInstall');
        if (button) button.disabled = true;
        const show = (text, percent) => {
            if (!box) return;
            box.innerHTML = `<div class="mt-4 flex items-center gap-3 text-xs">
                <span class="text-accent-text">${icon('loader-circle', 'animate-spin')}</span><span class="flex-1">${esc(text)}</span>
                ${percent != null ? `<div class="w-48 h-1.5 bg-raised rounded-full overflow-hidden"><div class="h-full bg-accent" style="width:${percent}%"></div></div>` : ''}</div>`;
            refreshIcons();
        };

        const follow = async () => {
            const state = await api('/api/updates/status').catch(() => ({ stage: 'restarting' }));
            if (state.stage === 'downloading') {
                const mb = n => (n / 1048576).toFixed(0);
                show(`Downloading ${mb(state.downloaded)} of ${mb(state.total)} MB...`, state.total ? Math.round(state.downloaded / state.total * 100) : null);
            } else if (state.stage === 'preparing') {
                show('Unpacking the new version...');
            } else if (state.stage === 'error') {
                if (box) box.innerHTML = '';
                if (button) button.disabled = false;
                return toast(`Update failed: ${state.message}`, 'error');
            } else if (state.stage === 'restarting') {
                show('Themarr is restarting with the new version. This page reloads by itself.');
                return this.waitForNewVersion(info.latest);
            }
            setTimeout(follow, 700);
        };
        follow();
    },

    // The tray app keeps this page open: reload it once the new version answers
    async waitForNewVersion(version) {
        for (let i = 0; i < 120; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const info = await api('/api/app_info').catch(() => null);
            if (info?.version === version) return location.reload();
        }
        toast('Themarr did not come back. Open it again from the Start menu or its folder.', 'error');
    },

    bind(view, folders) {
        const $ = id => view.querySelector(`#${id}`);

        const saveAudio = () => {
            const lufs = Math.max(-70, Math.min(0, parseInt($('setLufs').value, 10) || -24));
            const fadeIn = Math.max(0, Math.min(10, parseFloat($('setFadeIn').value) || 0));
            const fadeOut = Math.max(0, Math.min(10, parseFloat($('setFadeOut').value) || 0));
            const silence = $('setSilence').checked;
            App.saveSettings({
                lufs: String(lufs),
                audio_fx: { enabled: fadeIn > 0 || fadeOut > 0 || silence, remove_silence: silence, fade_in: fadeIn, fade_out: fadeOut },
            }).then(ok => ok && toast('Audio settings saved.', 'success'));
        };
        ['setLufs', 'setFadeIn', 'setFadeOut', 'setSilence'].forEach(id => $(id).onchange = saveAudio);

        const saveJellyfin = () => App.saveSettings({
            jelly_check: $('setJellyOn').checked, jelly_url: $('setJellyUrl').value.trim(), jelly_api: $('setJellyKey').value.trim(),
        }).then(ok => { if (ok) { App.library = null; toast('Jellyfin settings saved.', 'success'); } });
        ['setJellyOn', 'setJellyUrl', 'setJellyKey'].forEach(id => $(id).onchange = saveJellyfin);

        $('setTest').onclick = async () => {
            const out = $('setTestResult');
            out.className = 'text-xs text-muted';
            out.textContent = 'Testing...';
            const result = await api('/api/test_jellyfin', { url: $('setJellyUrl').value, api_key: $('setJellyKey').value });
            out.className = `text-xs ${result.status === 'success' ? 'text-green-400' : 'text-red-400'}`;
            out.textContent = result.message.replace(/^[✅❌]\s*/, '');
        };

        const buttons = $('setButtons');
        if (buttons) buttons.onclick = async () => {
            const out = $('setButtonsResult');
            out.className = 'text-xs text-muted';
            out.textContent = 'Installing...';
            const result = await api('/api/jellyfin/install_buttons', {});
            out.className = `text-xs ${result.success ? 'text-green-400' : 'text-red-400'}`;
            out.textContent = result.message;
        };

        $('setCheckUpdates').onchange = async event => {
            await App.saveSettings({ check_updates: event.target.checked });
            if (event.target.checked) App.checkUpdates(true);
        };

        $('setBackdrops').onchange = event => App.saveSettings({ show_backdrops: event.target.checked });
        $('setSearchSource').onchange = event => App.saveSettings({ search_source: event.target.value });
        $('setThemerrDB').onchange = event => {
            App.saveSettings({ use_themerrdb: event.target.checked });
            // Suggestions already loaded were made with the old setting
            App.pages.addTheme.suggestedCache.clear();
            App.pages.missing.suggestions.clear();
            App.pages.missing.picks.clear();
        };

        const openBrowser = $('setOpenBrowser');
        if (openBrowser) openBrowser.onchange = () => App.saveSettings({ open_browser: openBrowser.checked });

        view.querySelectorAll('[data-remove-folder]').forEach(button => button.onclick = () =>
            this.saveFolders(folders.filter(f => f !== button.dataset.removeFolder)));
        $('setAddFolder').onclick = () => this.addFolder(folders);
        $('setExport').onclick = () => this.exportBackup($('setBackupLib').value);
        $('setImport').onclick = () => this.importBackup($('setBackupLib').value);
    },

    async saveFolders(folders) {
        const result = await api('/api/library/folders', { folders });
        if (!result.success) return toast(result.message, 'error');
        App.settings.library_folders = folders;
        App.library = null;
        App.render();
    },

    async addFolder(current) {
        let folder;
        if (App.info.server_mode) {
            folder = await this.pickServerFolder();
        } else {
            const result = await api('/api/select_folder', {});
            folder = result.success ? result.path : null;
        }
        if (folder && !current.includes(folder)) this.saveFolders([...current, folder]);
    },

    // Server: browse the media volume and pick a library folder (one level below it)
    pickServerFolder() {
        return new Promise(resolve => {
            const show = async path => {
                const result = await api('/api/browse_folders', { folder: path });
                if (!result.success) return toast(result.message, 'error');
                const atRoot = result.path === result.root;
                const dialog = openDialog(`
                    <div class="px-5 py-4 border-b border-line"><h2 class="font-semibold">Add a media folder</h2>
                        <p class="text-xs text-faint mt-0.5">Choose a library folder, such as TV or Movies.</p></div>
                    <div class="px-5 pt-3 text-xs text-muted flex flex-wrap items-center gap-1">${result.breadcrumb.map((c, i) =>
                        `${i ? '<span class="text-faint">/</span>' : ''}<button data-path="${esc(c.path)}" class="hover:text-ink">${esc(c.name)}</button>`).join('')}</div>
                    <div class="max-h-80 overflow-y-auto scroll px-3 py-2">
                        ${result.folders.length ? result.folders.map(f => `
                            <button data-path="${esc(f.path)}" ${atRoot ? `data-pick="${esc(f.path)}"` : ''} class="w-full text-left px-2 py-2 rounded-md hover:bg-raised flex items-center gap-2">
                                <span class="text-faint">${icon('folder')}</span><span class="flex-1 truncate">${esc(f.name)}</span>
                                ${atRoot ? '<span class="text-[11px] text-accent-text">Choose</span>' : ''}
                            </button>`).join('') : '<p class="px-2 py-4 text-xs text-faint">No folders here.</p>'}
                    </div>
                    <div class="px-5 py-3 border-t border-line flex justify-end"><button data-cancel class="btn btn-ghost">Cancel</button></div>`);
                dialog.querySelectorAll('[data-path]').forEach(b => b.onclick = () => {
                    if (b.dataset.pick) { closeDialog(); resolve(b.dataset.pick); } else show(b.dataset.path);
                });
                dialog.querySelector('[data-cancel]').onclick = () => { closeDialog(); resolve(null); };
            };
            show(null);
        });
    },

    // ---------------- Backup ----------------
    // Export and restore run on the server, one at a time; the page polls /api/library/backup/status

    async exportBackup(folder) {
        let savePath = '';
        if (!App.info.server_mode) {
            const choice = await api('/api/library/backup/save_dialog', { base_path: folder });
            if (!choice.success) return;
            savePath = choice.path;
        }
        const result = await api('/api/library/backup/export', { base_path: folder, save_path: savePath });
        if (!result.success) return toast(result.message, 'error');
        this.followBackup();
    },

    async importBackup(folder) {
        let zipPath;
        if (App.info.server_mode) {
            zipPath = await this.uploadBackup();
        } else {
            const result = await api('/api/library/backup/select_file', {});
            zipPath = result.success ? result.file_path : null;
        }
        if (!zipPath) return;

        this.drawBackup('Reading the backup...');
        const analysis = await api('/api/library/backup/analyze', { zip_path: zipPath, base_path: folder });
        this.drawBackup(null);
        if (!analysis.success) {
            if (App.info.server_mode) api('/api/library/backup/restore', { zip_path: zipPath, base_path: folder, decision: 'cancel' });
            return toast(analysis.message, 'error');
        }

        const decision = await this.askRestore(analysis, folder);
        const result = await api('/api/library/backup/restore', { zip_path: zipPath, base_path: folder, decision });
        if (!result.success) return toast(result.message, 'error');
        if (decision !== 'cancel') this.followBackup();
    },

    // Server: XMLHttpRequest instead of fetch, to show how much of the file is uploaded
    uploadBackup() {
        return new Promise(resolve => {
            const input = document.getElementById('backupUploadInput');
            input.value = '';
            input.onchange = () => {
                const file = input.files[0];
                if (!file) return resolve(null);
                const form = new FormData();
                form.append('file', file);
                const request = new XMLHttpRequest();
                request.open('POST', '/api/library/backup/upload');
                request.upload.onprogress = e => {
                    if (e.lengthComputable) this.drawBackup(`Uploading ${file.name}: ${fmtSize(e.loaded)} of ${fmtSize(e.total)}...`, e.loaded / e.total * 100);
                };
                const done = (result, fallback) => {
                    this.drawBackup(null);
                    if (!result.success) toast(result.message || fallback, 'error');
                    resolve(result.success ? result.file_path : null);
                };
                request.onload = () => {
                    let result = {};
                    try { result = JSON.parse(request.responseText); } catch { /* answered with an error page */ }
                    done(result, request.status === 413 ? 'The file is larger than 2 GB.' : 'Upload failed.');
                };
                request.onerror = () => done({}, 'Upload failed.');
                this.drawBackup(`Uploading ${file.name}...`, 0);
                request.send(form);
            };
            input.click();
        });
    },

    askRestore(analysis, folder) {
        return new Promise(resolve => {
            const missing = analysis.missing_folders;
            const library = esc(folder.split(/[\\/]/).pop());
            const none = missing.length === analysis.media_count;
            const canCreate = !App.info.server_mode && missing.length > 0;
            const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
            const dialog = openDialog(`
                <div class="p-5">
                    <h2 class="font-semibold text-[15px]">Restore themes</h2>
                    <p class="text-muted mt-2 leading-relaxed">The backup has ${plural(analysis.theme_count, 'theme')} for ${plural(analysis.media_count, 'media folder')}.
                        They go back to <span class="text-ink">${library}</span>, and a theme with the same name there is replaced.</p>
                    ${missing.length ? `
                    <p class="text-muted mt-3">${none ? `None of these media folders are in ${library}. Check that you chose the right library.` :
                        `${plural(missing.length, 'media folder')} ${missing.length === 1 ? 'is' : 'are'} not in ${library}:`}</p>
                    <div class="mt-2 max-h-40 overflow-y-auto scroll bg-page border border-line rounded-md p-2 font-mono text-xs text-muted">${missing.map(esc).join('<br>')}</div>
                    ${App.info.server_mode ? '<p class="text-[11px] text-faint mt-2">On the server, Themarr never creates media folders.</p>' : ''}` : ''}
                </div>
                <div class="px-5 py-3 border-t border-line flex flex-wrap justify-end gap-2">
                    <button data-d="cancel" class="btn btn-ghost">Cancel</button>
                    ${canCreate ? '<button data-d="create_all" class="btn">Create folders and restore all</button>' : ''}
                    ${none ? '' : `<button data-d="skip_missing" class="btn btn-primary">${missing.length ? 'Restore the others' : 'Restore'}</button>`}
                </div>`);
            dialog.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { closeDialog(); resolve(b.dataset.d); });
        });
    },

    // text null clears the box
    drawBackup(text, percent = null, cancel = false) {
        const box = document.getElementById('setBackupProgress');
        if (!box) return;
        const busy = text !== null;
        ['setExport', 'setImport', 'setBackupLib'].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = busy; });
        box.innerHTML = busy ? `<div class="mt-4 flex items-center gap-3 text-xs">
            <span class="text-accent-text">${icon('loader-circle', 'animate-spin')}</span><span class="flex-1 min-w-0 truncate">${esc(text)}</span>
            ${percent !== null ? `<div class="w-48 h-1.5 bg-raised rounded-full overflow-hidden shrink-0"><div class="h-full bg-accent transition-[width]" style="width:${percent}%"></div></div>` : ''}
            ${cancel ? '<button id="setBackupCancel" class="btn btn-ghost py-1 text-xs">Cancel</button>' : ''}</div>` : '';
        refreshIcons();
        box.querySelector('#setBackupCancel')?.addEventListener('click', event => {
            event.currentTarget.disabled = true;
            api('/api/library/backup/cancel', {});
        });
    },

    // Back on Settings while a backup runs, or after it ended elsewhere: show it again
    async resumeBackup() {
        const state = await api('/api/library/backup/status').catch(() => null);
        if (state && (this.backupFollowing || state.stage === 'scanning' || state.stage === 'working')) this.followBackup();
    },

    async followBackup() {
        this.backupFollowing = true;
        if (!document.getElementById('setBackupProgress')) return;    // left Settings: resumeBackup picks it up again
        const state = await api('/api/library/backup/status').catch(() => null);
        if (!state) return setTimeout(() => this.followBackup(), 1500);
        const exporting = state.task === 'export';

        if (state.stage === 'scanning') {
            this.drawBackup(exporting ? 'Finding the themes of this library...' : 'Reading the backup...', null, true);
            return setTimeout(() => this.followBackup(), 700);
        }
        if (state.stage === 'working') {
            const percent = state.total ? state.done / state.total * 100 : 0;
            this.drawBackup(`${exporting ? 'Backing up' : 'Restoring'} ${state.done} of ${state.total} themes...`, percent, true);
            return setTimeout(() => this.followBackup(), 700);
        }

        this.backupFollowing = false;
        this.drawBackup(null);
        if (state.stage === 'error') return toast(state.message, 'error');
        if (state.stage === 'cancelled') return toast(state.message, 'info');
        if (!exporting) App.library = null;
        if (exporting && App.info.server_mode) {
            location.href = `/api/library/backup/download?name=${encodeURIComponent(state.filename)}`;
        }
        toast(state.message, 'success');
        const where = !exporting ? '' : App.info.server_mode ? ` ${fmtSize(state.size)}, downloading it now.` : ` ${fmtSize(state.size)}, saved to ${state.path}`;
        document.getElementById('setBackupProgress').innerHTML = `<p class="mt-4 flex items-center gap-2 text-xs text-green-400 min-w-0">${icon('circle-check')}<span class="truncate" title="${esc(state.path)}">${esc(state.message + where)}</span></p>`;
        refreshIcons();
    },
};
