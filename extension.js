import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// --- Resource readers ---

function readAllCpuTimes() {
    const contents = GLib.file_get_contents('/proc/stat');
    if (!contents[0]) return null;

    const decoder = new TextDecoder();
    const lines = decoder.decode(contents[1]).split('\n');
    const results = [];

    for (const line of lines) {
        if (!line.startsWith('cpu')) break;
        const parts = line.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + b, 0);
        results.push({ idle, total });
    }

    return results; // [0] = overall, [1..N] = per-core
}

function getCpuUsage(prev, curr) {
    if (!prev || !curr) return 0;
    const totalDiff = curr.total - prev.total;
    const idleDiff = curr.idle - prev.idle;
    if (totalDiff === 0) return 0;
    return Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
}

function getMemoryInfo() {
    const contents = GLib.file_get_contents('/proc/meminfo');
    if (!contents[0]) return { percent: 0, used: 0, total: 0 };

    const decoder = new TextDecoder();
    const text = decoder.decode(contents[1]);
    const getValue = (key) => {
        const match = text.match(new RegExp(`${key}:\\s+(\\d+)`));
        return match ? parseInt(match[1]) : 0;
    };

    const total = getValue('MemTotal');
    const free = getValue('MemFree');
    const available = getValue('MemAvailable');
    const buffers = getValue('Buffers');
    const cached = getValue('Cached');
    const swapTotal = getValue('SwapTotal');
    const swapFree = getValue('SwapFree');

    const used = total - available;
    const percent = Math.round((used / total) * 100);
    const swapUsed = swapTotal - swapFree;
    const swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0;

    const toGB = (kb) => (kb / 1048576).toFixed(1);

    return {
        percent,
        used: toGB(used),
        total: toGB(total),
        free: toGB(free),
        cached: toGB(cached + buffers),
        swapUsed: toGB(swapUsed),
        swapTotal: toGB(swapTotal),
        swapPercent,
    };
}

function getDiskInfo() {
    const contents = GLib.file_get_contents('/proc/mounts');
    if (!contents[0]) return { percent: 0, partitions: [] };

    const decoder = new TextDecoder();
    const lines = decoder.decode(contents[1]).split('\n');
    const validFs = ['ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'ntfs', 'vfat', 'fuseblk', 'f2fs', 'zfs'];
    const seen = new Set();
    const partitions = [];
    let totalSize = 0;
    let totalUsed = 0;

    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 3) continue;
        const [device, mountpoint, fstype] = parts;
        if (!validFs.includes(fstype)) continue;
        if (seen.has(device)) continue;
        seen.add(device);

        try {
            const file = Gio.File.new_for_path(mountpoint);
            const fsInfo = file.query_filesystem_info(
                'filesystem::size,filesystem::used,filesystem::free', null
            );
            const size = fsInfo.get_attribute_uint64('filesystem::size');
            const free = fsInfo.get_attribute_uint64('filesystem::free');
            if (size === 0) continue;
            const used = size - free;
            const percent = Math.round((used / size) * 100);

            const toGB = (b) => (b / 1073741824).toFixed(1);
            partitions.push({
                device: device.split('/').pop(),
                mountpoint,
                percent,
                used: toGB(used),
                total: toGB(size),
            });
            totalSize += size;
            totalUsed += used;
        } catch (_e) {
            continue;
        }
    }

    const percent = totalSize > 0 ? Math.round((totalUsed / totalSize) * 100) : 0;
    return { percent, partitions };
}

function readDiskIO() {
    const contents = GLib.file_get_contents('/proc/diskstats');
    if (!contents[0]) return {};

    const decoder = new TextDecoder();
    const lines = decoder.decode(contents[1]).split('\n');
    const devices = {};

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 14) continue;
        const name = parts[2];
        // Only whole disks (e.g. nvme0n1, sda) not partitions
        if (/\d+$/.test(name) && !name.startsWith('nvme')) continue;
        if (/p\d+$/.test(name)) continue; // skip nvme partitions
        if (name.startsWith('dm-') || name.startsWith('loop') || name.startsWith('sr')) continue;

        // Fields: sectors read (index 5), sectors written (index 9), sector = 512 bytes
        const sectorsRead = parseInt(parts[5]);
        const sectorsWritten = parseInt(parts[9]);
        devices[name] = { read: sectorsRead * 512, written: sectorsWritten * 512 };
    }

    return devices;
}

function getDiskIORate(prev, curr, intervalSec) {
    if (!prev || !curr) return { totalRead: 0, totalWrite: 0, devices: [] };

    let totalRead = 0;
    let totalWrite = 0;
    const devices = [];

    for (const name of Object.keys(curr)) {
        if (!prev[name]) continue;
        const readRate = (curr[name].read - prev[name].read) / intervalSec;
        const writeRate = (curr[name].written - prev[name].written) / intervalSec;
        totalRead += readRate;
        totalWrite += writeRate;
        devices.push({ name, read: readRate, write: writeRate });
    }

    return { totalRead, totalWrite, devices };
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B/s`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB/s`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB/s`;
    return `${(bytes / 1073741824).toFixed(1)} GB/s`;
}

function formatBytesShort(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} K`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} M`;
    return `${(bytes / 1073741824).toFixed(1)} G`;
}

function readNetIO() {
    const contents = GLib.file_get_contents('/proc/net/dev');
    if (!contents[0]) return {};

    const decoder = new TextDecoder();
    const lines = decoder.decode(contents[1]).split('\n').slice(2); // skip headers
    const interfaces = {};

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const name = parts[0].replace(':', '');
        // Skip loopback, veth (docker), bridge with no traffic
        if (name === 'lo' || name.startsWith('veth')) continue;
        const rx = parseInt(parts[1]);
        const tx = parseInt(parts[9]);
        interfaces[name] = { rx, tx };
    }

    return interfaces;
}

function getNetIORate(prev, curr, intervalSec) {
    if (!prev || !curr) return { totalRx: 0, totalTx: 0, interfaces: [] };

    let totalRx = 0;
    let totalTx = 0;
    const interfaces = [];

    for (const name of Object.keys(curr)) {
        if (!prev[name]) continue;
        const rxRate = (curr[name].rx - prev[name].rx) / intervalSec;
        const txRate = (curr[name].tx - prev[name].tx) / intervalSec;
        totalRx += rxRate;
        totalTx += txRate;
        interfaces.push({ name, rx: rxRate, tx: txRate });
    }

    return { totalRx, totalTx, interfaces };
}

function getCpuTemp() {
    const hwmonBase = '/sys/class/hwmon';
    try {
        const dir = Gio.File.new_for_path(hwmonBase);
        const enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const hwmonPath = `${hwmonBase}/${info.get_name()}`;
            const namePath = `${hwmonPath}/name`;
            const nameContents = GLib.file_get_contents(namePath);
            if (nameContents[0]) {
                const decoder = new TextDecoder();
                const name = decoder.decode(nameContents[1]).trim();
                if (['coretemp', 'k10temp', 'zenpower', 'it8728', 'nct6775', 'acpitz'].includes(name)) {
                    const tempPath = `${hwmonPath}/temp1_input`;
                    const tempContents = GLib.file_get_contents(tempPath);
                    if (tempContents[0]) {
                        const decoder2 = new TextDecoder();
                        const temp = parseInt(decoder2.decode(tempContents[1]).trim());
                        return Math.round(temp / 1000);
                    }
                }
            }
        }
    } catch (_e) {
        // Fall through to thermal_zone
    }

    for (let i = 0; i < 10; i++) {
        const path = `/sys/class/thermal/thermal_zone${i}/temp`;
        try {
            const contents = GLib.file_get_contents(path);
            if (contents[0]) {
                const decoder = new TextDecoder();
                const temp = parseInt(decoder.decode(contents[1]).trim());
                if (temp > 0) return Math.round(temp / 1000);
            }
        } catch (_e) {
            continue;
        }
    }

    return -1;
}

// --- GPU ---

function getGpuInfo(cachedNvidia) {
    // Try NVIDIA first (uses cached async result)
    if (cachedNvidia) return cachedNvidia;

    // Try Intel
    const intel = _getIntelGpu();
    if (intel) return intel;

    // Try AMD
    const amd = _getAmdGpu();
    if (amd) return amd;

    return null;
}

function _parseNvidiaOutput(out) {
    try {
        const decoder = new TextDecoder();
        const parts = decoder.decode(out).trim().split(',').map(s => s.trim());
        if (parts.length < 6) return null;
        return {
            name: parts[5],
            usage: parseInt(parts[0]),
            temp: parseInt(parts[1]),
            vramUsed: parseInt(parts[2]),
            vramTotal: parseInt(parts[3]),
            power: parseFloat(parts[4]),
        };
    } catch (_e) {
        return null;
    }
}

function _fetchNvidiaGpuAsync(callback) {
    try {
        const proc = Gio.Subprocess.new(
            ['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,name', '--format=csv,noheader,nounits'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        proc.communicate_utf8_async(null, null, (source, res) => {
            try {
                const [, stdout] = source.communicate_utf8_finish(res);
                if (stdout) {
                    const encoder = new TextEncoder();
                    callback(_parseNvidiaOutput(encoder.encode(stdout)));
                } else {
                    callback(null);
                }
            } catch (_e) {
                callback(null);
            }
        });
    } catch (_e) {
        callback(null);
    }
}

function _getIntelGpu() {
    // Frequency-based "usage" estimate for Intel iGPU
    const freqPaths = [
        '/sys/class/drm/card0/gt/gt0/rps_cur_freq_mhz',
        '/sys/class/drm/card0/gt_cur_freq_mhz',
    ];
    const maxPaths = [
        '/sys/class/drm/card0/gt/gt0/rps_max_freq_mhz',
        '/sys/class/drm/card0/gt_max_freq_mhz',
    ];

    let curFreq = -1, maxFreq = -1;
    for (const p of freqPaths) {
        const v = _readIntFile(p);
        if (v >= 0) { curFreq = v; break; }
    }
    for (const p of maxPaths) {
        const v = _readIntFile(p);
        if (v >= 0) { maxFreq = v; break; }
    }

    if (curFreq < 0 || maxFreq <= 0) return null;

    const usage = Math.round((curFreq / maxFreq) * 100);
    return {
        name: 'Intel iGPU',
        usage,
        temp: -1,
        vramUsed: -1,
        vramTotal: -1,
        power: -1,
        freqCur: curFreq,
        freqMax: maxFreq,
    };
}

function _getAmdGpu() {
    // AMD discrete GPU via hwmon
    const hwmonBase = '/sys/class/hwmon';
    try {
        const dir = Gio.File.new_for_path(hwmonBase);
        const enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const hwmonPath = `${hwmonBase}/${info.get_name()}`;
            const nameContents = GLib.file_get_contents(`${hwmonPath}/name`);
            if (!nameContents[0]) continue;
            const decoder = new TextDecoder();
            const name = decoder.decode(nameContents[1]).trim();
            if (name !== 'amdgpu') continue;

            const temp = _readIntFile(`${hwmonPath}/temp1_input`);
            const power = _readIntFile(`${hwmonPath}/power1_average`);

            // Try to get usage from /sys/class/drm
            let usage = -1;
            const busyPath = '/sys/class/drm/card0/device/gpu_busy_percent';
            const busyVal = _readIntFile(busyPath);
            if (busyVal >= 0) usage = busyVal;

            // VRAM
            const vramUsed = _readIntFile('/sys/class/drm/card0/device/mem_info_vram_used');
            const vramTotal = _readIntFile('/sys/class/drm/card0/device/mem_info_vram_total');

            return {
                name: 'AMD GPU',
                usage,
                temp: temp >= 0 ? Math.round(temp / 1000) : -1,
                vramUsed: vramUsed >= 0 ? Math.round(vramUsed / 1048576) : -1,
                vramTotal: vramTotal >= 0 ? Math.round(vramTotal / 1048576) : -1,
                power: power >= 0 ? (power / 1000000).toFixed(1) : -1,
            };
        }
    } catch (_e) {
        // no AMD GPU
    }
    return null;
}

// --- Energy (Intel RAPL + Battery) ---

function readRaplEnergy() {
    // Returns energy in microjoules, or -1 if unavailable
    return _readIntFile('/sys/class/powercap/intel-rapl:0/energy_uj');
}

function getRaplPower(prevEnergy, currEnergy, maxRange, intervalSec) {
    if (prevEnergy < 0 || currEnergy < 0 || intervalSec <= 0) return -1;
    let delta = currEnergy - prevEnergy;
    // Handle counter wraparound
    if (delta < 0) delta += maxRange;
    return delta / (intervalSec * 1000000); // watts
}

function getBatteryInfo() {
    const base = '/sys/class/power_supply/BAT0';
    const capacity = _readIntFile(`${base}/capacity`);
    if (capacity < 0) return null;

    const statusContents = GLib.file_get_contents(`${base}/status`);
    let status = 'Unknown';
    if (statusContents[0]) {
        const decoder = new TextDecoder();
        status = decoder.decode(statusContents[1]).trim();
    }

    // Try power_now (microwatts) first, then compute from voltage*current
    let powerW = -1;
    const powerNow = _readIntFile(`${base}/power_now`);
    if (powerNow > 0) {
        powerW = powerNow / 1000000;
    } else {
        const voltage = _readIntFile(`${base}/voltage_now`);
        const current = _readIntFile(`${base}/current_now`);
        if (voltage > 0 && current > 0)
            powerW = (voltage * current) / 1000000000000; // uV * uA -> W
    }

    return { capacity, status, power: powerW };
}

function _readIntFile(path) {
    try {
        const contents = GLib.file_get_contents(path);
        if (!contents[0]) return -1;
        const decoder = new TextDecoder();
        return parseInt(decoder.decode(contents[1]).trim());
    } catch (_e) {
        return -1;
    }
}

function formatTemp(temp) {
    return temp >= 0 ? `${temp}\u00b0C` : 'N/A';
}

function getTempColor(temp) {
    if (temp < 0) return '#888888';
    if (temp < 60) return '#8ff0a4';
    if (temp < 80) return '#f9f06b';
    return '#ff7b63';
}

function getUsageColor(percent) {
    if (percent < 50) return '#8ff0a4';
    if (percent < 80) return '#f9f06b';
    return '#ff7b63';
}

// --- Extension ---

export default class SystemMonitorExtension extends Extension {
    _indicator = null;
    _timerId = null;
    _prevCpuAll = null;
    _settings = null;

    enable() {
        this._settings = this.getSettings();
        this._prevCpuAll = readAllCpuTimes();
        this._prevDiskIO = readDiskIO();
        this._prevNetIO = readNetIO();
        this._prevRaplEnergy = readRaplEnergy();
        this._raplMaxRange = _readIntFile('/sys/class/powercap/intel-rapl:0/max_energy_range_uj');

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        // Top bar layout
        this._box = new St.BoxLayout({ style_class: 'panel-status-indicators-box' });
        this._indicator.add_child(this._box);

        this._cpuLabel = new St.Label({
            text: 'CPU: --%',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });
        this._ramLabel = new St.Label({
            text: 'RAM: --%',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });
        this._tempLabel = new St.Label({
            text: 'TEMP: --',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });
        this._diskLabel = new St.Label({
            text: 'DISK: --%',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });

        this._ioLabel = new St.Label({
            text: 'I/O: --',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });

        this._netLabel = new St.Label({
            text: 'NET: --',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });
        this._gpuLabel = new St.Label({
            text: 'GPU: --',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });
        this._powerLabel = new St.Label({
            text: 'PWR: --',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 4px;',
        });

        this._box.add_child(this._cpuLabel);
        this._box.add_child(this._ramLabel);
        this._box.add_child(this._tempLabel);
        this._box.add_child(this._diskLabel);
        this._box.add_child(this._ioLabel);
        this._box.add_child(this._netLabel);
        this._box.add_child(this._gpuLabel);
        this._box.add_child(this._powerLabel);

        // Wrap menu box in a scroll view
        this._wrapMenuInScrollView();

        // Popup menu content
        this._buildMenu();

        // Add to panel
        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator, 1, 'center');

        // Connect settings changes
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._updateVisibility();
            this._rebuildMenu();
        });

        this._updateVisibility();
        this._startTimer();
    }

    disable() {
        this._stopTimer();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        this._prevCpuAll = null;
        this._prevDiskIO = null;
        this._prevNetIO = null;
        this._prevRaplEnergy = null;
    }

    _updateVisibility() {
        this._cpuLabel.visible = this._settings.get_boolean('show-cpu');
        this._ramLabel.visible = this._settings.get_boolean('show-ram');
        this._tempLabel.visible = this._settings.get_boolean('show-temp');
        this._diskLabel.visible = this._settings.get_boolean('show-disk');
        this._ioLabel.visible = this._settings.get_boolean('show-disk-io');
        this._netLabel.visible = this._settings.get_boolean('show-net-io');
        this._gpuLabel.visible = this._settings.get_boolean('show-gpu');
        this._powerLabel.visible = this._settings.get_boolean('show-power');
    }

    _wrapMenuInScrollView() {
        const menu = this._indicator.menu;
        const menuBox = menu.box;
        const parent = menuBox.get_parent();

        parent.remove_child(menuBox);

        this._scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            enable_mouse_scrolling: true,
            x_expand: true,
            clip_to_allocation: true,
        });

        this._scrollView.set_child(menuBox);
        parent.add_child(this._scrollView);

        // Set max-height based on monitor when menu opens
        menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                const monitor = Main.layoutManager.primaryMonitor;
                const panelHeight = Main.panel.height;
                const maxHeight = monitor.height - panelHeight - 20;
                this._scrollView.style = `max-height: ${maxHeight}px;`;
            }
        });
    }

    _buildMenu() {
        const menu = this._indicator.menu;

        // Title
        const titleItem = new PopupMenu.PopupMenuItem('System Monitor', {
            reactive: false,
        });
        titleItem.label.style = 'font-weight: bold; font-size: 14px;';
        menu.addMenuItem(titleItem);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // CPU section
        this._menuCpuItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuCpuItem);

        // Per-core CPU items
        this._menuCpuCoreItems = [];
        if (this._settings.get_boolean('show-cpu-per-core')) {
            const coreCount = this._prevCpuAll ? this._prevCpuAll.length - 1 : 0;
            for (let i = 0; i < coreCount; i++) {
                const item = new PopupMenu.PopupMenuItem('', { reactive: false });
                item.label.style = 'font-size: 12px; padding-left: 16px;';
                menu.addMenuItem(item);
                this._menuCpuCoreItems.push(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // RAM section
        this._menuRamItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuRamItem);

        // RAM detail items
        this._menuRamDetailItems = [];
        if (this._settings.get_boolean('show-ram-details')) {
            for (let i = 0; i < 4; i++) {
                const item = new PopupMenu.PopupMenuItem('', { reactive: false });
                item.label.style = 'font-size: 12px; padding-left: 16px;';
                menu.addMenuItem(item);
                this._menuRamDetailItems.push(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Temp
        this._menuTempItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuTempItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Disk section
        this._menuDiskItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuDiskItem);

        // Partition detail items (built dynamically)
        this._menuDiskPartItems = [];
        if (this._settings.get_boolean('show-disk-partitions') && this._lastDisk) {
            for (let i = 0; i < this._lastDisk.partitions.length; i++) {
                const item = new PopupMenu.PopupMenuItem('', { reactive: false });
                item.label.style = 'font-size: 12px; font-family: monospace;';
                menu.addMenuItem(item);
                this._menuDiskPartItems.push(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Disk I/O section
        this._menuIOReadItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuIOReadItem);
        this._menuIOWriteItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuIOWriteItem);

        // Per-device I/O detail items
        this._menuIODeviceItems = [];
        if (this._settings.get_boolean('show-disk-io-details') && this._lastIO) {
            for (let i = 0; i < this._lastIO.devices.length; i++) {
                const item = new PopupMenu.PopupMenuItem('', { reactive: false });
                item.label.style = 'font-size: 12px; font-family: monospace;';
                menu.addMenuItem(item);
                this._menuIODeviceItems.push(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Network I/O section
        this._menuNetRxItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuNetRxItem);
        this._menuNetTxItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(this._menuNetTxItem);

        // Per-interface detail items
        this._menuNetIfaceItems = [];
        if (this._settings.get_boolean('show-net-io-details') && this._lastNet) {
            for (let i = 0; i < this._lastNet.interfaces.length; i++) {
                const item = new PopupMenu.PopupMenuItem('', { reactive: false });
                item.label.style = 'font-size: 12px; font-family: monospace;';
                menu.addMenuItem(item);
                this._menuNetIfaceItems.push(item);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // GPU section
        this._menuGpuItems = [];
        // GPU name
        const gpuNameItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(gpuNameItem);
        this._menuGpuItems.push(gpuNameItem);
        // GPU usage
        const gpuUsageItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(gpuUsageItem);
        this._menuGpuItems.push(gpuUsageItem);
        // GPU temp
        const gpuTempItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(gpuTempItem);
        this._menuGpuItems.push(gpuTempItem);
        // GPU VRAM
        const gpuVramItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(gpuVramItem);
        this._menuGpuItems.push(gpuVramItem);
        // GPU power
        const gpuPowerItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(gpuPowerItem);
        this._menuGpuItems.push(gpuPowerItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Power / Energy section
        this._menuPowerItems = [];
        const raplItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(raplItem);
        this._menuPowerItems.push(raplItem);
        const battItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(battItem);
        this._menuPowerItems.push(battItem);
        const battPowerItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        menu.addMenuItem(battPowerItem);
        this._menuPowerItems.push(battPowerItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Settings button
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this.openPreferences();
        });
        menu.addMenuItem(settingsItem);
    }

    _rebuildMenu() {
        this._indicator.menu.removeAll();
        this._buildMenu();
        this._updateMenuItems();
    }

    _startTimer() {
        const interval = this._settings.get_int('update-interval');
        this._update();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _update() {
        // CPU (all cores)
        const currCpuAll = readAllCpuTimes();
        this._lastCpuPerCore = [];
        if (this._prevCpuAll && currCpuAll) {
            this._lastCpuOverall = getCpuUsage(this._prevCpuAll[0], currCpuAll[0]);
            for (let i = 1; i < currCpuAll.length; i++) {
                const prev = this._prevCpuAll[i];
                const curr = currCpuAll[i];
                this._lastCpuPerCore.push(prev ? getCpuUsage(prev, curr) : 0);
            }
        } else {
            this._lastCpuOverall = 0;
        }
        this._prevCpuAll = currCpuAll;

        // RAM
        this._lastMem = getMemoryInfo();

        // Temperature
        this._lastTemp = getCpuTemp();

        // Disk
        this._lastDisk = getDiskInfo();

        // Disk I/O
        const currDiskIO = readDiskIO();
        const interval = this._settings.get_int('update-interval');
        this._lastIO = getDiskIORate(this._prevDiskIO, currDiskIO, interval);
        this._prevDiskIO = currDiskIO;

        // Update top bar labels
        const cpu = this._lastCpuOverall;
        const mem = this._lastMem;
        const temp = this._lastTemp;
        const disk = this._lastDisk;
        const io = this._lastIO;

        this._cpuLabel.text = `CPU: ${cpu}%`;
        this._cpuLabel.style = `font-size: 11px; padding: 0 4px; color: ${getUsageColor(cpu)};`;

        this._ramLabel.text = `RAM: ${mem.percent}%`;
        this._ramLabel.style = `font-size: 11px; padding: 0 4px; color: ${getUsageColor(mem.percent)};`;

        this._tempLabel.text = `${formatTemp(temp)}`;
        this._tempLabel.style = `font-size: 11px; padding: 0 4px; color: ${getTempColor(temp)};`;

        this._diskLabel.text = `DISK: ${disk.percent}%`;
        this._diskLabel.style = `font-size: 11px; padding: 0 4px; color: ${getUsageColor(disk.percent)};`;

        this._ioLabel.text = `R: ${formatBytesShort(io.totalRead)}/s W: ${formatBytesShort(io.totalWrite)}/s`;
        this._ioLabel.style = 'font-size: 11px; padding: 0 4px; color: #99c1f1;';

        // Network I/O
        const currNetIO = readNetIO();
        this._lastNet = getNetIORate(this._prevNetIO, currNetIO, interval);
        this._prevNetIO = currNetIO;
        const net = this._lastNet;

        this._netLabel.text = `\u2193 ${formatBytesShort(net.totalRx)}/s \u2191 ${formatBytesShort(net.totalTx)}/s`;
        this._netLabel.style = 'font-size: 11px; padding: 0 4px; color: #cdab8f;';

        // GPU (NVIDIA is fetched async, uses cached result)
        _fetchNvidiaGpuAsync((nvidiaResult) => {
            this._cachedNvidia = nvidiaResult;
        });
        this._lastGpu = getGpuInfo(this._cachedNvidia);
        const gpu = this._lastGpu;
        if (gpu && gpu.usage >= 0) {
            this._gpuLabel.text = `GPU: ${gpu.usage}%`;
            this._gpuLabel.style = `font-size: 11px; padding: 0 4px; color: ${getUsageColor(gpu.usage)};`;
        } else if (gpu && gpu.freqCur >= 0) {
            this._gpuLabel.text = `GPU: ${gpu.freqCur} MHz`;
            this._gpuLabel.style = 'font-size: 11px; padding: 0 4px; color: #c061cb;';
        } else {
            this._gpuLabel.text = 'GPU: N/A';
            this._gpuLabel.style = 'font-size: 11px; padding: 0 4px; color: #888888;';
        }

        // Power (RAPL + Battery)
        const currRapl = readRaplEnergy();
        this._lastRaplPower = getRaplPower(
            this._prevRaplEnergy, currRapl, this._raplMaxRange, interval
        );
        this._prevRaplEnergy = currRapl;
        this._lastBattery = getBatteryInfo();

        const raplW = this._lastRaplPower;
        const batt = this._lastBattery;
        if (raplW >= 0) {
            this._powerLabel.text = `${raplW.toFixed(1)} W`;
            const pwrColor = raplW < 15 ? '#8ff0a4' : raplW < 35 ? '#f9f06b' : '#ff7b63';
            this._powerLabel.style = `font-size: 11px; padding: 0 4px; color: ${pwrColor};`;
        } else if (batt && batt.power > 0) {
            this._powerLabel.text = `${batt.power.toFixed(1)} W`;
            this._powerLabel.style = 'font-size: 11px; padding: 0 4px; color: #f9f06b;';
        } else if (batt) {
            this._powerLabel.text = `BAT: ${batt.capacity}%`;
            this._powerLabel.style = `font-size: 11px; padding: 0 4px; color: ${getUsageColor(100 - batt.capacity)};`;
        } else {
            this._powerLabel.text = 'PWR: N/A';
            this._powerLabel.style = 'font-size: 11px; padding: 0 4px; color: #888888;';
        }

        // Rebuild menu if partition/device/interface count changed
        const needRebuild =
            (this._settings.get_boolean('show-disk-partitions') &&
                this._menuDiskPartItems.length !== disk.partitions.length) ||
            (this._settings.get_boolean('show-disk-io-details') &&
                this._menuIODeviceItems.length !== io.devices.length) ||
            (this._settings.get_boolean('show-net-io-details') &&
                this._menuNetIfaceItems.length !== net.interfaces.length);
        if (needRebuild) {
            this._rebuildMenu();
            return;
        }

        this._updateMenuItems();
    }

    _updateMenuItems() {
        if (!this._menuCpuItem) return;

        const cpu = this._lastCpuOverall ?? 0;
        const cores = this._lastCpuPerCore ?? [];
        const mem = this._lastMem ?? { percent: 0, used: '0', total: '0', free: '0', cached: '0', swapUsed: '0', swapTotal: '0', swapPercent: 0 };
        const temp = this._lastTemp ?? -1;

        // CPU overall
        this._menuCpuItem.label.text = `CPU Usage:  ${cpu}%`;
        this._menuCpuItem.label.style = `color: ${getUsageColor(cpu)};`;

        // Per-core
        for (let i = 0; i < this._menuCpuCoreItems.length; i++) {
            const coreUsage = cores[i] ?? 0;
            const bar = this._makeBar(coreUsage);
            this._menuCpuCoreItems[i].label.text = `  Core ${String(i).padStart(2, ' ')}:  ${bar}  ${String(coreUsage).padStart(3, ' ')}%`;
            this._menuCpuCoreItems[i].label.style = `font-size: 12px; font-family: monospace; color: ${getUsageColor(coreUsage)};`;
        }

        // RAM overall
        this._menuRamItem.label.text = `RAM Usage:  ${mem.percent}%  (${mem.used} / ${mem.total} GB)`;
        this._menuRamItem.label.style = `color: ${getUsageColor(mem.percent)};`;

        // RAM details
        if (this._menuRamDetailItems.length >= 4) {
            this._menuRamDetailItems[0].label.text = `  Used:     ${mem.used} GB`;
            this._menuRamDetailItems[0].label.style = 'font-size: 12px; font-family: monospace; color: #ff7b63;';
            this._menuRamDetailItems[1].label.text = `  Free:     ${mem.free} GB`;
            this._menuRamDetailItems[1].label.style = 'font-size: 12px; font-family: monospace; color: #8ff0a4;';
            this._menuRamDetailItems[2].label.text = `  Cache:    ${mem.cached} GB`;
            this._menuRamDetailItems[2].label.style = 'font-size: 12px; font-family: monospace; color: #99c1f1;';
            this._menuRamDetailItems[3].label.text = `  Swap:     ${mem.swapUsed} / ${mem.swapTotal} GB  (${mem.swapPercent}%)`;
            this._menuRamDetailItems[3].label.style = `font-size: 12px; font-family: monospace; color: ${getUsageColor(mem.swapPercent)};`;
        }

        // Temp
        this._menuTempItem.label.text = `CPU Temp:   ${formatTemp(temp)}`;
        this._menuTempItem.label.style = `color: ${getTempColor(temp)};`;

        // Disk overall
        const disk = this._lastDisk ?? { percent: 0, partitions: [] };
        this._menuDiskItem.label.text = `Disk Usage: ${disk.percent}%`;
        this._menuDiskItem.label.style = `color: ${getUsageColor(disk.percent)};`;

        // Partition details
        for (let i = 0; i < this._menuDiskPartItems.length; i++) {
            const p = disk.partitions[i];
            if (!p) continue;
            const bar = this._makeBar(p.percent);
            this._menuDiskPartItems[i].label.text = `  ${p.mountpoint.padEnd(15)} ${bar}  ${String(p.percent).padStart(3, ' ')}%  (${p.used} / ${p.total} GB)`;
            this._menuDiskPartItems[i].label.style = `font-size: 12px; font-family: monospace; color: ${getUsageColor(p.percent)};`;
        }

        // Disk I/O
        const io = this._lastIO ?? { totalRead: 0, totalWrite: 0, devices: [] };
        this._menuIOReadItem.label.text = `Disk Read:  ${formatBytes(io.totalRead)}`;
        this._menuIOReadItem.label.style = 'color: #99c1f1;';
        this._menuIOWriteItem.label.text = `Disk Write: ${formatBytes(io.totalWrite)}`;
        this._menuIOWriteItem.label.style = 'color: #f9f06b;';

        // Per-device I/O
        for (let i = 0; i < this._menuIODeviceItems.length; i++) {
            const d = io.devices[i];
            if (!d) continue;
            this._menuIODeviceItems[i].label.text = `  ${d.name.padEnd(10)} R: ${formatBytes(d.read).padStart(12)}  W: ${formatBytes(d.write).padStart(12)}`;
            this._menuIODeviceItems[i].label.style = 'font-size: 12px; font-family: monospace; color: #c0bfbc;';
        }

        // Network I/O
        const net = this._lastNet ?? { totalRx: 0, totalTx: 0, interfaces: [] };
        this._menuNetRxItem.label.text = `Net Down:   ${formatBytes(net.totalRx)}`;
        this._menuNetRxItem.label.style = 'color: #8ff0a4;';
        this._menuNetTxItem.label.text = `Net Up:     ${formatBytes(net.totalTx)}`;
        this._menuNetTxItem.label.style = 'color: #cdab8f;';

        // Per-interface
        for (let i = 0; i < this._menuNetIfaceItems.length; i++) {
            const iface = net.interfaces[i];
            if (!iface) continue;
            this._menuNetIfaceItems[i].label.text = `  ${iface.name.padEnd(16)} \u2193 ${formatBytes(iface.rx).padStart(12)}  \u2191 ${formatBytes(iface.tx).padStart(12)}`;
            this._menuNetIfaceItems[i].label.style = 'font-size: 12px; font-family: monospace; color: #c0bfbc;';
        }

        // GPU
        const gpu = this._lastGpu;
        if (gpu) {
            this._menuGpuItems[0].label.text = `GPU:        ${gpu.name}`;
            this._menuGpuItems[0].label.style = 'color: #c061cb;';
            this._menuGpuItems[0].visible = true;

            if (gpu.usage >= 0) {
                this._menuGpuItems[1].label.text = `  Usage:    ${gpu.usage}%`;
                this._menuGpuItems[1].label.style = `font-size: 12px; font-family: monospace; color: ${getUsageColor(gpu.usage)};`;
                this._menuGpuItems[1].visible = true;
            } else if (gpu.freqCur >= 0) {
                this._menuGpuItems[1].label.text = `  Freq:     ${gpu.freqCur} / ${gpu.freqMax} MHz`;
                this._menuGpuItems[1].label.style = 'font-size: 12px; font-family: monospace; color: #c061cb;';
                this._menuGpuItems[1].visible = true;
            } else {
                this._menuGpuItems[1].visible = false;
            }

            if (gpu.temp >= 0) {
                this._menuGpuItems[2].label.text = `  Temp:     ${formatTemp(gpu.temp)}`;
                this._menuGpuItems[2].label.style = `font-size: 12px; font-family: monospace; color: ${getTempColor(gpu.temp)};`;
                this._menuGpuItems[2].visible = true;
            } else {
                this._menuGpuItems[2].visible = false;
            }

            if (gpu.vramUsed >= 0 && gpu.vramTotal > 0) {
                const vramPct = Math.round((gpu.vramUsed / gpu.vramTotal) * 100);
                this._menuGpuItems[3].label.text = `  VRAM:     ${gpu.vramUsed} / ${gpu.vramTotal} MB  (${vramPct}%)`;
                this._menuGpuItems[3].label.style = `font-size: 12px; font-family: monospace; color: ${getUsageColor(vramPct)};`;
                this._menuGpuItems[3].visible = true;
            } else {
                this._menuGpuItems[3].visible = false;
            }

            if (gpu.power >= 0) {
                this._menuGpuItems[4].label.text = `  Power:    ${Number(gpu.power).toFixed(1)} W`;
                this._menuGpuItems[4].label.style = 'font-size: 12px; font-family: monospace; color: #f9f06b;';
                this._menuGpuItems[4].visible = true;
            } else {
                this._menuGpuItems[4].visible = false;
            }
        } else {
            this._menuGpuItems[0].label.text = 'GPU:        N/A';
            this._menuGpuItems[0].label.style = 'color: #888888;';
            for (let i = 1; i < this._menuGpuItems.length; i++)
                this._menuGpuItems[i].visible = false;
        }

        // Power / Energy
        const raplW = this._lastRaplPower ?? -1;
        const batt = this._lastBattery;

        if (raplW >= 0) {
            const pwrColor = raplW < 15 ? '#8ff0a4' : raplW < 35 ? '#f9f06b' : '#ff7b63';
            this._menuPowerItems[0].label.text = `CPU Power:  ${raplW.toFixed(1)} W`;
            this._menuPowerItems[0].label.style = `color: ${pwrColor};`;
            this._menuPowerItems[0].visible = true;
        } else {
            this._menuPowerItems[0].label.text = 'CPU Power:  N/A (needs root)';
            this._menuPowerItems[0].label.style = 'color: #888888;';
            this._menuPowerItems[0].visible = true;
        }

        if (batt) {
            const battColor = getUsageColor(100 - batt.capacity);
            this._menuPowerItems[1].label.text = `Battery:    ${batt.capacity}%  (${batt.status})`;
            this._menuPowerItems[1].label.style = `color: ${battColor};`;
            this._menuPowerItems[1].visible = true;

            if (batt.power > 0) {
                this._menuPowerItems[2].label.text = `  Draw:     ${batt.power.toFixed(1)} W`;
                this._menuPowerItems[2].label.style = 'font-size: 12px; font-family: monospace; color: #f9f06b;';
                this._menuPowerItems[2].visible = true;
            } else {
                this._menuPowerItems[2].visible = false;
            }
        } else {
            this._menuPowerItems[1].label.text = 'Battery:    N/A';
            this._menuPowerItems[1].label.style = 'color: #888888;';
            this._menuPowerItems[1].visible = true;
            this._menuPowerItems[2].visible = false;
        }
    }

    _makeBar(percent) {
        const filled = Math.round(percent / 10);
        return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
    }
}
