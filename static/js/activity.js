// Activity page: the download queue, the running task and the logs

App.pages.activity = {
    tab: 'queue',

    render(view) {
        view.innerHTML = `
            <div class="sticky top-0 z-10 bg-page/95 backdrop-blur border-b border-line px-6 pt-3 flex items-end gap-6">
                <h1 class="text-lg font-semibold pb-3">Activity</h1>
                <button data-tab="queue" class="pb-3 border-b-2 text-sm">Queue <span id="tabQueueCount" class="text-faint"></span></button>
                <button data-tab="logs" class="pb-3 border-b-2 text-sm">Logs</button>
                <div id="activityActions" class="ml-auto pb-2.5 flex gap-2"></div>
            </div>
            <div id="activityBody"></div>`;
        view.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { this.tab = b.dataset.tab; this.draw(); });
        this.draw();
    },

    draw() {
        document.querySelectorAll('[data-tab]').forEach(b => b.className =
            `pb-3 border-b-2 text-sm ${b.dataset.tab === this.tab ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`);
        this.tab === 'queue' ? this.drawQueue() : this.drawLogs();
        refreshIcons();
    },

    drawQueue() {
        const body = document.getElementById('activityBody');
        const actions = document.getElementById('activityActions');
        if (!body) return;
        const { items, paused } = App.queue;
        const pending = items.filter(i => i.status === 'waiting' || i.status === 'processing').length;
        const finished = items.filter(i => i.status === 'completed').length;
        document.getElementById('tabQueueCount').textContent = items.length ? items.length : '';

        actions.innerHTML = `
            ${finished ? `<button id="qClear" class="btn btn-ghost">${icon('list-x')}Clear finished</button>` : ''}
            <button id="qPause" class="btn">${paused ? `${icon('play')}Resume queue` : `${icon('pause')}Pause queue`}</button>`;
        actions.querySelector('#qPause').onclick = async () => {
            await api('/api/queue/pause', { paused: !paused });
            App.queue = await api('/api/queue');
            App.updateIndicator();
            this.draw();
        };
        const clear = actions.querySelector('#qClear');
        if (clear) clear.onclick = async () => {
            await api('/api/queue/clear', {});
            App.queue = await api('/api/queue');
            this.draw();
        };

        const task = App.status.is_processing ? `
            <div class="card px-4 py-3 mb-5 flex items-center gap-3">
                <span class="text-accent-text">${icon('loader-circle', 'animate-spin')}</span>
                <span class="flex-1 truncate">${esc(App.status.statusText)}</span>
                <div class="w-48 h-1.5 bg-raised rounded-full overflow-hidden"><div class="h-full bg-accent" style="width:${App.status.percentage || 0}%"></div></div>
                <span class="text-xs text-faint w-14 text-right">${esc(App.status.percentageText)}</span>
            </div>` : '';

        if (!items.length) {
            body.innerHTML = `<div class="p-6">${task}
                <div class="max-w-md mx-auto mt-12 text-center">
                    <div class="text-faint inline-block icon-xl">${icon('inbox')}</div>
                    <h2 class="text-base font-medium mt-3">The queue is empty</h2>
                    <p class="text-muted mt-2">Open a media in the Library and use <strong class="text-ink">Add Theme</strong>, or pick suggestions in <a href="#/missing" class="text-accent-text hover:underline">Missing</a>.</p>
                </div></div>`;
            return;
        }

        const rows = items.map(item => `
            <tr>
                <td class="py-3 pl-2"><a href="#/media/${encodeURIComponent(item.media_folder)}" class="hover:underline">${esc(item.media_name)}</a></td>
                <td>${esc(item.name)}</td>
                <td class="text-muted">${item.destination === 'Main Theme' ? 'Main theme' : esc(item.destination)}</td>
                <td>${this.statusCell(item)}</td>
                <td class="text-right whitespace-nowrap pr-1">
                    ${item.status === 'error' ? `<button data-retry="${item.id}" class="btn btn-ghost text-accent-text">Retry</button>` : ''}
                    ${item.status !== 'processing' ? `<button data-remove="${item.id}" class="icon-btn" title="Remove from the list">${icon('x')}</button>` : ''}
                </td>
            </tr>`).join('');

        body.innerHTML = `
            <div class="p-6">
                ${task}
                ${paused && pending ? `<div class="mb-4 text-xs text-amber-300 flex items-center gap-2">${icon('pause', 'icon-sm')}The queue is paused. Nothing new starts until you resume it.</div>` : ''}
                <table class="w-full text-left">
                    <thead class="text-[11px] uppercase tracking-wider text-faint border-b border-line">
                        <tr><th class="py-2 pl-2 font-medium">Media</th><th class="font-medium">Theme</th><th class="font-medium">Save to</th><th class="font-medium w-[28%]">Status</th><th></th></tr>
                    </thead>
                    <tbody class="divide-y divide-line">${rows}</tbody>
                </table>
                <p class="mt-6 text-[11px] text-faint flex items-center gap-1.5">${icon('info', 'icon-sm')}After the last theme of a media, Themarr writes its tags and cover and asks Jellyfin to rescan it.</p>
            </div>`;

        body.querySelectorAll('[data-retry]').forEach(b => b.onclick = () => this.itemAction('retry', +b.dataset.retry));
        body.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => this.itemAction('remove', +b.dataset.remove));
    },

    statusCell(item) {
        if (item.status === 'processing') {
            const progress = item.progress ?? 0;
            return `<div class="max-w-[240px]">
                <span class="text-xs text-accent-text flex items-center gap-1.5">${icon('loader-circle', 'icon-sm animate-spin')}${esc(item.stage || 'Working')}...<span data-progress-text="${item.id}" class="ml-auto text-faint tabular-nums">${progress}%</span></span>
                <div class="mt-1.5 h-1 bg-raised rounded-full overflow-hidden"><div data-progress="${item.id}" class="h-full bg-accent rounded-full transition-[width] duration-700 ease-out" style="width:${progress}%"></div></div>
            </div>`;
        }
        if (item.status === 'completed') return `<span class="text-xs text-green-400 flex items-center gap-1.5">${icon('circle-check', 'icon-sm')}Done</span>`;
        if (item.status === 'error') {
            return `<span class="text-xs text-red-400 flex items-center gap-1.5" title="${esc(item.message)}">${icon('circle-alert', 'icon-sm')}Failed<span class="text-faint truncate max-w-[220px]">${esc(item.message)}</span></span>`;
        }
        return `<span class="text-xs text-muted flex items-center gap-1.5">${icon('clock', 'icon-sm')}${App.queue.paused ? 'Paused' : 'Waiting'}</span>`;
    },

    async itemAction(action, id) {
        await api(`/api/queue/${action}`, { id });
        App.queue = await api('/api/queue');
        App.updateIndicator();
        this.draw();
    },

    drawLogs() {
        const body = document.getElementById('activityBody');
        const actions = document.getElementById('activityActions');
        if (!body) return;
        actions.innerHTML = `
            <button id="logCopy" class="btn btn-ghost">${icon('copy')}Copy</button>
            <button id="logClear" class="btn btn-ghost">${icon('eraser')}Clear</button>`;
        body.innerHTML = `
            <div class="p-6">
                <div id="logView" class="log-view bg-[#0d0d10] border border-line rounded-lg p-4 text-[11.5px] leading-relaxed text-muted h-[calc(100vh-190px)] overflow-y-auto scroll select-text whitespace-pre-wrap"></div>
            </div>`;
        actions.querySelector('#logCopy').onclick = async () => {
            await navigator.clipboard.writeText(App.logs.join('\n')).catch(() => {});
            toast('Logs copied.', 'success');
        };
        actions.querySelector('#logClear').onclick = () => { App.logs = []; this.fillLogs(); };
        this.fillLogs();
    },

    fillLogs() {
        const view = document.getElementById('logView');
        if (!view) return;
        const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
        view.innerHTML = App.logs.length ? App.logs.map(line => {
            const cls = /❌|ERROR|failed|Error/.test(line) ? 'text-red-400' : /⚠️|WARN/.test(line) ? 'text-amber-300' : /SUCCESS|✅|Done/.test(line) ? 'text-green-400' : '';
            return `<div class="${cls}">${esc(line)}</div>`;
        }).join('') : '<span class="text-faint">Nothing logged yet.</span>';
        if (atBottom) view.scrollTop = view.scrollHeight;
    },

    onQueue() {
        if (this.tab === 'queue') this.draw();
    },

    // Only the percentage moved: update the bars in place, so the spinners do not restart every second
    onProgress() {
        for (const item of App.queue.items) {
            if (item.status !== 'processing') continue;
            const bar = document.querySelector(`[data-progress="${item.id}"]`);
            const text = document.querySelector(`[data-progress-text="${item.id}"]`);
            if (bar) bar.style.width = `${item.progress ?? 0}%`;
            if (text) text.textContent = `${item.progress ?? 0}%`;
        }
    },

    onLogs() {
        if (this.tab === 'logs') this.fillLogs();
    },

    onTaskDone() {
        if (this.tab === 'queue') this.draw();
    },
};
