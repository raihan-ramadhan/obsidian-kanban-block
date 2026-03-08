# Kanban Block — Obsidian Plugin

Add interactive Kanban boards directly inside your Obsidian notes using a `kanban` code block. No separate files needed — the board lives inside your markdown.

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![Obsidian](https://img.shields.io/badge/Obsidian-0.15%2B-purple) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **Interactive board** — drag & drop cards between columns, reorder columns
- **Inline editing** — click a card to edit, double-click a column title to rename
- **Colored tags** — `#tagname` automatically gets a consistent color
- **Convert to Page** — turn any card into a standalone `.md` file with one click
- **Wikilink support** — `[[FileName]]` cards are clickable and open the linked file
- **Real-time search** — filter cards instantly across all columns
- **Configuration directives** — control height, column width, and pages folder
- **Raw passthrough** — unrecognized lines (H1, H3, free text) are preserved on save
- **Context menu insert** — right-click in editor → "Insert Kanban Block"
- **Command palette** — `Ctrl+P` → "Insert Kanban Block"
- **Dark & light mode** — follows your Obsidian theme automatically
- **Auto-save** — every change is immediately saved back to the `.md` file

---

## Usage

### Basic Syntax

````markdown
```kanban
## To Do
- Buy coffee
- Review team PR

## In Progress
- Build Obsidian plugin #dev
- Design landing page #design

## Done
- Project setup #done
```
````

### With Directives

````markdown
```kanban
[v:1][maxHeight:400px][columnWidth:280px][pagesFolder:_kanban-notes]
## To Do
- First card
## Done
- Finished card
```
````

### All Directives

| Directive            | Example                | Default         | Description                                                       |
| -------------------- | ---------------------- | --------------- | ----------------------------------------------------------------- |
| `[v:N]`              | `[v:1]`                | `1`             | Format version — do not change manually                           |
| `[maxHeight:X]`      | `[maxHeight:400px]`    | `400px`         | Max height of the cards area. Units: `px`, `vh`, `em`, `rem`, `%` |
| `[columnWidth:X]`    | `[columnWidth:280px]`  | `240px`         | Width of each column. Units: `px`, `vw`, `em`, `rem`, `%`         |
| `[pagesFolder:name]` | `[pagesFolder:_notes]` | `_kanban-notes` | Folder for files created by "Convert to Page"                     |

Directives can be written in any order and are case-insensitive.

### Column Background Color

```
## Column Title [bg:#cce5ff]
```

Text color automatically adjusts (black or white) based on background brightness.

---

## Installation (Manual)

### 1. Clone & Build

```bash
git clone https://github.com/raihan-ramadhan/kanban-block
cd kanban-block
npm install
npm run build
```

### 2. Copy to Your Vault

```
YourVault/.obsidian/plugins/kanban-block/
├── main.js
└── manifest.json
```

### 3. Enable the Plugin

**Settings → Community Plugins → toggle "Kanban Block"**

> ⚠️ Make sure "Safe Mode" is disabled under Community Plugins

---

## Installation (BRAT)

If the plugin is published to GitHub, you can install it via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the BRAT plugin in Obsidian
2. Open BRAT settings → "Add Beta Plugin"
3. Enter this repository URL

---

## How Convert to Page Works

Click `⋯` on any card → "Convert to Page":

1. A new `.md` file is created in the `pagesFolder` (default `_kanban-notes`)
2. The folder is created automatically if it does not exist
3. The card text becomes `[[FileName]]`
4. The new file starts with `# FileName` as its initial content

To delete all pages at once, simply delete the `_kanban-notes` folder.

---

## Contributing

Want to contribute? Read [DEVELOPMENT.md](DEVELOPMENT.md) to understand the architecture, how to add new features, and the development workflow.

```bash
npm run dev   # watch mode — auto rebuild on changes
```

Pull requests, bug reports, and feature ideas are welcome in [Issues](https://github.com/raihan-ramadhan/kanban-block/issues).

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

MIT — free to use, modify, and distribute.
