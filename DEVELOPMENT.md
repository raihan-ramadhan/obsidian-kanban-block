# Kanban Block — Developer Guide

This document is for developers who want to understand the plugin architecture and build new features on top of it.

---

## File Structure

```
main.ts              — full plugin source code (TypeScript)
obsidian.d.ts        — manual type declarations for the Obsidian API
manifest.json        — plugin metadata (id, version, etc.)
package.json         — npm config & build scripts
esbuild.config.mjs   — build configuration
tsconfig.json        — TypeScript config
README.md            — end-user documentation
DEVELOPMENT.md       — this file
```

The build produces a single output file: `main.js` — that is the only file that needs to be copied to the vault alongside `manifest.json`.

---

## Development Setup

```bash
npm install
npm run dev     # watch mode — auto rebuild on every change
npm run build   # production build
```

For live reload during development, either copy `main.js` to the vault after each build, or symlink the plugin folder directly into your vault:

```bash
ln -s /path/to/repo /path/to/vault/.obsidian/plugins/kanban-block
```

---

## Architecture

### Data Flow

```
source (string inside the markdown file)
  │
  ▼
parseKanban(source)
  │  — reads line by line
  │  — ## → KanbanColumn
  │  — - / * → KanbanCard
  │  — unrecognized lines → trailingRaw[] (raw passthrough)
  ▼
KanbanColumn[] + _preColumnRaw[]
  │
  ▼
KanbanRenderer.render()
  │  — builds DOM: search bar + board + columns + cards
  │  — attaches event listeners (drag, click, input)
  ▼
User interaction (drag / edit / add / delete)
  │
  ▼
mutate KanbanColumn[] in-memory
  │
  ▼
serializeKanban(columns) → new source string
  │
  ▼
vault.modify(file, newContent)  — writes back to the .md file
```

### Main Class

**`KanbanRenderer extends MarkdownRenderChild`**

- Instantiated by `registerMarkdownCodeBlockProcessor`
- `onload()` → calls `render()`
- `render()` → rebuilds the entire DOM from scratch on every call
- `saveAndRender()` → serialize → write file → re-render
- State is held in `this.columns` (in-memory array)

### Types

```typescript
interface KanbanCard {
  id: string; // runtime UUID, never written to file
  text: string; // raw text including tags and wikilinks
  tags: string[]; // parsed #tags from text
}

interface KanbanColumn {
  id: string; // runtime UUID, never written to file
  title: string; // raw title (includes [bg:#hex] if present)
  displayTitle: string; // cleaned title shown in the UI
  bgColor: string | null;
  cards: KanbanCard[];
  trailingRaw: string[]; // unrecognized lines attached to this column
}
```

### Directives (Header Line)

Directives are written on the first line of the kanban block, in any order:

```
[v:1][maxHeight:400px][columnWidth:280px][pagesFolder:_kanban-notes]
```

| Directive            | Regex constant    | Default         | Notes                      |
| -------------------- | ----------------- | --------------- | -------------------------- |
| `[v:N]`              | `VERSION_RE`      | `1`             | Format version             |
| `[maxHeight:X]`      | `MAX_HEIGHT_RE`   | `400px`         | Cards area max height      |
| `[columnWidth:X]`    | `COL_WIDTH_RE`    | `240px`         | Column width               |
| `[pagesFolder:name]` | `PAGES_FOLDER_RE` | `_kanban-notes` | Folder for converted pages |

All directives are:

- Case-insensitive
- Allow spaces inside `[ key : value ]`
- Order-independent
- Stripped from display, round-tripped on save
- Deduplicated on save — only the first occurrence is kept

---

## How to Add New Features

### A. Adding a New Directive

Follow the existing directive pattern exactly. Example: adding `[view:list]`.

**1. Add the constant and regex** (after the last directive block in `main.ts`):

```typescript
const DEFAULT_VIEW = "kanban";
const VIEW_RE = /\[\s*view\s*:\s*(kanban|list|grid)\s*\]/i;

function parseView(source: string): string {
  for (const line of source.split("\n")) {
    const match = line.match(VIEW_RE);
    if (match) return match[1].toLowerCase();
  }
  return DEFAULT_VIEW;
}
```

**2. Skip in the parser** (inside the `parseKanban` loop):

```typescript
if (... || VIEW_RE.test(trimmed)) continue;
```

**3. Strip in the serializer** (in the `.filter()` inside `serializeKanban`):

```typescript
.filter((l) => !... && !VIEW_RE.test(l.trim()))
```

**4. Add to `extractSourceHeader`** (follow the `seenMH`, `seenCW` pattern):

```typescript
let seenV2 = false;
// inside the loop:
if (!seenV2) {
  const v2 = line.match(VIEW_RE);
  if (v2) {
    tokens.push(v2[0].trim());
    seenV2 = true;
  }
}
```

**5. Use it in `render()`**:

```typescript
const view = parseView(this.source);
board.dataset.view = view; // switch layout via CSS
```

---

### B. Adding Properties to Cards

Cards currently store only `text` and `tags`. There are two strategies:

**Strategy 1 — Encode in text (simple)**

Add parsing inside `parseKanban`:

```typescript
// Example: - My task #urgent due:2024-01-15 priority:high
const dueMatch = cardText.match(/due:([\d-]+)/);
const priorityMatch = cardText.match(/priority:(low|medium|high)/);
```

Add fields to `KanbanCard`:

```typescript
interface KanbanCard {
  // ... existing fields
  dueDate?: string;
  priority?: "low" | "medium" | "high";
}
```

Render badges or chips in `renderCard()` below the card text.

The serializer does not need changes — the data already lives inside `text`.

**Strategy 2 — Card as a Page (powerful)**

Use the existing "Convert to Page" feature. Cards converted to `[[wikilink]]` can store properties in the YAML frontmatter of their linked file:

```markdown
---
priority: high
due: 2024-01-15
assignee: "@john"
---

# Task Name
```

Read frontmatter via the Obsidian API:

```typescript
const file = vault.getFileByPath(path);
const cache = app.metadataCache.getFileCache(file);
const frontmatter = cache?.frontmatter; // { priority: "high", due: "2024-01-15" }
```

This approach is more powerful and keeps the card text clean.

---

### C. Adding New View Modes (List / Grid)

All columns and cards are already in the DOM — just switch a CSS class on the board:

```typescript
// In render():
const view = parseView(this.source);
board.classList.add(`kanban-view-${view}`);
```

```css
/* List view: full-width vertical columns */
.kanban-view-list {
  flex-direction: column;
}
.kanban-view-list .kanban-column {
  width: 100% !important;
  min-width: unset !important;
}

/* Grid view: auto-wrap columns */
.kanban-view-grid {
  flex-wrap: wrap;
}
```

No logic changes required — CSS only.

---

## Format Version & Migration

Every kanban block stores `[v:N]` in its directive line. This enables graceful handling of breaking changes in the future.

`CURRENT_FORMAT_VERSION` is currently **1**.

### When to bump the version

Bump `CURRENT_FORMAT_VERSION` to `2` if:

- A directive format changes in a breaking way (e.g. `[maxHeight]` renamed to `[height]`)
- The card format changes (e.g. prefix `- ` replaced by something else)
- The column structure changes in a way that old parsers would misread

Do **not** bump if you are only adding new opt-in features that are backward-compatible.

### How to implement migration

```typescript
function migrateSource(source: string, fromVersion: number): string {
  if (fromVersion < 2) {
    // Example: rename [maxHeight] to [height]
    source = source.replace(/\[maxHeight:/gi, "[height:");
  }
  if (fromVersion < 3) {
    // v2 → v3 migration
  }
  return source;
}
```

Call it at the start of `KanbanRenderer.onload()` or in the constructor:

```typescript
const version = parseFormatVersion(this.source);
if (version < CURRENT_FORMAT_VERSION) {
  this.source = migrateSource(this.source, version);
  await this.saveToFile(this.source); // persist the migrated source
}
```

Blocks written before versioning was introduced have no `[v:N]` tag. `parseFormatVersion` returns `1` as the default for these, so they are treated as v1 and remain fully compatible.

---

## Raw Line Passthrough

Lines that the parser does not recognize (not `## `, not `- `/`* `, not a directive) are **not discarded** — they are stored in:

- `_preColumnRaw[]` — lines that appear before the first column
- `col.trailingRaw[]` — lines that appear after the cards of a specific column

On serialize, these lines are written back at the same relative position. When columns are reordered, `trailingRaw` moves with its column.

This ensures that any raw markdown a user writes manually inside the block is preserved across saves and reorders.

---

## Wikilink & Pages Folder

A card can contain `[[FileName]]` — rendered as a clickable link.

"Convert to Page" creates a new file in `pagesFolder` (default `_kanban-notes`) and rewrites the card text as a wikilink.

When resolving a wikilink:

1. Check the `pagesFolder` first
2. Fall back to the same folder as the kanban file (legacy support)

This ensures cards created before `pagesFolder` was introduced continue to work correctly.

---

## Feature Roadmap

Ideas for future development:

- **View modes** — `[view:list]` or `[view:grid]` — see section C above
- **Card priority** — encode in text or use frontmatter
- **Due dates** — red badge when overdue
- **Card colors** — `[color:#hex]` per card
- **Column collapse** — click header to collapse/expand
- **Card count limit per column** — `## Column [limit:5]`
- **Keyboard navigation** — arrow keys between cards
- **Export** — export the board as a markdown table
- **Card templates** — predefined card content when adding a new card
- **Multi-board sync** — one card appears across multiple boards
