// Hardware Monitor Plugin for Sail Launcher
// Compact real-time CPU, RAM, GPU usage indicator

module.exports = function(SailAPI) {
    const os = require('os');
    const { execSync } = require('child_process');

    const widget = document.createElement('div');
    widget.id = 'hw-monitor-widget';
    widget.innerHTML = `
        <style>
            #hw-monitor-widget {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 4px 10px;
                background: rgba(0, 0, 0, 0.35);
                backdrop-filter: blur(10px);
                border: 1px solid var(--border-color, rgba(255,255,255,0.08));
                border-radius: 8px;
                font-size: 10px;
                font-family: 'Segoe UI', sans-serif;
                color: var(--text-color, #ccc);
                user-select: none;
                flex-shrink: 0;
                -webkit-app-region: no-drag;
                height: 26px;
                margin-left: 12px;
            }
            #hw-monitor-widget:hover { border-color: var(--accent-color, rgba(168,85,247,0.4)); }
            .hw-m { display: flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; }
            .hw-m .hw-l { opacity: 0.5; font-weight: 600; font-size: 9px; }
            .hw-m .hw-v { font-weight: 700; min-width: 26px; text-align: right; }
            .hw-d { width: 1px; height: 12px; background: rgba(255,255,255,0.1); }
        </style>
        <div class="hw-m"><span class="hw-l">CPU</span><span class="hw-v" id="hwCpu">--%</span></div>
        <div class="hw-d"></div>
        <div class="hw-m"><span class="hw-l">RAM</span><span class="hw-v" id="hwRam">--%</span></div>
        <div class="hw-d"></div>
        <div class="hw-m"><span class="hw-l">GPU</span><span class="hw-v" id="hwGpu">--%</span></div>
    `;

    // Always insert into the titlebar — it never moves
    const titleDiv = document.querySelector('.titlebar-title');
    if (titleDiv) {
        // Insert after the "Sail Launcher" span and before the topHeader containers
        const topContainer = document.getElementById('topHeaderActionButtonsContainer');
        if (topContainer) {
            titleDiv.insertBefore(widget, topContainer);
        } else {
            titleDiv.appendChild(widget);
        }
    }

    function colorize(el, pct) {
        if (pct < 50) el.style.color = '#10b981';
        else if (pct < 80) el.style.color = '#f59e0b';
        else el.style.color = '#ef4444';
    }

    let prevCpu = null;
    function getCpu() {
        const cpus = os.cpus();
        let idle = 0, total = 0;
        cpus.forEach(c => { for (let t in c.times) total += c.times[t]; idle += c.times.idle; });
        if (prevCpu) {
            const di = idle - prevCpu.idle, dt = total - prevCpu.total;
            prevCpu = { idle, total };
            return dt > 0 ? ((1 - di / dt) * 100) : 0;
        }
        prevCpu = { idle, total };
        return 0;
    }

    function getRam() { return ((os.totalmem() - os.freemem()) / os.totalmem()) * 100; }

    function getGpu() {
        try {
            return parseFloat(execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', { timeout: 2000, windowsHide: true }).toString().trim()) || 0;
        } catch(e) { return -1; }
    }

    function update() {
        const cpuEl = document.getElementById('hwCpu');
        const ramEl = document.getElementById('hwRam');
        const gpuEl = document.getElementById('hwGpu');

        const cpu = getCpu();
        if (cpuEl) { cpuEl.textContent = Math.round(cpu) + '%'; colorize(cpuEl, cpu); }

        const ram = getRam();
        if (ramEl) { ramEl.textContent = Math.round(ram) + '%'; colorize(ramEl, ram); }

        const gpu = getGpu();
        if (gpuEl) {
            if (gpu >= 0) { gpuEl.textContent = Math.round(gpu) + '%'; colorize(gpuEl, gpu); }
            else gpuEl.textContent = 'N/A';
        }
    }

    update();
    setInterval(update, 2000);
    console.log('[Plugin] Hardware Monitor loaded');
};
