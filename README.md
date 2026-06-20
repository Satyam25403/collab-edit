# Collab Edit

**Real-time collaborative coding inside VS Code.** Share your workspace with a partner, see live edits instantly, and control file permissions — no account needed, no browser required.

---

## Features

- **One-click room creation** — generate a 6-digit code and share it with your partner
- **Live file sync** — your partner sees every keystroke in real time
- **Virtual filesystem** — guests browse and open your files directly in their VS Code
- **Permission control** — guests start in read-only mode; you approve edit access per file or for the whole workspace
- **No sign-up required** — just install, create a room, and share the code

---

## Getting Started

### Host (sharing your code)

1. Open the **Collab Edit** panel in the Activity Bar (broadcast icon)
2. Click **Create Session Room**
3. Share the 6-digit code with your partner

### Guest (joining a session)

1. Open the **Collab Edit** panel
2. Enter the 6-digit room code in **Join Pair Session**
3. Click **Join Session**
4. The host's workspace mounts as `Collab Room [XXXXXX]` in your Explorer
5. Browse and open files — you're in read-only mode by default
6. Click **⚡ Request Edit Permission** to ask the host for write access

### Requesting / Approving Edit Access

- Guest clicks **Request Edit Permission** in the sidebar
- Host receives a notification and can approve or deny
- Once approved, the file path appears under **Editable Folders/Files**

---

## Requirements

- VS Code `^1.74.0`
- Both users must have the extension installed
- Internet connection (uses a hosted relay server — no setup needed)

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `collabEdit.serverUrl` | `wss://...` | Custom relay server URL (advanced) |

---

## Known Limitations

- One guest per room at a time (1:1 sessions)
- Large binary files may be slow to transfer
- The relay server does not store any file content — all data is end-to-end relayed in memory

---

## Contributing

Issues and PRs welcome at [GitHub](https://github.com/YOUR_USERNAME/collab-edit).

---

## License

MIT