# System Monitor - GNOME Shell Extension

Real-time system resource monitoring directly in your GNOME Shell top bar.

![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-45--48-blue?logo=gnome&logoColor=white)
![License](https://img.shields.io/badge/license-GPL--3.0-green)

## Features

### Top bar indicators (all toggleable)

- **CPU Usage** - Overall percentage, color-coded by load
- **RAM Usage** - Memory percentage
- **CPU Temperature** - Real-time reading with thermal color coding
- **Disk Usage** - Overall disk space percentage
- **Disk I/O** - Read/write throughput
- **Network I/O** - Download/upload throughput
- **GPU** - Usage percentage (NVIDIA/AMD) or frequency (Intel)
- **Power / Energy** - CPU wattage (Intel RAPL), battery level and draw

### Dropdown details (optional, per section)

- **CPU per core** - Usage breakdown for each core with visual bars
- **RAM details** - Used, free, cache/buffers, swap
- **Disk per partition** - Usage per mount point with visual bars
- **Disk I/O per device** - Read/write per physical disk
- **Network per interface** - Download/upload per network interface
- **GPU details** - Name, usage/frequency, temperature, VRAM, power draw
- **Power details** - CPU package power, battery status and draw

### Color indicators

- **Usage**: green (<50%), yellow (50-80%), red (>80%)
- **Temperature**: green (<60C), yellow (60-80C), red (>80C)
- **Power**: green (<15W), yellow (15-35W), red (>35W)

Click the top bar indicator to open a scrollable dropdown with all details and a link to the settings panel.

## Installation

### From source

```bash
git clone https://github.com/YOUR_USERNAME/system-monitor.git
cd system-monitor
make install
```

Then restart GNOME Shell (`Alt+F2` > `r` > `Enter` on X11, or log out/in on Wayland) and enable the extension:

```bash
gnome-extensions enable system-monitor@jtourteau
```

### Manual install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/system-monitor@jtourteau
cp -r extension.js prefs.js metadata.json schemas/ ~/.local/share/gnome-shell/extensions/system-monitor@jtourteau/
```

Restart GNOME Shell and enable the extension.

## Configuration

Open the preferences via the dropdown menu (click the indicator > **Settings**), or run:

```bash
gnome-extensions prefs system-monitor@jtourteau
```

### Top bar visibility

| Setting | Description | Default |
|---------|-------------|---------|
| CPU Usage | Display CPU usage | On |
| RAM Usage | Display RAM usage | On |
| CPU Temperature | Display CPU temperature | On |
| Disk Usage | Display overall disk usage | On |
| Disk I/O | Display disk read/write throughput | On |
| Network I/O | Display network download/upload throughput | On |
| GPU | Display GPU usage or frequency | On |
| Power / Energy | Display CPU power draw or battery level | On |

### Dropdown details

| Setting | Description | Default |
|---------|-------------|---------|
| CPU per core | Show per-core usage with visual bars | Off |
| RAM details | Show free, used, cache and swap | Off |
| Disk per partition | Show usage per mount point | Off |
| Disk I/O per device | Show read/write per physical disk | Off |
| Network per interface | Show download/upload per interface | Off |

### General

| Setting | Description | Default |
|---------|-------------|---------|
| Update interval | Refresh rate in seconds (1-30) | 2s |

## GPU support

| Backend | Detection | Usage | Temp | VRAM | Power |
|---------|-----------|-------|------|------|-------|
| NVIDIA | `nvidia-smi` | % | yes | yes | yes |
| AMD | `amdgpu` hwmon | % | yes | yes | yes |
| Intel iGPU | `/sys/class/drm` | freq | no | no | no |

The extension auto-detects the available GPU in order: NVIDIA > Intel > AMD.

## Power / Energy

- **Intel RAPL** - Reads CPU package power from `/sys/class/powercap/intel-rapl:0/energy_uj`. This file is root-only by default. To make it readable without root:
  ```bash
  # Temporary (until reboot)
  sudo chmod 444 /sys/class/powercap/intel-rapl:0/energy_uj

  # Persistent (udev rule)
  echo 'SUBSYSTEM=="powercap", ATTR{name}=="package-0", RUN+="/bin/chmod 444 %S%p/energy_uj"' | \
    sudo tee /etc/udev/rules.d/99-rapl.rules
  ```
- **Battery** - Reads capacity and status from `/sys/class/power_supply/BAT0/`. Power draw is read from `power_now` or computed from `voltage_now * current_now`.

## Data sources

| Metric | Source |
|--------|--------|
| CPU usage | `/proc/stat` |
| Memory | `/proc/meminfo` |
| CPU temperature | `/sys/class/hwmon/*/temp1_input` with fallback to `/sys/class/thermal/thermal_zone*/temp` |
| Disk usage | `/proc/mounts` + `Gio.File.query_filesystem_info()` |
| Disk I/O | `/proc/diskstats` |
| Network I/O | `/proc/net/dev` |
| GPU (NVIDIA) | `nvidia-smi` CLI |
| GPU (AMD) | `/sys/class/hwmon/*/` (amdgpu) + `/sys/class/drm/card0/device/` |
| GPU (Intel) | `/sys/class/drm/card0/gt/gt0/rps_*_freq_mhz` |
| CPU power | `/sys/class/powercap/intel-rapl:0/energy_uj` |
| Battery | `/sys/class/power_supply/BAT0/` |

## Requirements

- GNOME Shell 45, 46, 47, or 48
- Linux kernel (uses `/proc` and `/sys` virtual filesystems)
- Optional: `nvidia-smi` for NVIDIA GPU monitoring

## Building the zip (for distribution)

```bash
make zip
```

This produces `system-monitor@jtourteau.zip` ready for upload to [extensions.gnome.org](https://extensions.gnome.org/).

## License

This extension is distributed under the terms of the [GNU General Public License v3.0](LICENSE).
