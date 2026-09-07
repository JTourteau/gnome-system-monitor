import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseCpuTimes, getCpuUsage,
    parseMeminfo,
    parseDiskIO, getDiskIORate,
    parseNetIO, getNetIORate,
    formatBytes, formatBytesShort,
    parseNvidiaOutput, getRaplPower,
    formatTemp, getTempColor, getUsageColor,
} from '../lib/metrics.js';

// --- CPU ---

test('parseCpuTimes: null input yields null', () => {
    assert.equal(parseCpuTimes(null), null);
});

test('parseCpuTimes: overall + per-core, idle = idle + iowait', () => {
    const stat = [
        'cpu  100 0 100 700 100 0 0 0 0 0',
        'cpu0 50 0 50 350 50 0 0 0 0 0',
        'intr 12345 0 0',
    ].join('\n');
    const r = parseCpuTimes(stat);
    assert.equal(r.length, 2); // stops at the non-cpu line
    assert.deepEqual(r[0], { idle: 800, total: 1000 }); // 700 idle + 100 iowait
    assert.deepEqual(r[1], { idle: 400, total: 500 });
});

test('getCpuUsage: nulls -> 0, zero delta -> 0, normal case', () => {
    assert.equal(getCpuUsage(null, { idle: 1, total: 1 }), 0);
    assert.equal(getCpuUsage({ idle: 5, total: 10 }, { idle: 5, total: 10 }), 0);
    assert.equal(
        getCpuUsage({ idle: 100, total: 1000 }, { idle: 150, total: 1200 }),
        75); // (200 - 50) / 200
});

// --- Memory ---

test('parseMeminfo: null -> default zeros', () => {
    assert.deepEqual(parseMeminfo(null), { percent: 0, used: 0, total: 0 });
});

test('parseMeminfo: computes percent, GB strings and swap', () => {
    const meminfo = [
        'MemTotal:       16384000 kB',
        'MemFree:         1000000 kB',
        'MemAvailable:    8192000 kB',
        'Buffers:          500000 kB',
        'Cached:          2000000 kB',
        'SwapTotal:       2048000 kB',
        'SwapFree:        1024000 kB',
    ].join('\n');
    const m = parseMeminfo(meminfo);
    assert.equal(m.percent, 50);
    assert.equal(m.total, '15.6');
    assert.equal(m.used, '7.8');
    assert.equal(m.swapPercent, 50);
});

test('parseMeminfo: no swap -> swapPercent 0 (no divide by zero)', () => {
    const m = parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 500 kB\n');
    assert.equal(m.swapPercent, 0);
});

// --- Disk I/O ---

test('parseDiskIO: keeps whole disks, drops partitions/dm/loop/sr', () => {
    const rows = [
        '   8  0 sda      10 0 2000 0 0 0 4000 0 0 0 0 0 0',
        '   8  1 sda1     10 0 2000 0 0 0 4000 0 0 0 0 0 0',
        ' 259  0 nvme0n1  10 0 1000 0 0 0 3000 0 0 0 0 0 0',
        ' 259  1 nvme0n1p1 10 0 1 0 0 0 1 0 0 0 0 0 0',
        ' 253  0 dm-0     10 0 1 0 0 0 1 0 0 0 0 0 0',
        '   7  0 loop0    10 0 1 0 0 0 1 0 0 0 0 0 0',
    ].join('\n');
    const d = parseDiskIO(rows);
    assert.deepEqual(Object.keys(d).sort(), ['nvme0n1', 'sda']);
    assert.deepEqual(d.sda, { read: 2000 * 512, written: 4000 * 512 });
    assert.deepEqual(d.nvme0n1, { read: 1000 * 512, written: 3000 * 512 });
});

test('parseDiskIO: null -> {}', () => {
    assert.deepEqual(parseDiskIO(null), {});
});

test('getDiskIORate: rate per second, skips devices absent from prev', () => {
    const prev = { sda: { read: 0, written: 0 } };
    const curr = { sda: { read: 1024000, written: 2048000 }, sdb: { read: 9, written: 9 } };
    const r = getDiskIORate(prev, curr, 2);
    assert.equal(r.totalRead, 512000);
    assert.equal(r.totalWrite, 1024000);
    assert.equal(r.devices.length, 1); // sdb not in prev
    assert.equal(r.devices[0].name, 'sda');
});

test('getDiskIORate: nulls -> zeroed result', () => {
    assert.deepEqual(getDiskIORate(null, null, 1),
        { totalRead: 0, totalWrite: 0, devices: [] });
});

// --- Network I/O ---

test('parseNetIO: skips 2 header lines, lo and veth', () => {
    const netdev = [
        'Inter-|   Receive                    |  Transmit',
        ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets',
        '  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
        '    lo: 500 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0',
        ' veth9: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0',
    ].join('\n');
    const n = parseNetIO(netdev);
    assert.deepEqual(Object.keys(n), ['eth0']);
    assert.deepEqual(n.eth0, { rx: 1000, tx: 2000 });
});

test('getNetIORate: rate per second', () => {
    const prev = { eth0: { rx: 0, tx: 0 } };
    const curr = { eth0: { rx: 2000, tx: 4000 } };
    const r = getNetIORate(prev, curr, 2);
    assert.equal(r.totalRx, 1000);
    assert.equal(r.totalTx, 2000);
    assert.equal(r.interfaces[0].name, 'eth0');
});

// --- Formatting ---

test('formatBytes: unit boundaries', () => {
    assert.equal(formatBytes(512), '512 B/s');
    assert.equal(formatBytes(2048), '2.0 KB/s');
    assert.equal(formatBytes(1572864), '1.5 MB/s');
    assert.equal(formatBytes(1610612736), '1.5 GB/s');
});

test('formatBytesShort: compact units', () => {
    assert.equal(formatBytesShort(512), '512 B');
    assert.equal(formatBytesShort(2048), '2 K');
    assert.equal(formatBytesShort(1572864), '1.5 M');
    assert.equal(formatBytesShort(1610612736), '1.5 G');
});

// --- GPU ---

test('parseNvidiaOutput: valid CSV bytes -> parsed object', () => {
    const csv = '45, 60, 2048, 8192, 120.5, NVIDIA GeForce RTX 4090';
    const out = parseNvidiaOutput(new TextEncoder().encode(csv));
    assert.deepEqual(out, {
        name: 'NVIDIA GeForce RTX 4090',
        usage: 45, temp: 60, vramUsed: 2048, vramTotal: 8192, power: 120.5,
    });
});

test('parseNvidiaOutput: fewer than 6 fields -> null', () => {
    assert.equal(parseNvidiaOutput(new TextEncoder().encode('45, 60')), null);
});

// --- Power ---

test('getRaplPower: invalid inputs -> -1', () => {
    assert.equal(getRaplPower(-1, 100, 1000, 1), -1);
    assert.equal(getRaplPower(100, -1, 1000, 1), -1);
    assert.equal(getRaplPower(100, 200, 1000, 0), -1);
});

test('getRaplPower: watts from microjoule delta', () => {
    assert.equal(getRaplPower(1000000, 3000000, 10000000, 1), 2);
});

test('getRaplPower: counter wraparound', () => {
    assert.equal(getRaplPower(9000000, 1000000, 10000000, 1), 2);
});

// --- Temperature / colors ---

test('formatTemp: N/A when negative', () => {
    assert.equal(formatTemp(-1), 'N/A');
    assert.equal(formatTemp(50), '50°C');
});

test('getTempColor: thresholds', () => {
    assert.equal(getTempColor(-1), '#888888');
    assert.equal(getTempColor(30), '#8ff0a4');
    assert.equal(getTempColor(70), '#f9f06b');
    assert.equal(getTempColor(90), '#ff7b63');
});

test('getUsageColor: thresholds', () => {
    assert.equal(getUsageColor(20), '#8ff0a4');
    assert.equal(getUsageColor(60), '#f9f06b');
    assert.equal(getUsageColor(90), '#ff7b63');
});
