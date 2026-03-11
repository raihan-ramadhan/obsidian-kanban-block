# Development Guide — Kanban Block Plugin

## Prerequisites

- Node.js 18+
- npm
- PowerShell (Windows, run as Administrator for the watcher script)
- Obsidian desktop app

---

## Project Structure

```
obsidian-kanban-block/
├── main.ts           # Main plugin source (TypeScript)
├── obsidian.d.ts     # Obsidian API type declarations
├── manifest.json     # Plugin manifest
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── main.js           # Compiled output (generated)
└── styles.css        # Empty (styles are injected inline from main.ts)
```

---

## Setup

```bash
npm install
```

---

## Development Workflow

### 1. Start the compiler (watch mode)

```bash
npm run dev
```

This runs esbuild in watch mode and recompiles `main.js` on every save.

### 2. Start the file watcher (PowerShell, run as Administrator)

Open PowerShell as Administrator and run the following script. Change `$src` to your project root and `$dst` to your Obsidian plugin folder.

```powershell
$src = "D:\CODE\obsidian-kanban-block"
$dst = "D:\YOUR_VAULT\.obsidian\plugins\kanban-block"
$files = @("main.js", "manifest.json", "styles.css")

if (!(Test-Path $dst)) { New-Item -ItemType Directory -Force -Path $dst }

Write-Host "Watching for changes in $src..." -ForegroundColor Cyan

while($true) {
    foreach ($f in $files) {
        $sourceFile = "$src\$f"
        $targetFile = "$dst\$f"

        if (Test-Path $sourceFile) {
            $st = (Get-Item $sourceFile).LastWriteTime
            $tt = if (Test-Path $targetFile) { (Get-Item $targetFile).LastWriteTime } else { [DateTime]::MinValue }

            if ($st -gt $tt) {
                try {
                    Copy-Item $sourceFile $targetFile -Force
                    Write-Host "[$((Get-Date).ToString('HH:mm:ss'))] Updated $f" -ForegroundColor Green
                } catch {
                    # File may be locked by esbuild, will retry on next tick
                }
            }
        }
    }
    Start-Sleep -Milliseconds 500
}
```

### 3. Reload in Obsidian

After the watcher copies the new `main.js`:

1. Close Obsidian completely
2. Reopen Obsidian
3. The updated plugin will load automatically

> **Tip:** You can also use the "Reload app without saving" command in Obsidian (Ctrl+R in developer mode) to reload without fully closing.

---

## Build for Production

```bash
npm run build
```

Outputs a minified `main.js` ready for distribution.

---

## Architecture Overview

### Entry Point

`KanbanPlugin` (extends `Plugin`) registers the `kanban` code block processor and the editor right-click menu item.

### Renderer

`KanbanRenderer` (extends `MarkdownRenderChild`) is instantiated per code block. It owns:

- `this.source` — raw kanban source string
- `this.columns` — parsed column/card data
- `this.boardEl` — the live DOM board element
- All toolbar, drag, select, and search state

### Data Flow

```
source string
    → parseKanban()       parse columns and cards
    → render()            build DOM
    → user interaction
    → mutate this.columns
    → saveAndRender()
        → serializeKanban()   serialize back to string
        → saveToFile()        write to vault via ctx.getSectionInfo + vault.modify
        → render()            rebuild DOM
```

### Notes Folder Resolution (`resolveWikiFile`)

Search order for any `[[wikilink]]`:

1. `notesFolder/wt.md` — configured notes folder
2. `kanbanFolder/wt.md` — same folder as the kanban file (legacy)
3. `wt.md` — vault root
4. Vault-wide scan by filename — finds the file anywhere in the vault

### Key CSS Classes

| Class                   | Purpose                                     |
| ----------------------- | ------------------------------------------- |
| `.kanban-col-dragging`  | Applied to column being dragged             |
| `.kanban-card-selected` | Applied to selected cards in select mode    |
| `.kanban-select-mode`   | Applied to board when select mode is active |
| `.kanban-shift-held`    | Applied to board while Shift key is held    |
| `.kanban-ctrl-held`     | Applied to board while Ctrl/Cmd key is held |
| `.kanban-action-bar`    | Floating action bar during select mode      |
| `.kanban-highlight`     | Search match highlight on card text         |

---

## Adding a New Directive

1. Add a regex constant: `const MY_DIRECTIVE_RE = /\[\s*myDirective\s*:\s*([^\]]+?)\s*\]/i;`
2. Add a parse function: `function parseMyDirective(source: string): string { ... }`
3. Add it to `extractSourceHeader()` token list
4. Add it to the filter in `parseKanban()` and `serializeKanban()`
5. Add a field to the Directives modal in `showDirectivesModal()`

---

## obsidian.d.ts

This file contains hand-maintained type declarations for the Obsidian API since the official `obsidian` package is not bundled. If you need a new API method, add it here before using it in `main.ts`.

Key additions beyond stock Obsidian types:

- `Vault.getMarkdownFiles()` — vault-wide file list
- `Notice` class — toast notifications
- `HTMLElement.createEl()` / `DocumentFragment.createEl()` — Obsidian DOM helpers
- `setTooltip()` — Obsidian tooltip utility

---

## Common Pitfalls

- **`getSectionInfo` returns `lineEnd` as the closing fence line (inclusive).** Use `lines.slice(lineEnd + 1)` for content after the block.
- **After `vault.modify()`, Obsidian re-mounts the block.** Never rely on object references across a save — use serialized source string snapshots for undo.
- **`createEl` on `DocumentFragment` auto-appends.** Don't call `appendChild` again after `createEl`.
