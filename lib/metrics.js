// Pure metrics logic: parsing of /proc and sysfs text, rate computations, and
// formatting. Intentionally free of any gi:// import so it can be unit-tested
// with plain node. extension.js keeps the Gio-based file IO and delegates the
// parsing/formatting here.

// --- CPU ---

/**
 * Parse the contents of /proc/stat into cumulative idle/total jiffies.
 *
 * @param {string|null} text - contents of /proc/stat
 * @returns {Array<{idle:number,total:number}>|null} index 0 = overall, 1..N = per-core
 */
export function parseCpuTimes(text) {
    if (!text) return null;

    const lines = text.split('\n');
    const results = [];

    for (const line of lines) {
        if (!line.startsWith('cpu')) break;
        const parts = line.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + b, 0);
        results.push({ idle, total });
    }

    return results;
}

/**
 * CPU usage percent between two /proc/stat snapshots of one CPU line.
 *
 * @param {{idle:number,total:number}|null} prev
 * @param {{idle:number,total:number}|null} curr
 * @returns {number} 0-100
 */
export function getCpuUsage(prev, curr) {
    if (!prev || !curr) return 0;
    const totalDiff = curr.total - prev.total;
    const idleDiff = curr.idle - prev.idle;
    if (totalDiff === 0) return 0;
    return Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
}

// --- Memory ---

/**
 * Parse /proc/meminfo into a memory summary (GB strings + percentages).
 *
 * @param {string|null} text
 * @returns {object}
 */
export function parseMeminfo(text) {
    if (!text) return { percent: 0, used: 0, total: 0 };

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

// --- Disk I/O ---

/**
 * Parse /proc/diskstats into per whole-disk cumulative byte counters.
 *
 * @param {string|null} text
 * @returns {Object<string,{read:number,written:number}>}
 */
export function parseDiskIO(text) {
    if (!text) return {};

    const lines = text.split('\n');
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

/**
 * Disk I/O rate (bytes/s) between two parseDiskIO snapshots.
 *
 * @param {object|null} prev
 * @param {object|null} curr
 * @param {number} intervalSec
 * @returns {{totalRead:number,totalWrite:number,devices:Array}}
 */
export function getDiskIORate(prev, curr, intervalSec) {
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

// --- Network I/O ---

/**
 * Parse /proc/net/dev into per-interface cumulative rx/tx byte counters.
 *
 * @param {string|null} text
 * @returns {Object<string,{rx:number,tx:number}>}
 */
export function parseNetIO(text) {
    if (!text) return {};

    const lines = text.split('\n').slice(2); // skip headers
    const interfaces = {};

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 10) continue;
        const name = parts[0].replace(':', '');
        // Skip loopback, veth (docker)
        if (name === 'lo' || name.startsWith('veth')) continue;
        const rx = parseInt(parts[1]);
        const tx = parseInt(parts[9]);
        interfaces[name] = { rx, tx };
    }

    return interfaces;
}

/**
 * Network I/O rate (bytes/s) between two parseNetIO snapshots.
 *
 * @param {object|null} prev
 * @param {object|null} curr
 * @param {number} intervalSec
 * @returns {{totalRx:number,totalTx:number,interfaces:Array}}
 */
export function getNetIORate(prev, curr, intervalSec) {
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

// --- Formatting ---

/** Format a bytes/second rate with a per-second unit suffix. */
export function formatBytes(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B/s`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB/s`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB/s`;
    return `${(bytes / 1073741824).toFixed(1)} GB/s`;
}

/** Format a byte count with a compact single-letter unit. */
export function formatBytesShort(bytes) {
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} K`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} M`;
    return `${(bytes / 1073741824).toFixed(1)} G`;
}

// --- GPU (NVIDIA) ---

/**
 * Parse the CSV output of nvidia-smi --query-gpu (utf-8 encoded bytes).
 *
 * @param {Uint8Array} out - encoded nvidia-smi stdout
 * @returns {object|null}
 */
export function parseNvidiaOutput(out) {
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

// --- Power (Intel RAPL) ---

/**
 * Average power (watts) between two RAPL energy counters, handling the
 * counter wraparound at maxRange.
 *
 * @param {number} prevEnergy - microjoules (-1 if unavailable)
 * @param {number} currEnergy - microjoules (-1 if unavailable)
 * @param {number} maxRange - counter wrap range in microjoules
 * @param {number} intervalSec
 * @returns {number} watts, or -1 if inputs are invalid
 */
export function getRaplPower(prevEnergy, currEnergy, maxRange, intervalSec) {
    if (prevEnergy < 0 || currEnergy < 0 || intervalSec <= 0) return -1;
    let delta = currEnergy - prevEnergy;
    if (delta < 0) delta += maxRange; // counter wraparound
    return delta / (intervalSec * 1000000); // watts
}

// --- Temperature / colors ---

/** Format a temperature in °C, or "N/A" when negative (unavailable). */
export function formatTemp(temp) {
    return temp >= 0 ? `${temp}°C` : 'N/A';
}

/** Threshold color for a temperature (grey when unavailable). */
export function getTempColor(temp) {
    if (temp < 0) return '#888888';
    if (temp < 60) return '#8ff0a4';
    if (temp < 80) return '#f9f06b';
    return '#ff7b63';
}

/** Threshold color for a 0-100 usage percentage. */
export function getUsageColor(percent) {
    if (percent < 50) return '#8ff0a4';
    if (percent < 80) return '#f9f06b';
    return '#ff7b63';
}
