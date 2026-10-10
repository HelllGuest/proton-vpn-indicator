# Proton VPN Indicator (`proton-vpn@helllguest`)

GNOME Shell extension (fork of [fthx/proton-vpn](https://github.com/fthx/proton-vpn)) with richer Proton VPN app integration.

## Features

* Panel label: connected server + protocol
* Connect / reconnect / disconnect
* Copy exit server IP
* Pinned servers from Proton VPN app config (native or Flatpak)
* Spoofed GeoClue location status + `vpn-location-sync`
* Open official Proton VPN app

## Requirements

* GNOME Shell **46–51**
* Proton VPN Linux app (optional but needed for pin/persistence enrichment)
* NetworkManager

## Install

Copy into `~/.local/share/gnome-shell/extensions/proton-vpn@helllguest/`, then:

```bash
gnome-extensions enable proton-vpn@helllguest
```

Wayland: log out and back in after install or metadata changes.

## License

GPL-3.0 (see LICENSE), same family as upstream button extension.
