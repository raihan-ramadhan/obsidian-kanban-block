# Kanban Block — Obsidian Plugin

An Obsidian plugin that renders interactive Kanban boards directly inside fenced code blocks in your notes. No separate files, no sidebar — just a `kanban` code block anywhere in your markdown.

[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/raihancodes)
[![PayPal](https://img.shields.io/badge/Support-PayPal-00457C?logo=paypal&logoColor=white)](https://paypal.me/raihancodes)

---

## Quick Start

Create a code block with the language set to `kanban`:

````markdown
```kanban
[v:1][maxHeight:400px][columnWidth:240px][notesFolder:_kanban-notes]
## Todo
- Buy groceries
- [[Meeting Notes]]
## In Progress
- [[Feature Spec]]
## Done
- Plain card done
```
````

Right-click inside the block for more options, or use the toolbar at the top.

---

## Real World Examples

### Personal Todo

````markdown
```kanban
[v:1][maxHeight:400px][columnWidth:220px][notesFolder:_kanban-notes]
## Backlog [bg:#b8c8e8]
- Research new framework
- Read chapter 5
## Today [bg:#fde68a]
- [[Sprint Planning Notes]]
- Buy groceries
## Done [bg:#bbf7d0]
- Fix login bug
```
````

### CRM / Lead Tracker

````markdown
```kanban
[v:1][maxHeight:500px][columnWidth:260px][notesFolder:/CRM/Clients]
## Leads [bg:#bfdbfe]
- [[Ahmad Fauzi]] #enterprise
- [[PT Berkah Jaya]] #smb
## Proposal Sent [bg:#fde68a]
- [[Diana Putri]] #vip
## Negotiation [bg:#fed7aa]
- [[Rudi Hartono]] #enterprise
## Closed Won [bg:#bbf7d0]
- [[Sarah Smith]] #vip
## Closed Lost [bg:#fecaca]
- [[Old Lead]]
```
````

### Project Tracker

````markdown
```kanban
[v:1][maxHeight:450px][columnWidth:250px][notesFolder:/Projects/Active]
## Planning [bg:#e9d5ff]
- [[Website Redesign]]
- [[API v2 Spec]]
## In Progress [bg:#bfdbfe]
- [[Mobile App MVP]]
## Review [bg:#fde68a]
- [[Dashboard UI]]
## Shipped [bg:#bbf7d0]
- [[Auth System]]
```
````

### Content Calendar

````markdown
```kanban
[v:1][maxHeight:400px][columnWidth:230px][notesFolder:content]
## Ideas [bg:#e9d5ff]
- [[YouTube: Obsidian Tips]]
- Blog post: Productivity system
## Writing [bg:#bae6fd]
- [[Tutorial: Kanban Plugin]]
## Review [bg:#fed7aa]
- [[Video Script: Note-taking]]
## Published [bg:#bbf7d0]
- [[Blog: Getting Started with Obsidian]]
```
````

---

## Features

### Core Board

| Feature          | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| Columns          | Create, rename, delete, and reorder columns via drag & drop |
| Cards            | Add, edit, delete, and drag cards between columns           |
| Column color     | Set a background color per column                           |
| Multi-line cards | Cards support multiple lines of text                        |
| Tags             | Add `#tags` to cards for filtering                          |
| Auto-save        | All changes are written back to the markdown file instantly |

### Notes Integration

| Feature              | Description                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linked note card     | Write `[[Note Name]]` to link a card to an existing note                                                                                          |
| Ghost card           | `[[Note Name]]` with no existing file shows a `+` badge to create it                                                                              |
| Convert to Note      | Convert any plain card into a linked note file                                                                                                    |
| Open note            | Click a linked note to open it in a split pane                                                                                                    |
| Rename note          | Rename a linked note — renames the file and updates the card                                                                                      |
| Delete + file        | When deleting a linked card, optionally delete the `.md` file too                                                                                 |
| Undo delete          | A 5-second toast appears after delete — click Undo to restore                                                                                     |
| Vault-wide detection | `[[link]]` resolves files anywhere in the vault, not just `notesFolder`                                                                           |
| Absolute path        | `notesFolder:/Database/Clients` resolves from vault root                                                                                          |
| Relative path        | Notes saved in a subfolder next to the kanban file (e.g. `notesFolder:clients` with kanban at `Projects/board.md` → saves to `Projects/clients/`) |
| Nested folders       | Auto-creates all parent folders (e.g. `/Projects/Active/Notes`)                                                                                   |

### Toolbar & Search

| Feature    | Description                                                  |
| ---------- | ------------------------------------------------------------ |
| Search     | Live search with highlighted matches across all cards        |
| Sort       | Sort cards by title A-Z, Z-A, newest, or oldest              |
| Filter     | Filter by All, Notes only, Plain only, or by tag             |
| Properties | View and edit frontmatter tags on linked note cards          |
| Directives | Edit `maxHeight`, `columnWidth`, and `notesFolder` via modal |

### Select Mode

| Feature              | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| Select Cards button  | Toggle select mode from toolbar                              |
| Shift+click          | Range select from anchor card to clicked card                |
| Ctrl/Cmd+click       | Toggle single card selection                                 |
| Click in select mode | Toggle single card selection                                 |
| Bulk delete          | Delete all selected cards at once                            |
| Delete + files       | Optionally delete linked note files in bulk                  |
| Undo bulk delete     | 5-second undo window after bulk delete                       |
| Mutual exclusive     | Activating select on one block auto-cancels select on others |
| Esc to cancel        | Press Escape to exit select mode                             |

### UX & Interactions

| Feature            | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| FLIP animation     | Smooth column slide animation during drag reorder                        |
| Action bar         | Floating bar with count, Delete, and Cancel during select mode           |
| Smart menus        | All dropdowns flip up/down automatically based on available space        |
| Right-click menu   | Context menu with Add Column, Edit Directives, Copy Source, Delete Block |
| Keyboard shortcuts | Esc cancels select mode; Enter saves; Shift+Enter for new line in cards  |
| Tooltips           | All toolbar buttons show tooltips on hover                               |
| Scroll memory      | Board scroll position is restored after re-render                        |

---

## Directives

Directives are settings written in the first line of the kanban block:

```
[v:1][maxHeight:400px][columnWidth:240px][notesFolder:_kanban-notes]
```

| Directive     | Default         | Description                                                                                                                        |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `v`           | `1`             | Format version (do not change manually)                                                                                            |
| `maxHeight`   | `400px`         | Max height of each column card list                                                                                                |
| `columnWidth` | `240px`         | Width of each column                                                                                                               |
| `notesFolder` | `_kanban-notes` | Folder where new notes are saved. Without `/` prefix: created next to your kanban file. With `/` prefix: resolved from vault root. |

### notesFolder Examples

If your kanban block is inside `Projects/board.md`:

| Directive                           | Notes saved to                     |
| ----------------------------------- | ---------------------------------- |
| `[notesFolder:_kanban-notes]`       | `Projects/_kanban-notes/`          |
| `[notesFolder:clients]`             | `Projects/clients/`                |
| `[notesFolder:/Database/Clients]`   | `Database/Clients/` (vault root)   |
| `[notesFolder:/Projects/CRM/Leads]` | `Projects/CRM/Leads/` (vault root) |

Paths **without** a leading `/` are created as a subfolder next to your kanban file.
Paths **with** a leading `/` are always resolved from the vault root, regardless of where the kanban file is.

---

## Card Syntax

```
- Plain card text
- [[Linked Note]]
- [[Note]] #tag1 #tag2
- Multi-line card\nSecond line
```

---

## Keyboard Shortcuts

| Shortcut         | Action                                                  |
| ---------------- | ------------------------------------------------------- |
| `Escape`         | Cancel select mode / close menus                        |
| `Enter`          | Save card / confirm dialog                              |
| `Shift+Enter`    | New line inside card editor                             |
| `Shift+Click`    | Range select cards (auto-enables select mode)           |
| `Ctrl/Cmd+Click` | Toggle single card selection (auto-enables select mode) |

---

## Support

If this plugin saved you time or made your workflow better, a small donation means a lot and helps keep the project alive. Thank you! 🙏

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20me-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/raihancodes)
[![PayPal](https://img.shields.io/badge/PayPal-Donate-0070BA?logo=paypal&logoColor=white)](https://paypal.me/raihancodes)

---

## Author

Made with ❤️ by [Raihan Ramadhan](https://github.com/raihan-ramadhan)

---

## License

MIT
