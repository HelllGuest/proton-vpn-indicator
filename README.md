# Proton VPN Indicator

GNOME Shell extension. Adds a Proton VPN indicator to the top panel.

Shows the connected server name and protocol. The menu offers connect,
reconnect, disconnect, copy server IP, pinned servers (read from the
Proton VPN app config), and a shortcut to open the official app. The panel
icon tints green while connected and dims when disconnected.

This extension is not affiliated, funded, or in any way associated with
Proton VPN.

## Requirements

- GNOME Shell 46–50
- NetworkManager (`gi://NM`)
- Proton VPN Linux app, with connection profiles managed by NetworkManager

## Install

```sh
git clone https://github.com/helllguest/proton-vpn-indicator.git
cp -r proton-vpn-indicator ~/.local/share/gnome-shell/extensions/proton-vpn@helllguest
```

Then restart GNOME Shell (log out / log in on Wayland) and enable:

```sh
gnome-extensions enable proton-vpn@helllguest
```

## Pinned servers

Pinned servers are read from the Proton VPN app config at
`~/.config/Proton/VPN/app-config.json` (`tray_pinned_servers`). Pin them
in the app; they appear in the panel menu.

## Credits

Fork of [Proton VPN Button](https://extensions.gnome.org/extension/6631/proton-vpn-button/)
by [@fthx](https://github.com/fthx). Maintained by [@helllguest](https://github.com/helllguest).

## License

See [LICENSE](LICENSE).
