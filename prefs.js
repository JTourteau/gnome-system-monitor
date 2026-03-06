import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SystemMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // Visibility group
        const visGroup = new Adw.PreferencesGroup({
            title: 'Visible Resources',
            description: 'Choose which resources to display in the top bar',
        });
        page.add(visGroup);

        // CPU toggle
        const cpuRow = new Adw.SwitchRow({
            title: 'CPU Usage',
            subtitle: 'Show CPU usage percentage',
        });
        settings.bind('show-cpu', cpuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(cpuRow);

        // RAM toggle
        const ramRow = new Adw.SwitchRow({
            title: 'RAM Usage',
            subtitle: 'Show RAM usage percentage',
        });
        settings.bind('show-ram', ramRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(ramRow);

        // Temp toggle
        const tempRow = new Adw.SwitchRow({
            title: 'CPU Temperature',
            subtitle: 'Show CPU temperature',
        });
        settings.bind('show-temp', tempRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(tempRow);

        // Disk toggle
        const diskRow = new Adw.SwitchRow({
            title: 'Disk Usage',
            subtitle: 'Show overall disk usage percentage',
        });
        settings.bind('show-disk', diskRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(diskRow);

        // Disk I/O toggle
        const ioRow = new Adw.SwitchRow({
            title: 'Disk I/O',
            subtitle: 'Show disk read/write throughput',
        });
        settings.bind('show-disk-io', ioRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(ioRow);

        // Network I/O toggle
        const netRow = new Adw.SwitchRow({
            title: 'Network I/O',
            subtitle: 'Show network download/upload throughput',
        });
        settings.bind('show-net-io', netRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(netRow);

        // GPU toggle
        const gpuRow = new Adw.SwitchRow({
            title: 'GPU',
            subtitle: 'Show GPU usage or frequency',
        });
        settings.bind('show-gpu', gpuRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(gpuRow);

        // Power toggle
        const powerRow = new Adw.SwitchRow({
            title: 'Power / Energy',
            subtitle: 'Show CPU power draw and battery status',
        });
        settings.bind('show-power', powerRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visGroup.add(powerRow);

        // Detail group
        const detailGroup = new Adw.PreferencesGroup({
            title: 'Popup Details',
            description: 'Extra details shown in the dropdown menu',
        });
        page.add(detailGroup);

        const cpuCoreRow = new Adw.SwitchRow({
            title: 'CPU per core',
            subtitle: 'Show usage for each CPU core',
        });
        settings.bind('show-cpu-per-core', cpuCoreRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        detailGroup.add(cpuCoreRow);

        const ramDetailRow = new Adw.SwitchRow({
            title: 'RAM details',
            subtitle: 'Show free, used, cache and swap',
        });
        settings.bind('show-ram-details', ramDetailRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        detailGroup.add(ramDetailRow);

        const diskPartRow = new Adw.SwitchRow({
            title: 'Disk per partition',
            subtitle: 'Show usage for each partition',
        });
        settings.bind('show-disk-partitions', diskPartRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        detailGroup.add(diskPartRow);

        const ioDetailRow = new Adw.SwitchRow({
            title: 'Disk I/O per device',
            subtitle: 'Show read/write per disk device',
        });
        settings.bind('show-disk-io-details', ioDetailRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        detailGroup.add(ioDetailRow);

        const netDetailRow = new Adw.SwitchRow({
            title: 'Network per interface',
            subtitle: 'Show download/upload per network interface',
        });
        settings.bind('show-net-io-details', netDetailRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        detailGroup.add(netDetailRow);

        // Update interval group
        const intervalGroup = new Adw.PreferencesGroup({
            title: 'Update Interval',
            description: 'How often to refresh the monitoring data',
        });
        page.add(intervalGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Interval (seconds)',
            subtitle: 'Lower values use more CPU',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 30,
                step_increment: 1,
                value: settings.get_int('update-interval'),
            }),
        });
        settings.bind('update-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        intervalGroup.add(intervalRow);
    }
}
