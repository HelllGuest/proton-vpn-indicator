//    Proton VPN Indicator
//    GNOME Shell extension
//    Fork of Proton VPN Button by @fthx (2025)
//    Modified by @helllguest (2026)


import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import NM from 'gi://NM';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';


const APPLICATION_ID = 'proton.vpn.app.gtk';
const APP_DBUS_PATH = '/proton/vpn/app/gtk';
const DESKTOP_IDS = [
    'proton.vpn.app.gtk.desktop',
    'com.protonvpn.www.desktop',
];
const INACTIVE_VPN_ICON_OPACITY = 128;
// Proton brand success green, used to tint the symbolic panel icon while
// connected. The icon stays monochrome and themes to the panel otherwise.
const CONNECTED_ICON_COLOR = '#1ea885';

const APP_CONFIG_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.config', 'Proton', 'VPN', 'app-config.json',
]);
const CONNECTION_PERSISTENCE_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.cache', 'Proton', 'VPN', 'connection', 'connection_persistence.json',
]);


function readJsonFile(path) {
    try {
        const [, contents] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(contents));
    } catch {
        return null;
    }
}

function dbusNameHasOwner(name) {
    try {
        const [, owned] = Gio.DBus.session.call_sync(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'NameHasOwner',
            new GLib.Variant('(s)', [name]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
        ).deep_unpack();
        return owned;
    } catch {
        return false;
    }
}

function isProtonConnectionProfile(connection) {
    const type = connection.get_connection_type();
    const id = connection.get_id().toLowerCase();
    return (type === 'vpn' || type === 'wireguard') && id.includes('proton');
}

function formatServerName(connectionId) {
    return connectionId
        .replace(/^ProtonVPN\s*[·\-–—]?\s*/i, '')
        .trim() || connectionId;
}

function formatProtocol(protocol) {
    switch (protocol) {
        case 'wireguard':
            return 'WireGuard';
        case 'openvpn-udp':
            return 'OpenVPN (UDP)';
        case 'openvpn-tcp':
            return 'OpenVPN (TCP)';
        default:
            return protocol ?? '';
    }
}

// Reads the Proton VPN app's persisted connection parameters. These are
// written by the official app and hold richer details than NetworkManager
// exposes: the exact server name, exit IP, and protocol.
function readPersistedConnection() {
    const data = readJsonFile(CONNECTION_PERSISTENCE_PATH);
    if (!data?.connection_id)
        return null;

    return {
        uuid: data.connection_id,
        protocol: data.protocol ?? '',
        serverName: data.server?.server_name ?? '',
        serverLabel: data.server?.label ?? '',
        serverIp: data.server?.server_ip ?? '',
    };
}


const ProtonVPNButton = GObject.registerClass(
    class ProtonVPNButton extends PanelMenu.Button {
        _init(path) {
            super._init(0.0, 'Proton VPN');

            this._opening = false;
            this._openTimeoutId = null;
            this._nmHandlerId = null;
            this._vpnActiveConnection = null;
            this._connected = false;
            this._serverName = '';
            this._protocol = '';
            this._serverIp = '';
            this._pinnedItems = [];
            this._configMonitor = null;
            this._configMonitorId = null;
            this._reconnectTimeoutId = null;

            const iconPath = `${path}/icons/protonvpn-symbolic.svg`;
            const gicon = Gio.icon_new_for_string(iconPath);

            this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
            this._icon = new St.Icon({ style_class: 'system-status-icon', gicon });
            this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
            this._box.add_child(this._icon);
            this._box.add_child(this._label);
            this.add_child(this._box);

            this._buildMenu();

            this._nmClient = NM.Client.new(null);
            this._nmHandlerId = this._nmClient.connect(
                'notify::active-connections',
                () => this._updateState(),
            );
            this._updateState();

            this.menu.connect('open-state-changed', (_menu, isOpen) => {
                if (isOpen)
                    this._updateMenu();
            });

            this._setupConfigMonitor();
        }

        // Watch the app config so pinned servers refresh live when changed
        // from the Proton VPN app, even while the menu is open.
        _setupConfigMonitor() {
            try {
                const file = Gio.File.new_for_path(APP_CONFIG_PATH);
                this._configMonitor = file.monitor_file(
                    Gio.FileMonitorFlags.NONE,
                    null,
                );
                this._configMonitorId = this._configMonitor.connect(
                    'changed',
                    () => {
                        if (this.menu.isOpen)
                            this._updateMenu();
                    },
                );
            } catch (error) {
                console.error('Proton VPN extension:', error);
            }
        }

        _buildMenu() {
            this._statusItem = new PopupMenu.PopupMenuItem('', {
                reactive: false,
                activate: false,
            });
            this.menu.addMenuItem(this._statusItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._connectItem = this.menu.addAction('Connect', () => this._connectLast());
            this._connectFastestItem = this.menu.addAction(
                'Connect to Fastest…',
                () => this._openApp(),
            );
            this._reconnectItem = this.menu.addAction('Reconnect', () => this._reconnect());
            this._disconnectItem = this.menu.addAction('Disconnect', () => this._disconnect());
            this._copyIpItem = this.menu.addAction(
                'Copy Server IP',
                () => this._copyServerIp(),
            );

            this._pinnedSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._pinnedSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addAction('Open Proton VPN', () => this._openApp());
        }

        _clearPinnedItems() {
            for (const item of this._pinnedItems)
                item.destroy();
            this._pinnedItems = [];
        }

        _rebuildPinnedItems() {
            this._clearPinnedItems();

            const config = readJsonFile(APP_CONFIG_PATH);
            const pinned = config?.tray_pinned_servers ?? [];
            if (!pinned.length)
                return;

            this._pinnedItems.push(
                this._pinnedSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Pinned')),
            );

            for (const server of pinned) {
                const label = String(server).toUpperCase();
                const item = new PopupMenu.PopupMenuItem(label);
                item.connect('activate', () => this._connectPinned(label));
                this._pinnedSection.addMenuItem(item);
                this._pinnedItems.push(item);
            }
        }

        _getProtonProfiles() {
            return (this._nmClient.get_connections() ?? [])
                .filter(isProtonConnectionProfile);
        }

        _findProfileByUuid(uuid) {
            return this._getProtonProfiles()
                .find(profile => profile.get_uuid() === uuid) ?? null;
        }

        _findProfileForServer(serverName) {
            const needle = serverName.toUpperCase();
            return this._getProtonProfiles().find(profile => {
                return formatServerName(profile.get_id()).toUpperCase() === needle;
            }) ?? null;
        }

        _lastPersistedProfile() {
            const persistence = readPersistedConnection();
            if (persistence)
                return this._findProfileByUuid(persistence.uuid);

            const profiles = this._getProtonProfiles();
            return profiles.length ? profiles[0] : null;
        }

        _activateProfile(profile) {
            if (!profile)
                return;

            this._nmClient.activate_connection_async(
                profile,
                null,
                null,
                null,
                (client, result) => {
                    try {
                        client.activate_connection_finish(result);
                    } catch (error) {
                        console.error('Proton VPN extension:', error);
                        Main.notify('Proton VPN', error.message);
                        this._openApp();
                    }
                },
            );
        }

        _connectLast() {
            const profile = this._lastPersistedProfile();
            if (profile) {
                this._activateProfile(profile);
                return;
            }

            Main.notify(
                'Proton VPN',
                'No saved connection found. Opening the app.',
            );
            this._openApp();
        }

        _connectPinned(serverName) {
            const profile = this._findProfileForServer(serverName);
            if (profile) {
                this._activateProfile(profile);
                return;
            }

            Main.notify(
                'Proton VPN',
                `No profile for ${serverName}. Opening the app.`,
            );
            this._openApp();
        }

        _disconnect() {
            if (!this._vpnActiveConnection)
                return;

            try {
                this._nmClient.deactivate_connection(this._vpnActiveConnection, null);
            } catch (error) {
                console.error('Proton VPN extension:', error);
                Main.notify('Proton VPN', error.message);
            }
        }

        _reconnect() {
            const profile = this._lastPersistedProfile()
                ?? this._vpnActiveConnection?.get_connection();
            if (!profile) {
                this._openApp();
                return;
            }

            this._disconnect();

            // Give NetworkManager a moment to tear down the tunnel before
            // bringing it back up; reactivating mid-teardown can fail.
            if (this._reconnectTimeoutId)
                GLib.Source.remove(this._reconnectTimeoutId);
            this._reconnectTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                600,
                () => {
                    this._reconnectTimeoutId = null;
                    this._activateProfile(profile);
                    return GLib.SOURCE_REMOVE;
                },
            );
        }

        _copyServerIp() {
            if (!this._serverIp)
                return;

            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                this._serverIp,
            );
            Main.notify('Proton VPN', `Server IP copied: ${this._serverIp}`);
        }

        _updateMenu() {
            this._rebuildPinnedItems();

            if (this._connected) {
                const parts = ['Connected'];
                if (this._serverName)
                    parts.push(this._serverName);
                if (this._protocol)
                    parts.push(formatProtocol(this._protocol));
                this._statusItem.label.text = parts.join(' · ');
            } else {
                this._statusItem.label.text = 'Not connected';
            }

            this._connectItem.actor.visible = !this._connected;
            this._connectFastestItem.actor.visible = !this._connected;
            this._reconnectItem.actor.visible = this._connected;
            this._disconnectItem.actor.visible = this._connected;
            this._copyIpItem.actor.visible = this._connected && !!this._serverIp;

            const hasPinned = this._pinnedItems.length > 0;
            this._pinnedSection.actor.visible = hasPinned;
        }

        _updateState() {
            const activeConns = this._nmClient.get_active_connections() ?? [];

            const vpnConn = activeConns.find(conn => {
                const connection = conn.get_connection();
                if (connection && isProtonConnectionProfile(connection))
                    return true;

                const id = (conn.get_id() ?? '').toLowerCase();
                const type = (conn.get_connection_type() ?? '').toLowerCase();
                return (type.includes('vpn') || type.includes('wireguard'))
                    && id.includes('proton');
            });

            if (vpnConn) {
                this._vpnActiveConnection = vpnConn;
                this._connected = true;
                this._icon.opacity = 255;
                this._icon.set_style(`color: ${CONNECTED_ICON_COLOR};`);

                const settings = vpnConn.get_connection()?.get_setting_connection();
                const connectionId = settings?.get_id() ?? vpnConn.get_id();
                this._serverName = formatServerName(connectionId);
                this._protocol = '';
                this._serverIp = '';

                // Enrich with the app's persisted details when they describe
                // the same connection NetworkManager reports as active.
                const persistence = readPersistedConnection();
                if (persistence && persistence.uuid === vpnConn.get_uuid()) {
                    if (persistence.serverName)
                        this._serverName = persistence.serverName;
                    this._protocol = persistence.protocol;
                    this._serverIp = persistence.serverIp;
                }

                this._label.text = this._serverName;
                this._label.show();
            } else {
                this._vpnActiveConnection = null;
                this._connected = false;
                this._serverName = '';
                this._protocol = '';
                this._serverIp = '';
                this._icon.opacity = INACTIVE_VPN_ICON_OPACITY;
                this._icon.set_style(null);
                this._label.hide();
            }

            this._updateMenu();
        }

        _openApp() {
            if (this._opening)
                return;
            this._opening = true;

            this._openTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._opening = false;
                this._openTimeoutId = null;
                return GLib.SOURCE_REMOVE;
            });

            if (dbusNameHasOwner(APPLICATION_ID)) {
                try {
                    Gio.DBus.session.call_sync(
                        APPLICATION_ID,
                        APP_DBUS_PATH,
                        'org.freedesktop.Application',
                        'Activate',
                        new GLib.Variant('(a{sv})', [{}]),
                        null,
                        Gio.DBusCallFlags.NONE,
                        -1,
                    );
                    return;
                } catch (error) {
                    console.error('Proton VPN extension:', error);
                }
            }

            for (const id of DESKTOP_IDS) {
                const appInfo = Gio.DesktopAppInfo.new(id);
                if (appInfo) {
                    appInfo.launch([], global.create_app_launch_context(0, -1));
                    return;
                }
            }

            for (const id of DESKTOP_IDS) {
                const app = Shell.AppSystem.get_default().lookup_app(id);
                if (app) {
                    app.activate();
                    return;
                }
            }

            try {
                Gio.Subprocess.new(
                    ['/usr/bin/protonvpn-app'],
                    Gio.SubprocessFlags.NONE,
                );
            } catch (error) {
                console.error('Proton VPN extension:', error);
                Main.notify('Proton VPN extension', error.message);
            }
        }

        destroy() {
            this._clearPinnedItems();

            if (this._openTimeoutId) {
                GLib.Source.remove(this._openTimeoutId);
                this._openTimeoutId = null;
            }

            if (this._reconnectTimeoutId) {
                GLib.Source.remove(this._reconnectTimeoutId);
                this._reconnectTimeoutId = null;
            }

            if (this._configMonitor) {
                if (this._configMonitorId)
                    this._configMonitor.disconnect(this._configMonitorId);
                this._configMonitor.cancel();
                this._configMonitor = null;
                this._configMonitorId = null;
            }

            if (this._nmHandlerId && this._nmClient) {
                this._nmClient.disconnect(this._nmHandlerId);
                this._nmHandlerId = null;
            }
            this._nmClient = null;

            super.destroy();
        }
    });

export default class ProtonVPNButtonExtension extends Extension {
    enable() {
        this._button = new ProtonVPNButton(this.path);
        Main.panel.addToStatusArea('proton-vpn', this._button);
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
