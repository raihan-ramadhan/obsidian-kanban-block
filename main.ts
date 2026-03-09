import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  App,
  Editor,
  Menu,
  MenuItem,
  setIcon,
} from "obsidian";

// ─── Icon helper ─────────────────────────────────────────────────────────────
function si(element: HTMLElement, iconName: string) {
  setIcon(element, iconName);
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: { cls?: string; text?: string; attr?: Record<string, string> },
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts?.cls) e.className = opts.cls;
  if (opts?.text) e.textContent = opts.text;
  if (opts?.attr)
    for (const [k, v] of Object.entries(opts.attr)) e.setAttribute(k, v);
  return e;
}

function div(cls?: string): HTMLDivElement {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  return d;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface KanbanCard {
  id: string;
  text: string;
  tags: string[];
}

interface KanbanColumn {
  id: string; // runtime-only unique id, never written to file
  title: string; // raw title (preserved for serialization, includes [bg:...])
  displayTitle: string; // cleaned title without [bg:...]
  bgColor: string | null;
  cards: KanbanCard[];
  trailingRaw: string[]; // unrecognized lines that appeared after this column's cards
}

// Lines that appear before the first ## column (e.g. stray text at top of block)
// Stored separately so they survive reorder and save.
let _preColumnRaw: string[] = [];

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseKanban(source: string): KanbanColumn[] {
  const lines = source.split("\n");
  const columns: KanbanColumn[] = [];
  let currentColumn: KanbanColumn | null = null;

  // Reset pre-column raw lines each parse
  _preColumnRaw = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Always preserve empty lines and maxHeight directives as raw (except leading blank lines)
    if (!trimmed) {
      // Keep blank lines that appear between/after content (not before first column)
      if (currentColumn) currentColumn.trailingRaw.push(line);
      else if (columns.length === 0 && _preColumnRaw.length > 0)
        _preColumnRaw.push(line);
      continue;
    }

    // maxHeight / columnWidth are metadata — skip from rendering but preserve as sourceHeader
    if (
      MAX_HEIGHT_RE.test(trimmed) ||
      COL_WIDTH_RE.test(trimmed) ||
      PAGES_FOLDER_RE.test(trimmed) ||
      VERSION_RE.test(trimmed)
    )
      continue;

    if (trimmed === "##" || trimmed.startsWith("## ")) {
      // Trim trailing blank lines from previous column's raw before starting new column
      if (currentColumn) {
        while (
          currentColumn.trailingRaw.length > 0 &&
          currentColumn.trailingRaw[
            currentColumn.trailingRaw.length - 1
          ].trim() === ""
        ) {
          currentColumn.trailingRaw.pop();
        }
      }
      const rawTitle = trimmed === "##" ? "" : trimmed.slice(3).trim();
      const { displayTitle: parsedDisplay, bgColor } = parseBgColor(rawTitle);
      const displayTitle = parsedDisplay || "Untitled";
      currentColumn = {
        id: generateId(),
        title: rawTitle,
        displayTitle,
        bgColor,
        cards: [],
        trailingRaw: [],
      };
      columns.push(currentColumn);
    } else if (
      (trimmed.startsWith("- ") || trimmed.startsWith("* ")) &&
      currentColumn
    ) {
      const cardText = trimmed.slice(2).trim().replace(/\\n/g, "\n");
      const tags = cardText.match(/#[\w-]+/g) || [];
      currentColumn.cards.push({ id: generateId(), text: cardText, tags });
    } else {
      // Unrecognized line — attach to current column as trailing raw, or pre-column if none yet
      if (currentColumn) {
        currentColumn.trailingRaw.push(line);
      } else {
        _preColumnRaw.push(line);
      }
    }
  }

  // Trim trailing blank lines from last column too
  if (currentColumn) {
    while (
      currentColumn.trailingRaw.length > 0 &&
      currentColumn.trailingRaw[currentColumn.trailingRaw.length - 1].trim() ===
        ""
    ) {
      currentColumn.trailingRaw.pop();
    }
  }
  // Also trim trailing blank lines from _preColumnRaw
  while (
    _preColumnRaw.length > 0 &&
    _preColumnRaw[_preColumnRaw.length - 1].trim() === ""
  ) {
    _preColumnRaw.pop();
  }

  return columns;
}

function escapeRegex(s: string): string {
  return s.replace(/[-.*+?^${}()|[\]\\]/g, "\\$&");
}

// Custom in-DOM confirm dialog — avoids native confirm() focus trap in Electron/Obsidian
function kanbanConfirm(
  message: string,
  anchorEl: HTMLElement,
  confirmLabel = "Delete",
  danger = true,
): Promise<boolean> {
  return new Promise((resolve) => {
    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "kanban-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "kanban-modal";

    const msg = document.createElement("p");
    msg.className = "kanban-modal-msg";
    msg.textContent = message;

    const btnRow = document.createElement("div");
    btnRow.className = "kanban-modal-btns";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-cancel-btn";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "kanban-save-btn";
    confirmBtn.textContent = confirmLabel;
    if (danger) confirmBtn.style.background = "#e74c3c";

    const close = (result: boolean) => {
      backdrop.remove();
      resolve(result);
    };

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener("keydown", function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close(false);
      }
      if (e.key === "Enter") {
        document.removeEventListener("keydown", onKey);
        close(true);
      }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    modal.appendChild(msg);
    modal.appendChild(btnRow);
    backdrop.appendChild(modal);

    document.body.appendChild(backdrop);
    confirmBtn.focus();
  });
}

// Simple one-button alert — for errors and warnings
function kanbanAlert(message: string, anchorEl: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "kanban-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "kanban-modal";
    const msg = document.createElement("p");
    msg.className = "kanban-modal-msg";
    msg.textContent = message;
    const btnRow = document.createElement("div");
    btnRow.className = "kanban-modal-btns";
    const okBtn = document.createElement("button");
    okBtn.className = "kanban-save-btn";
    okBtn.textContent = "OK";
    const close = () => {
      backdrop.remove();
      resolve();
    };
    okBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener("keydown", function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" || e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close();
      }
    });
    btnRow.appendChild(okBtn);
    modal.appendChild(msg);
    modal.appendChild(btnRow);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    okBtn.focus();
  });
}

// Custom in-DOM prompt — avoids native prompt() focus trap in Electron/Obsidian
function kanbanPrompt(
  message: string,
  anchorEl: HTMLElement,
  placeholder = "",
  confirmLabel = "Create",
  // Optional validation: return error string to show inline, or null to accept
  validate?: (value: string) => string | null,
): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "kanban-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "kanban-modal";

    const msg = document.createElement("p");
    msg.className = "kanban-modal-msg";
    msg.textContent = message;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "kanban-modal-input";
    input.placeholder = placeholder;

    // Inline error message — hidden until validation fails
    const errorEl = document.createElement("p");
    errorEl.className = "kanban-modal-error";
    errorEl.style.display = "none";

    const btnRow = document.createElement("div");
    btnRow.className = "kanban-modal-btns";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-cancel-btn";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "kanban-save-btn";
    confirmBtn.textContent = confirmLabel;

    const showError = (msg: string) => {
      errorEl.textContent = msg;
      errorEl.style.display = "block";
      input.classList.add("kanban-modal-input-error");
      input.focus();
    };

    const clearError = () => {
      errorEl.style.display = "none";
      input.classList.remove("kanban-modal-input-error");
    };

    const trySubmit = () => {
      const value = input.value.trim();
      if (!value) {
        showError("Name cannot be empty.");
        return;
      }
      if (validate) {
        const err = validate(value);
        if (err) {
          showError(err);
          return;
        }
      }
      backdrop.remove();
      resolve(value);
    };

    const cancel = () => {
      backdrop.remove();
      resolve(null);
    };

    // Clear error as user types
    input.addEventListener("input", clearError);
    cancelBtn.addEventListener("click", cancel);
    confirmBtn.addEventListener("click", trySubmit);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cancel();
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        trySubmit();
      }
      if (e.key === "Escape") cancel();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    modal.appendChild(msg);
    modal.appendChild(input);
    modal.appendChild(errorEl);
    modal.appendChild(btnRow);
    backdrop.appendChild(modal);

    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}

// Detect [[wikilink]] — returns the link target or null
const WIKILINK_RE = /^\[\[(.+?)\]\]/;
function extractWikilink(text: string): string | null {
  const m = text.match(WIKILINK_RE);
  return m ? m[1] : null;
}

// Build a safe filename from card text: use first line only, strip tags, sanitize
function cardTextToFilename(text: string): string {
  const firstLine = text.split("\n")[0];
  const stripped = firstLine.replace(/#[\w-]+/g, "").trim();
  return stripped.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim();
}

// Extract body content (lines after first) from card text
function cardTextToBody(text: string): string {
  const lines = text.split("\n");
  return lines.slice(1).join("\n").trim();
}

// Get folder path from a file path (everything before last slash)
function getFolderPath(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx >= 0 ? filePath.slice(0, idx) : "";
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}

function serializeKanban(
  columns: KanbanColumn[],
  sourceHeader?: string,
): string {
  const parts: string[] = [];

  // Pre-column raw lines (stray content before first ##)
  if (_preColumnRaw.length > 0) {
    parts.push(_preColumnRaw.join("\n"));
  }

  for (const col of columns) {
    const cards = col.cards
      .map((c) => {
        // Encode newlines as literal \\n so multi-line cards stay on one line
        const encoded = c.text.replace(/\n/g, "\\n");
        return `- ${encoded}`;
      })
      .join("\n");
    const colHeader = col.title ? `## ${col.title}` : "##";
    let colBlock = `${colHeader}\n${cards}`;
    // Re-attach trailing raw lines that belonged to this column
    if (col.trailingRaw.length > 0) {
      colBlock += "\n" + col.trailingRaw.join("\n");
    }
    parts.push(colBlock);
  }

  // Always exactly one blank line between parts — prevents blank line accumulation on reorder
  const body = parts.filter((p) => p.trim()).join("\n\n");

  // Strip any duplicate [maxHeight:...] lines (safety net)
  const cleanBody = body
    .split("\n")
    .filter(
      (l) =>
        !MAX_HEIGHT_RE.test(l.trim()) &&
        !COL_WIDTH_RE.test(l.trim()) &&
        !PAGES_FOLDER_RE.test(l.trim()) &&
        !VERSION_RE.test(l.trim()),
    )
    .join("\n");

  return sourceHeader ? `${sourceHeader}\n${cleanBody}` : cleanBody;
}

/** Collect all directive tokens ([maxHeight:...], [columnWidth:...]) from the source
 *  and rebuild them as a single header line for round-trip save. */
function extractSourceHeader(source: string): string | undefined {
  const tokens: string[] = [];
  let seenMH = false,
    seenCW = false,
    seenPF = false,
    seenV = false;
  for (const line of source.split("\n")) {
    if (!seenMH) {
      const mh = line.match(MAX_HEIGHT_RE);
      if (mh) {
        tokens.push(mh[0].trim());
        seenMH = true;
      }
    }
    if (!seenCW) {
      const cw = line.match(COL_WIDTH_RE);
      if (cw) {
        tokens.push(cw[0].trim());
        seenCW = true;
      }
    }
    if (!seenPF) {
      const pf = line.match(PAGES_FOLDER_RE);
      if (pf) {
        tokens.push(pf[0].trim());
        seenPF = true;
      }
    }
    if (!seenV) {
      const v = line.match(VERSION_RE);
      if (v) {
        tokens.push(v[0].trim());
        seenV = true;
      }
    }
    if (seenMH && seenCW && seenPF && seenV) break;
  }
  // Always ensure [v:N] is written — add current version if not present in source
  if (!seenV) tokens.push(`[v:${CURRENT_FORMAT_VERSION}]`);
  return tokens.length > 0 ? tokens.join("") : undefined;
}

// ─── Tag colors ───────────────────────────────────────────────────────────────

const TAG_COLORS = [
  "#e74c3c",
  "#e67e22",
  "#f1c40f",
  "#2ecc71",
  "#1abc9c",
  "#3498db",
  "#9b59b6",
  "#e91e63",
];
const tagColorCache: Record<string, string> = {};
let tagColorIndex = 0;

function getTagColor(tag: string): string {
  if (!tagColorCache[tag]) {
    tagColorCache[tag] = TAG_COLORS[tagColorIndex % TAG_COLORS.length];
    tagColorIndex++;
  }
  return tagColorCache[tag];
}

// ─── Column bg color ──────────────────────────────────────────────────────────

// Matches [bg:#abc], [BG:#AABBCC], [Bg: #123456] — case-insensitive, optional space
const BG_TAG_RE = /\[\s*bg\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))\s*\]/i;

function parseBgColor(rawTitle: string): {
  displayTitle: string;
  bgColor: string | null;
} {
  const match = rawTitle.match(BG_TAG_RE);
  if (!match) return { displayTitle: rawTitle.trim(), bgColor: null };
  const bgColor = match[1].toLowerCase();
  const displayTitle = rawTitle.replace(BG_TAG_RE, "").trim();
  return { displayTitle, bgColor };
}

// Parse hex (#rgb or #rrggbb) into [r, g, b] 0-255
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (h.length !== 6) return [128, 128, 128]; // fallback to mid-grey for malformed input
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Relative luminance per WCAG 2.1
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Mix hex color with white (amount=1) or black (amount=-1), range -1 to 1
function shiftHex(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix =
    amount > 0
      ? (c: number) => Math.round(c + (255 - c) * amount) // toward white
      : (c: number) => Math.round(c * (1 + amount)); // toward black
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// Adaptive foreground: returns a tinted light or dark color that contrasts with bg
// and is hue-shifted to feel "related" to the bg color
function adaptiveForeground(hex: string): string {
  const lum = luminance(hex);
  if (lum > 0.35) {
    // Light background → dark tinted foreground (shift toward black, keep hue)
    return shiftHex(hex, -0.65);
  } else if (lum > 0.12) {
    // Mid background → deep dark foreground
    return shiftHex(hex, -0.78);
  } else {
    // Dark background → light tinted foreground (shift toward white, keep hue)
    return shiftHex(hex, 0.75);
  }
}

// Border: subtle — darken for light bg, lighten slightly for dark bg
function borderColor(hex: string): string {
  return luminance(hex) > 0.2 ? shiftHex(hex, -0.2) : shiftHex(hex, 0.2);
}

// Header underline: stronger than border
function headerLineColor(hex: string): string {
  return luminance(hex) > 0.2 ? shiftHex(hex, -0.4) : shiftHex(hex, 0.4);
}

// ─── Global Max Height ────────────────────────────────────────────────────────

const DEFAULT_MAX_HEIGHT = "400px";
const DEFAULT_COL_WIDTH = "240px";

// Matches [maxHeight:450px], [maxheight: 40vh], [MAXHEIGHT:100%] — case-insensitive
const MAX_HEIGHT_RE =
  /\[\s*maxHeight\s*:\s*([\d.]+\s*(?:px|vh|em|rem|%))\s*\]/i;

// Matches [columnWidth:300px], [columnwidth: 20vw], etc.
const COL_WIDTH_RE =
  /\[\s*columnWidth\s*:\s*([\d.]+\s*(?:px|vw|em|rem|%))\s*\]/i;

function clampDimension(value: string, minPx: number): string {
  // Strip internal spaces (e.g. "400 px" -> "400px"), then clamp numeric part
  const normalized = value.replace(/\s+/g, "");
  const num = parseFloat(normalized);
  if (isNaN(num) || num < minPx) return null as unknown as string;
  return normalized;
}

function parseMaxHeight(source: string): string {
  for (const line of source.split("\n")) {
    const match = line.match(MAX_HEIGHT_RE);
    if (match) {
      const clamped = clampDimension(match[1], 50);
      if (clamped) return clamped;
    }
  }
  return DEFAULT_MAX_HEIGHT;
}

function parseColWidth(source: string): string {
  for (const line of source.split("\n")) {
    const match = line.match(COL_WIDTH_RE);
    if (match) {
      const clamped = clampDimension(match[1], 80);
      if (clamped) return clamped;
    }
  }
  return DEFAULT_COL_WIDTH;
}

const DEFAULT_PAGES_FOLDER = "_kanban-notes";

// Matches [pagesFolder:_my-pages], [pagesfolder: notes], etc.
const PAGES_FOLDER_RE = /\[\s*pagesFolder\s*:\s*([^\]]+?)\s*\]/i;

function parsePagesFolder(source: string): string {
  for (const line of source.split("\n")) {
    const match = line.match(PAGES_FOLDER_RE);
    if (match) return match[1].trim();
  }
  return DEFAULT_PAGES_FOLDER;
}

// ── Format version — for future migration support ─────────────────────────────
// Current format version is 1. Bump this when the kanban syntax changes
// in a breaking way, then add a migrateSource(source, fromVersion) function.
const CURRENT_FORMAT_VERSION = 1;
const VERSION_RE = /\[\s*v\s*:\s*(\d+)\s*\]/i;

function parseFormatVersion(source: string): number {
  for (const line of source.split("\n")) {
    const match = line.match(VERSION_RE);
    if (match) return parseInt(match[1], 10);
  }
  return 1; // default — blocks written before versioning existed are treated as v1
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

// Static map — survives Obsidian re-mounting KanbanRenderer instances.
// Key: sourcePath, Value: scrollLeft of boardScrollEl at time of last save.
const _scrollRegistry = new Map<string, number>();

class KanbanRenderer extends MarkdownRenderChild {
  private columns: KanbanColumn[];
  private source: string;
  private ctx: MarkdownPostProcessorContext;
  private obsApp: App;
  private searchQuery: string = "";
  private draggingColId: string | null = null;
  private boardScrollEl: HTMLElement | null = null;
  private boardEl: HTMLElement | null = null;
  private scrollKey: string = "";
  constructor(
    containerEl: HTMLElement,
    source: string,
    ctx: MarkdownPostProcessorContext,
    obsApp: App,
  ) {
    super(containerEl);
    this.source = source;
    this.columns = parseKanban(source);
    this.ctx = ctx;
    this.obsApp = obsApp;
    this.scrollKey = ctx.sourcePath;
  }

  onload() {
    this.containerEl.className = "kanban-plugin-container";
    this.injectStyles();

    // ── Search bar — created once, never destroyed ──
    const searchWrap = div("kanban-search-wrap");
    const searchIcon = el("span", { cls: "kanban-search-icon" });
    si(searchIcon, "search");
    const searchInput = el("input", {
      cls: "kanban-search-input",
      attr: { type: "text", placeholder: "Search cards..." },
    }) as HTMLInputElement;
    const clearBtn = el("button", { cls: "kanban-search-clear" });
    si(clearBtn, "x");
    clearBtn.style.display = "none";
    clearBtn.addEventListener("click", () => {
      this.searchQuery = "";
      searchInput.value = "";
      clearBtn.style.display = "none";
      if (this.boardEl) this.applySearch("", this.boardEl);
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      clearBtn.style.display = this.searchQuery ? "flex" : "none";
      if (this.boardEl) this.applySearch(this.searchQuery, this.boardEl);
    });
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(clearBtn);
    this.containerEl.appendChild(searchWrap);

    // ── Board scroll container — created once, scroll position never reset ──
    this.boardScrollEl = div("kanban-board-scroll");
    this.containerEl.appendChild(this.boardScrollEl);

    // ── Block native Obsidian context menu inside the kanban block ────────────
    this.containerEl.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this.showBoardContextMenu(e);
    });

    this.render();
  }

  private render() {
    // Only wipe and rebuild board contents — boardScrollEl is persistent so scroll position is preserved
    if (!this.boardScrollEl) return;
    this.boardScrollEl.innerHTML = "";

    // Re-parse directives every render so edits to source are reflected live
    const maxHeight = parseMaxHeight(this.source);
    const colWidth = parseColWidth(this.source);

    const boardScroll = this.boardScrollEl;
    const board = div("kanban-board");
    boardScroll.appendChild(board);
    this.boardEl = board;

    for (const col of this.columns) {
      this.renderColumn(board, col, maxHeight, colWidth);
    }

    // Apply search state immediately after render (preserves search across re-renders)
    if (this.searchQuery) this.applySearch(this.searchQuery, board);

    // Restore scroll from static registry — handles Obsidian re-mounting the instance
    const savedScroll = _scrollRegistry.get(this.scrollKey);
    if (savedScroll && savedScroll > 0 && this.boardScrollEl) {
      const bsEl = this.boardScrollEl;
      requestAnimationFrame(() => {
        bsEl.scrollLeft = savedScroll;
      });
    }

    const addColBtn = el("button", { cls: "kanban-add-col-btn" });
    const addColIcon = el("span", { cls: "kanban-add-col-icon" });
    si(addColIcon, "plus");
    addColBtn.appendChild(addColIcon);
    addColBtn.appendChild(el("span", { text: "Add Card" }));
    addColBtn.addEventListener("click", async () => {
      const name = await kanbanPrompt(
        "Column name:",
        addColBtn,
        "e.g. In Progress",
        "Create",
      );
      if (!name) return;
      const newRawTitle = name.trim();
      const newParsed = parseBgColor(newRawTitle);
      this.columns.push({
        id: generateId(),
        title: newRawTitle,
        displayTitle: newParsed.displayTitle,
        bgColor: newParsed.bgColor,
        cards: [],
        trailingRaw: [],
      });
      this.saveAndRender();
    });
    board.appendChild(addColBtn);

    // ── Column live reorder on dragover ─────────────────────────────────────
    board.addEventListener("dragover", (e) => {
      if (!this.draggingColId) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";

      const draggingEl = board.querySelector<HTMLElement>(
        `[data-col-id="${this.draggingColId}"]`,
      );
      if (!draggingEl) return;

      const cols = Array.from(
        board.querySelectorAll<HTMLElement>(".kanban-column"),
      ).filter((c) => c !== draggingEl);

      let insertBefore: HTMLElement | null = null;
      for (const c of cols) {
        const rect = c.getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
          insertBefore = c;
          break;
        }
      }

      // Live reorder: move dragging column in DOM immediately
      if (insertBefore) {
        if (draggingEl.nextElementSibling !== insertBefore) {
          board.insertBefore(draggingEl, insertBefore);
        }
      } else {
        // Move to end (before addColBtn)
        if (draggingEl.nextElementSibling !== addColBtn) {
          board.insertBefore(draggingEl, addColBtn);
        }
      }
    });

    board.addEventListener("dragleave", (e) => {
      // Nothing to clean up — no drop indicator used
    });

    board.addEventListener("drop", (e) => {
      const data = e.dataTransfer?.getData("text/plain") ?? "";
      if (!data.startsWith("col:")) return;
      e.preventDefault();

      // DOM is already in correct order from live reorder during dragover
      // Just sync this.columns to match current DOM order
      const allColEls = Array.from(
        board.querySelectorAll<HTMLElement>(".kanban-column"),
      );
      const colMap = new Map(this.columns.map((c) => [c.id, c]));
      this.columns = allColEls
        .map((el) => colMap.get(el.dataset.colId ?? ""))
        .filter(Boolean) as KanbanColumn[];

      this.saveAndRender();
    });
  }

  private renderColumn(
    board: HTMLElement,
    col: KanbanColumn,
    maxHeight: string,
    colWidth: string,
  ) {
    const colEl = div("kanban-column");
    colEl.style.width = colWidth;
    colEl.style.minWidth = colWidth;
    colEl.dataset.colId = col.id; // runtime id — stable even with duplicate titles

    // Apply dynamic bg color if present
    if (col.bgColor) {
      colEl.style.backgroundColor = col.bgColor;
      colEl.style.borderColor = borderColor(col.bgColor);
    }

    const header = div("kanban-column-header");

    // Border color under header: use darken of bg or accent
    if (col.bgColor) {
      header.style.borderBottomColor = headerLineColor(col.bgColor);
    }

    const titleEl = el("span", {
      cls: "kanban-column-title",
      text: col.displayTitle,
    });
    if (col.bgColor) {
      titleEl.style.color = adaptiveForeground(col.bgColor);
    }
    // pointer-events:none so drag events go straight to header (the draggable parent)
    // dblclick is handled on header instead (see below)
    titleEl.style.pointerEvents = "none";

    // dblclick handled on header — titleEl has pointer-events:none

    const badge = el("span", {
      cls: "kanban-count-badge",
      text: String(col.cards.length),
    });
    badge.style.pointerEvents = "none";

    // ── + Add Card button in header ──
    const headerAddBtn = el("button", { cls: "kanban-header-add-btn" });
    headerAddBtn.title = "Add card";
    si(headerAddBtn, "plus");

    // Apply adaptive foreground to all header icon buttons when column has bgColor
    if (col.bgColor) {
      const fg = adaptiveForeground(col.bgColor);
      headerAddBtn.style.setProperty("color", fg, "important");
    }

    // ── Header drag — entire header is drag handle ──────────────────────────
    // header.draggable = true permanently so browser can start drag from any child.
    // We distinguish click vs drag in dragstart by checking mouse travel distance.
    header.draggable = true;
    let headerMouseDownX = 0;
    let headerMouseDownY = 0;
    let headerDragStarted = false;

    // Track mousedown position — works even when target is a child span
    header.addEventListener("mousedown", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("button,input,a")) return;
      headerMouseDownX = e.clientX;
      headerMouseDownY = e.clientY;
      headerDragStarted = false;
    });

    header.addEventListener("dragstart", (e: DragEvent) => {
      // Ignore if started from a button/input/link
      if ((e.target as HTMLElement).closest("button,input,a")) {
        e.preventDefault();
        return;
      }
      headerDragStarted = true;
      this.draggingColId = col.id;
      colEl.classList.add("kanban-col-dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", "col:" + col.id);
      // Transparent drag image — column stays visible during live reorder
      const ghost = document.createElement("div");
      ghost.style.cssText =
        "position:fixed;top:-9999px;width:1px;height:1px;opacity:0";
      document.body.appendChild(ghost);
      e.dataTransfer!.setDragImage(ghost, 0, 0);
      setTimeout(() => ghost.remove(), 0);
    });

    header.addEventListener("dragend", () => {
      header.draggable = true;
      headerDragStarted = false;
      colEl.classList.remove("kanban-col-dragging");
      this.draggingColId = null;
    });

    // ── Double-click on header → rename panel ───────────────────────────────
    header.addEventListener("dblclick", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("button,input,a")) return;
      if (headerDragStarted) return;
      doEditTitle();
    });

    // ── Column options button (⋯) — replaces grip ────────────────────────────
    const gripBtn = el("button", { cls: "kanban-grip-btn" });
    gripBtn.title = "Column options";
    si(gripBtn, "more-horizontal");
    if (col.bgColor) {
      const fg = adaptiveForeground(col.bgColor);
      gripBtn.style.setProperty("color", fg, "important");
    }

    // ── Column dropdown menu ──────────────────────────────────────────────────
    let colMenuEl: HTMLElement | null = null;
    const closeColMenu = () => {
      colMenuEl?.remove();
      colMenuEl = null;
    };

    // colorPicker created per-menu-open inside gripBtn click, appended to colMenuEl

    // ── Column options dropdown ───────────────────────────────────────────────

    const doEditTitle = () => {
      closeColMenu();
      colEl.querySelector(".kanban-rename-panel")?.remove();
      const panel = div("kanban-rename-panel");
      panel.style.background = col.bgColor || "var(--background-secondary)";
      const input = el("input", {
        cls: "kanban-rename-input",
      }) as HTMLInputElement;
      input.value = col.displayTitle;
      input.placeholder = "Column name...";
      const doneBtn = el("button", {
        cls: "kanban-rename-done-btn",
        text: "Done",
      });
      const doneIconEl = el("span", { cls: "kanban-rename-done-icon" });
      si(doneIconEl, "corner-down-left");
      doneBtn.appendChild(doneIconEl);
      panel.appendChild(input);
      panel.appendChild(doneBtn);
      const headerRect = header.getBoundingClientRect();
      const colRect = colEl.getBoundingClientRect();
      panel.style.top = headerRect.bottom - colRect.top + "px";
      colEl.appendChild(panel);
      input.focus();
      input.select();
      const finish = () => {
        const newName = input.value.trim();
        if (!newName) {
          input.classList.add("kanban-modal-input-error");
          input.focus();
          return;
        }
        panel.remove();
        const bgTag = col.title.match(BG_TAG_RE);
        col.title = bgTag ? `${newName} ${bgTag[0]}` : newName;
        const parsed = parseBgColor(col.title);
        col.displayTitle = parsed.displayTitle || "Untitled";
        col.bgColor = parsed.bgColor;
        this.saveAndRender();
      };
      input.addEventListener("input", () =>
        input.classList.remove("kanban-modal-input-error"),
      );
      doneBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        finish();
      });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          panel.remove();
        }
      });
      setTimeout(() => {
        const onOut = (e: MouseEvent) => {
          if (!panel.contains(e.target as Node)) {
            panel.remove();
            document.removeEventListener("mousedown", onOut, true);
          }
        };
        document.addEventListener("mousedown", onOut, true);
      }, 0);
    };

    gripBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (colMenuEl) {
        closeColMenu();
        return;
      }
      colMenuEl = div("kanban-card-dropdown");

      const mkItem = (iconName: string, label: string, danger = false) => {
        const item = div(
          "kanban-dropdown-item" + (danger ? " kanban-dropdown-danger" : ""),
        );
        const iconEl = el("span", { cls: "kanban-dropdown-icon" });
        si(iconEl, iconName);
        item.appendChild(iconEl);
        item.appendChild(el("span", { text: label }));
        return item;
      };
      const mkSep = () => {
        const s = div("kanban-dropdown-sep");
        return s;
      };

      // Add Card
      const addCardItem = mkItem("plus", "Add Card");
      addCardItem.addEventListener("click", (e) => {
        e.stopPropagation();
        closeColMenu();
        this.showAddCardInput(cardsEl, col);
      });
      colMenuEl.appendChild(addCardItem);

      colMenuEl.appendChild(mkSep());

      // Edit Title
      const editItem = mkItem("pencil", "Edit Title");
      editItem.addEventListener("click", (e) => {
        e.stopPropagation();
        doEditTitle();
      });
      colMenuEl.appendChild(editItem);

      // Delete Column
      const delItem = mkItem("trash-2", "Delete Column", true);
      delItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        closeColMenu();
        const confirmed = await kanbanConfirm(
          `Delete "${col.displayTitle}" and all its cards?`,
          colEl,
        );
        if (!confirmed) return;
        this.columns = this.columns.filter((c) => c !== col);
        this.saveAndRender();
      });
      colMenuEl.appendChild(delItem);

      // ── separator ──
      colMenuEl.appendChild(mkSep());

      // Change Color — swatch shows current color
      const colorItem = div("kanban-dropdown-item kanban-dropdown-color-item");
      const colorIconEl = el("span", { cls: "kanban-dropdown-icon" });
      si(colorIconEl, "palette");
      const colorItemSwatch = div("kanban-dropdown-color-swatch");
      colorItemSwatch.style.background = col.bgColor || "transparent";
      colorItemSwatch.style.border = col.bgColor
        ? "none"
        : "1px dashed var(--text-muted)";
      colorItem.appendChild(colorIconEl);
      colorItem.appendChild(el("span", { text: "Change Color" }));
      colorItem.appendChild(colorItemSwatch);
      // ── color picker appended INSIDE colMenuEl so it's never "outside" ─────
      const colorPicker = el("input", {
        attr: { type: "color" },
      }) as HTMLInputElement;
      colorPicker.className = "kanban-color-picker-input";
      colorPicker.value = col.bgColor || "#ffffff";
      colMenuEl.appendChild(colorPicker);
      // Position picker at right edge of dropdown after menu is mounted
      const positionPicker = () => {
        const menuRect = colMenuEl!.getBoundingClientRect();
        const spaceRight = window.innerWidth - menuRect.right;
        if (spaceRight >= 20) {
          // Enough space on right — place picker at right edge of dropdown, vertically at colorItem
          colorPicker.style.position = "fixed";
          colorPicker.style.left = menuRect.right + "px";
          colorPicker.style.top = menuRect.top + menuRect.height / 2 + "px";
          colorPicker.style.width = "1px";
          colorPicker.style.height = "1px";
        } else {
          // Not enough space — place at left edge so picker opens to the left
          colorPicker.style.position = "fixed";
          colorPicker.style.left = menuRect.left + "px";
          colorPicker.style.top = menuRect.top + menuRect.height / 2 + "px";
          colorPicker.style.width = "1px";
          colorPicker.style.height = "1px";
        }
      };
      colorPicker.addEventListener("change", () => {
        const newColor = colorPicker.value;
        col.title = col.bgColor
          ? col.title.replace(BG_TAG_RE, `[bg:${newColor}]`)
          : `${col.displayTitle} [bg:${newColor}]`;
        const parsed = parseBgColor(col.title);
        col.displayTitle = parsed.displayTitle || "Untitled";
        col.bgColor = parsed.bgColor;
        closeColMenu();
        this.saveAndRender();
      });

      colorItem.addEventListener("click", (e) => {
        e.stopPropagation();
        colorPicker.click();
      });
      colMenuEl.appendChild(colorItem);

      // Remove Color — only shown if column has a color
      if (col.bgColor) {
        const removeColorItem = mkItem("x-circle", "Remove Color");
        removeColorItem.addEventListener("click", (e) => {
          e.stopPropagation();
          closeColMenu();
          col.title = col.title.replace(BG_TAG_RE, "").trim();
          const parsed = parseBgColor(col.title);
          col.displayTitle = parsed.displayTitle || "Untitled";
          col.bgColor = parsed.bgColor;
          this.saveAndRender();
        });
        colMenuEl.appendChild(removeColorItem);
      }

      // Position dropdown
      colMenuEl.style.position = "fixed";
      document.body.appendChild(colMenuEl);
      const btnRect = gripBtn.getBoundingClientRect();
      colMenuEl.style.top = btnRect.bottom + 4 + "px";
      colMenuEl.style.left = btnRect.left + "px";
      colMenuEl.style.right = "auto";

      // Clamp to viewport, then position color picker
      requestAnimationFrame(() => {
        const r = colMenuEl!.getBoundingClientRect();
        if (r.right > window.innerWidth)
          colMenuEl!.style.left = btnRect.right - r.width + "px";
        positionPicker();
      });

      // Use mousedown (not click) — Electron native picker doesn't fire click on backdrop
      const onOutside = (ev: MouseEvent) => {
        if (!colMenuEl?.contains(ev.target as Node)) {
          closeColMenu();
          document.removeEventListener("mousedown", onOutside, true);
          document.removeEventListener("keydown", onEsc, true);
        }
      };
      const onEsc = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeColMenu();
          document.removeEventListener("mousedown", onOutside, true);
          document.removeEventListener("keydown", onEsc, true);
        }
      };
      setTimeout(() => {
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onEsc, true);
      }, 0);
    });

    const headerSpacer = div("kanban-header-spacer");
    header.appendChild(titleEl);
    header.appendChild(badge);
    header.appendChild(headerSpacer);
    header.appendChild(headerAddBtn);
    header.appendChild(gripBtn);
    colEl.appendChild(header);

    const cardsWrapper = div("kanban-cards-wrapper");
    const cardsEl = div("kanban-cards");
    cardsEl.dataset.colTitle = col.title;
    cardsEl.style.maxHeight = maxHeight;
    cardsEl.style.overflowY = "auto";

    for (const card of col.cards) {
      this.renderCard(cardsEl, card, col);
    }

    // ── Drop indicator line (shared, one per cards container) ──
    const dropIndicator = div("kanban-drop-indicator");
    cardsEl.appendChild(dropIndicator);

    const clearIndicator = () => {
      dropIndicator.style.display = "none";
      dropIndicator.dataset.beforeId = "";
    };
    clearIndicator();

    // Returns the card element we're hovering above (or null = append at end)
    const getDropTarget = (clientY: number): HTMLElement | null => {
      const cards = Array.from(
        cardsEl.querySelectorAll<HTMLElement>(
          ".kanban-card:not(.kanban-dragging)",
        ),
      );
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (clientY < mid) return card;
      }
      return null;
    };

    cardsEl.addEventListener("dragover", (e) => {
      if (this.draggingColId) return; // column drag in progress — ignore card indicator
      e.preventDefault();
      const target = getDropTarget(e.clientY);
      if (target) {
        // Show line above target card
        dropIndicator.dataset.beforeId = target.dataset.cardId ?? "";
        target.parentElement!.insertBefore(dropIndicator, target);
      } else {
        // Show line at end (before add-card button / after last card)
        dropIndicator.dataset.beforeId = "";
        cardsEl.appendChild(dropIndicator);
      }
      dropIndicator.style.display = "block";
    });

    cardsEl.addEventListener("dragleave", (e) => {
      if (this.draggingColId) return;
      if (!cardsEl.contains(e.relatedTarget as Node)) clearIndicator();
    });

    cardsEl.addEventListener("drop", (e) => {
      if (this.draggingColId) return;
      e.preventDefault();
      const cardId = e.dataTransfer?.getData("text/plain");
      // Read beforeId BEFORE calling clearIndicator — it wipes dataset.beforeId
      const beforeId = dropIndicator.dataset.beforeId;
      clearIndicator();
      if (!cardId) return;
      let targetIndex: number;
      if (beforeId) {
        targetIndex = col.cards.findIndex((c) => c.id === beforeId);
        if (targetIndex < 0) targetIndex = col.cards.length;
      } else {
        targetIndex = col.cards.length;
      }
      this.insertCardAt(cardId, col, targetIndex);
    });

    cardsWrapper.appendChild(cardsEl);
    colEl.appendChild(cardsWrapper);

    // ── Scroll shadow indicator ──
    const updateShadow = () => {
      const overflows = cardsEl.scrollHeight > cardsEl.clientHeight + 2;
      const atBottom =
        cardsEl.scrollHeight - cardsEl.scrollTop - cardsEl.clientHeight < 4;
      if (overflows && !atBottom) {
        cardsWrapper.classList.add("kanban-cards-shadow");
      } else {
        cardsWrapper.classList.remove("kanban-cards-shadow");
      }
    };
    // Check after DOM settles
    requestAnimationFrame(updateShadow);
    cardsEl.addEventListener("scroll", updateShadow);

    headerAddBtn.addEventListener("click", () => {
      this.showAddCardInput(cardsEl, col);
    });

    const addCardBtn = el("button", { cls: "kanban-add-card-btn" });
    const addCardIcon = el("span", { cls: "kanban-add-card-icon" });
    si(addCardIcon, "plus");
    addCardBtn.appendChild(addCardIcon);
    addCardBtn.appendChild(el("span", { text: "Add Card" }));
    addCardBtn.addEventListener("click", () =>
      this.showAddCardInput(cardsEl, col),
    );
    colEl.appendChild(addCardBtn);

    board.appendChild(colEl);
  }

  private renderCard(
    cardsEl: HTMLElement,
    card: KanbanCard,
    col: KanbanColumn,
  ) {
    const cardEl = div("kanban-card");
    cardEl.draggable = true;
    cardEl.dataset.cardId = card.id;

    cardEl.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData("text/plain", card.id);
      // Delay adding class so drag image captures the normal card look
      setTimeout(() => cardEl.classList.add("kanban-dragging"), 0);
    });
    cardEl.addEventListener("dragend", () => {
      cardEl.classList.remove("kanban-dragging");
      // Clean up any lingering drop indicators across all columns
      document.querySelectorAll(".kanban-drop-indicator").forEach((el) => {
        (el as HTMLElement).style.display = "none";
      });
    });

    const textEl = el("span", { cls: "kanban-card-text" });
    const wikilinkTarget = extractWikilink(card.text);
    if (wikilinkTarget) {
      // Resolve file — pages folder first, then legacy fallback
      const resolveWikiFile = () => {
        const kf = getFolderPath(this.ctx.sourcePath);
        const sub = parsePagesFolder(this.source);
        const pf = kf ? `${kf}/${sub}` : sub;
        const inPages = this.obsApp.vault.getFileByPath(
          `${pf}/${wikilinkTarget}.md`,
        );
        if (inPages) return inPages;
        const legacy = kf
          ? `${kf}/${wikilinkTarget}.md`
          : `${wikilinkTarget}.md`;
        return this.obsApp.vault.getFileByPath(legacy);
      };

      const fileExists = !!resolveWikiFile();

      if (fileExists) {
        // ── File exists — render as normal clickable link ──────────────────
        const linkEl = el("a", {
          cls: "kanban-card-link",
          text: wikilinkTarget,
        });
        linkEl.title = `Open: ${wikilinkTarget}`;
        linkEl.addEventListener("click", (e) => {
          e.stopPropagation();
          const file = resolveWikiFile();
          if (file) {
            const leaf = this.obsApp.workspace.getLeaf("split");
            leaf.openFile(file);
          }
        });
        textEl.appendChild(linkEl);
      } else {
        // ── File does not exist — render as ghost link with + badge ────────
        // Pill wrapper: [📄 FileName +]
        const ghostPill = el("span", { cls: "kanban-ghost-pill" });
        ghostPill.title = `Create page: ${wikilinkTarget}`;

        const ghostIcon = el("span", { cls: "kanban-ghost-icon" });
        si(ghostIcon, "file-plus");
        const ghostName = el("span", {
          cls: "kanban-ghost-name",
          text: wikilinkTarget,
        });
        const ghostBadge = el("span", { cls: "kanban-ghost-badge" });
        si(ghostBadge, "plus");
        ghostBadge.title = `Create: ${wikilinkTarget}`;

        ghostPill.appendChild(ghostIcon);
        ghostPill.appendChild(ghostName);
        ghostPill.appendChild(ghostBadge);

        const createPage = async (e: MouseEvent) => {
          e.stopPropagation();
          const kf = getFolderPath(this.ctx.sourcePath);
          const sub = parsePagesFolder(this.source);
          const pagesFolder = kf ? `${kf}/${sub}` : sub;
          if (!this.obsApp.vault.getAbstractFileByPath(pagesFolder)) {
            await this.obsApp.vault.createFolder(pagesFolder);
          }
          const filePath = `${pagesFolder}/${wikilinkTarget}.md`;
          await this.obsApp.vault.create(filePath, `# ${wikilinkTarget}\n`);
          const newFile = this.obsApp.vault.getFileByPath(filePath);
          if (newFile) {
            const leaf = this.obsApp.workspace.getLeaf("split");
            leaf.openFile(newFile);
          }
          this.render();
        };

        ghostPill.addEventListener("click", createPage);
        textEl.appendChild(ghostPill);
      }

      // Render remaining tags after the link
      const afterLink = card.text.slice(card.text.indexOf("]]") + 2).trim();
      if (afterLink) {
        const rest = document.createTextNode(
          " " + afterLink.replace(/#[\w-]+/g, "").trim(),
        );
        textEl.appendChild(rest);
      }
    } else {
      textEl.textContent = card.text.replace(/#[\w-]+/g, "").trim();
    }
    cardEl.appendChild(textEl);

    if (card.tags.length > 0) {
      const tagsEl = div("kanban-card-tags");
      for (const tag of card.tags) {
        const tagEl = el("span", { cls: "kanban-tag", text: tag });
        tagEl.style.backgroundColor = getTagColor(tag);
        tagsEl.appendChild(tagEl);
      }
      cardEl.appendChild(tagsEl);
    }

    // ── Single ⋯ menu button ─────────────────────────────────────────────────
    const menuBtn = el("button", { cls: "kanban-card-menu-btn" });
    si(menuBtn, "more-horizontal");
    menuBtn.title = "Card options";

    // ── Helpers ──────────────────────────────────────────────────────────────
    // Full path to the _kanban-notes (or custom) folder for this kanban file
    const getPagesFolder = () => {
      const kanbanFolder = getFolderPath(this.ctx.sourcePath);
      const subFolder = parsePagesFolder(this.source);
      return kanbanFolder ? `${kanbanFolder}/${subFolder}` : subFolder;
    };

    const getLinkedFile = () => {
      const wt = extractWikilink(card.text);
      if (!wt) return null;
      // Check pages folder first, then fallback to kanban folder (legacy)
      const pagesFolder = getPagesFolder();
      const inPages = this.obsApp.vault.getFileByPath(
        `${pagesFolder}/${wt}.md`,
      );
      if (inPages) return inPages;
      const kanbanFolder = getFolderPath(this.ctx.sourcePath);
      const legacy = kanbanFolder ? `${kanbanFolder}/${wt}.md` : `${wt}.md`;
      return this.obsApp.vault.getFileByPath(legacy);
    };

    // ── Action handlers ───────────────────────────────────────────────────────
    const doEdit = () => {
      closeMenu();
      const textarea = el("textarea", {
        cls: "kanban-card-edit-input",
      }) as HTMLTextAreaElement;
      textarea.value = card.text;
      cardEl.innerHTML = "";
      cardEl.appendChild(textarea);
      textarea.focus();
      const finish = () => {
        const newText = textarea.value.trim();
        if (newText) {
          card.text = newText;
          card.tags = newText.match(/#[\w-]+/g) || [];
        }
        this.saveAndRender();
      };
      textarea.addEventListener("blur", finish);
      textarea.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          finish();
        }
        if (ev.key === "Escape") this.render();
      });
    };

    const doDelete = async () => {
      closeMenu();
      const linkedFile = getLinkedFile();
      if (linkedFile) {
        const wt = extractWikilink(card.text)!;

        // Find other cards in any column that link to the same page
        const otherRefs: { colTitle: string; cardText: string }[] = [];
        for (const c of this.columns) {
          for (const cd of c.cards) {
            if (cd.id === card.id) continue;
            if (extractWikilink(cd.text) === wt) {
              // Show plain text preview — strip wikilinks/tags, max 40 chars
              const preview =
                cd.text
                  .replace(/\[\[[^\]]+\]\]/g, "")
                  .replace(/#[\w-]+/g, "")
                  .trim() || wt;
              const short =
                preview.length > 40 ? preview.slice(0, 40) + "…" : preview;
              otherRefs.push({ colTitle: c.displayTitle, cardText: short });
            }
          }
        }

        let msg = `Delete card and its linked page "${wt}.md"?`;
        if (otherRefs.length > 0) {
          const lines = otherRefs
            .map((r) => `  • "${r.colTitle}" → ${r.cardText}`)
            .join("\n");
          msg += `\n\n⚠️ Also linked by:\n${lines}`;
        }

        const confirmed = await kanbanConfirm(msg, cardEl);
        if (!confirmed) return;
        await this.obsApp.vault.trash(linkedFile, true);
      }
      col.cards = col.cards.filter((c) => c.id !== card.id);
      this.saveAndRender();
    };

    const doConvertToPage = async () => {
      closeMenu();

      // Split card text by literal \n (our encoding) OR real newline — handle both
      const lines = card.text
        .split(/\\n|\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const firstLine = lines[0] || "";
      const restLines = lines.slice(1);

      // Build filename from first line
      const filename = firstLine
        .replace(/#[\w-]+/g, "")
        .replace(/[\\/:*?"<>|#^\[\]]/g, "")
        .trim();
      if (!filename) return;

      // Ensure pages folder exists
      const pagesFolder = getPagesFolder();
      if (!this.obsApp.vault.getAbstractFileByPath(pagesFolder)) {
        await this.obsApp.vault.createFolder(pagesFolder);
      }

      const filePath = `${pagesFolder}/${filename}.md`;
      const pageExists = !!this.obsApp.vault.getFileByPath(filePath);

      // Always warn user if page already exists
      if (pageExists) {
        const msg =
          restLines.length > 0
            ? `"${filename}" already exists. The extra lines will be discarded. Continue?`
            : `"${filename}" already exists. The card will link to it. Continue?`;
        const confirmed = await kanbanConfirm(msg, menuBtn, "Continue", false);
        if (!confirmed) return;
      }

      // Create file only if it doesn't exist yet
      if (!pageExists) {
        const pageContent =
          restLines.length > 0
            ? `# ${filename}\n\n${restLines.join("\n")}\n`
            : `# ${filename}\n`;
        await this.obsApp.vault.create(filePath, pageContent);
      }

      // Card becomes just [[link]] — rest of lines go into page content
      const tags = (card.text.match(/#[\w-]+/g) || []).join(" ");
      card.text = tags ? `[[${filename}]] ${tags}` : `[[${filename}]]`;
      card.tags = card.text.match(/#[\w-]+/g) || [];
      await this.saveAndRender();
    };

    const doRename = async () => {
      closeMenu();
      const linkedFile = getLinkedFile();
      if (!linkedFile) return;
      const currentName = linkedFile.name.replace(/\.md$/, "");
      const folder = getFolderPath(linkedFile.path); // keep file in its current folder

      const newName = await kanbanPrompt(
        "Rename page:",
        menuBtn,
        currentName,
        "Rename",
        (value) => {
          if (value === currentName) return null; // same name is fine — will no-op below
          const newPath = folder ? `${folder}/${value}.md` : `${value}.md`;
          if (this.obsApp.vault.getFileByPath(newPath)) {
            return `"${value}.md" already exists. Choose a different name.`;
          }
          return null;
        },
      );

      if (!newName || newName === currentName) return;
      const newPath = folder ? `${folder}/${newName}.md` : `${newName}.md`;

      try {
        await this.obsApp.vault.rename(linkedFile, newPath);
      } catch (err) {
        await kanbanAlert(`Rename failed: ${(err as Error).message}`, menuBtn);
        return;
      }

      // Update card text to new name, preserving tags
      const tags = (card.text.match(/#[\w-]+/g) || []).join(" ");
      card.text = tags ? `[[${newName}]] ${tags}` : `[[${newName}]]`;
      card.tags = card.text.match(/#[\w-]+/g) || [];
      await this.saveAndRender();
    };

    const doOpenLeaf = (mode: "tab" | "split" | "window") => {
      closeMenu();
      const file = getLinkedFile();
      if (!file) return;
      this.obsApp.workspace.getLeaf(mode).openFile(file);
    };

    // ── Dropdown menu ─────────────────────────────────────────────────────────
    let menuEl: HTMLElement | null = null;
    const closeMenu = () => {
      menuEl?.remove();
      menuEl = null;
    };

    const openMenu = (e: MouseEvent) => {
      e.stopPropagation();
      if (menuEl) {
        closeMenu();
        return;
      }

      menuEl = div("kanban-card-dropdown");
      const wikilinkText = extractWikilink(card.text);
      const isWikilink = !!wikilinkText;
      const linkedFileExists = isWikilink && !!getLinkedFile();

      const mkItem = (iconName: string, label: string, cls = "") => {
        const item = div("kanban-dropdown-item" + (cls ? " " + cls : ""));
        const iconEl = el("span", { cls: "kanban-dropdown-icon" });
        si(iconEl, iconName);
        item.appendChild(iconEl);
        item.appendChild(el("span", { text: label }));
        return item;
      };
      const mkSep = () => div("kanban-dropdown-sep");

      if (isWikilink && linkedFileExists) {
        // ── Wikilink card — file EXISTS ──
        const tabItem = mkItem("folder-open", "Open in New Tab");
        tabItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("tab");
        });
        menuEl.appendChild(tabItem);

        const rightItem = mkItem("panel-right-open", "Open to the Right");
        rightItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("split");
        });
        menuEl.appendChild(rightItem);

        const winItem = mkItem("picture-in-picture-2", "Open in New Window");
        winItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("window");
        });
        menuEl.appendChild(winItem);

        menuEl.appendChild(mkSep());

        const renameItem = mkItem("pencil", "Rename");
        renameItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doRename();
        });
        menuEl.appendChild(renameItem);

        const delItem = mkItem("trash-2", "Delete", "kanban-dropdown-danger");
        delItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doDelete();
        });
        menuEl.appendChild(delItem);
      } else if (isWikilink && !linkedFileExists) {
        // ── Wikilink card — file DOES NOT EXIST ──
        const createItem = mkItem("file-plus", "Create Page");
        createItem.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          const kf = getFolderPath(this.ctx.sourcePath);
          const sub = parsePagesFolder(this.source);
          const pagesFolder = kf ? `${kf}/${sub}` : sub;
          (async () => {
            if (!this.obsApp.vault.getAbstractFileByPath(pagesFolder)) {
              await this.obsApp.vault.createFolder(pagesFolder);
            }
            const filePath = `${pagesFolder}/${wikilinkText}.md`;
            await this.obsApp.vault.create(filePath, `# ${wikilinkText}\n`);
            const newFile = this.obsApp.vault.getFileByPath(filePath);
            if (newFile) {
              const leaf = this.obsApp.workspace.getLeaf("split");
              leaf.openFile(newFile);
            }
            this.render();
          })();
        });
        menuEl.appendChild(createItem);

        menuEl.appendChild(mkSep());

        const editItem = mkItem("pencil", "Edit");
        editItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doEdit();
        });
        menuEl.appendChild(editItem);

        const delItem = mkItem("trash-2", "Delete", "kanban-dropdown-danger");
        delItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doDelete();
        });
        menuEl.appendChild(delItem);
      } else {
        // ── Plain card ──
        const editItem = mkItem("pencil", "Edit");
        editItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doEdit();
        });
        menuEl.appendChild(editItem);

        const pageItem = mkItem("file-plus", "Convert to Page");
        pageItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doConvertToPage();
        });
        menuEl.appendChild(pageItem);

        const delItem = mkItem("trash-2", "Delete", "kanban-dropdown-danger");
        delItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doDelete();
        });
        menuEl.appendChild(delItem);
      }

      menuEl.style.position = "fixed";
      document.body.appendChild(menuEl);
      const btnRect = menuBtn.getBoundingClientRect();
      menuEl.style.top = btnRect.bottom + 4 + "px";
      menuEl.style.left = "auto";
      menuEl.style.right = window.innerWidth - btnRect.right + "px";

      const onOutside = (ev: MouseEvent) => {
        if (!menuEl?.contains(ev.target as Node)) {
          closeMenu();
          document.removeEventListener("click", onOutside, true);
          document.removeEventListener("keydown", onEsc, true);
        }
      };
      const onEsc = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeMenu();
          document.removeEventListener("click", onOutside, true);
          document.removeEventListener("keydown", onEsc, true);
        }
      };
      setTimeout(() => {
        document.addEventListener("click", onOutside, true);
        document.addEventListener("keydown", onEsc, true);
      }, 0);
    };

    // ── Quick edit/rename button (pencil) — visible on hover like menuBtn ──────
    const isWikilinkCard = !!extractWikilink(card.text);
    const quickEditBtn = el("button", { cls: "kanban-card-quick-edit-btn" });
    si(quickEditBtn, "pencil");
    quickEditBtn.title = isWikilinkCard ? "Rename page" : "Edit card";
    quickEditBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isWikilinkCard) {
        doRename();
      } else {
        doEdit();
      }
    });

    menuBtn.addEventListener("click", openMenu);
    cardEl.appendChild(quickEditBtn);
    cardEl.appendChild(menuBtn);
    cardsEl.appendChild(cardEl);
  }

  private showAddCardInput(cardsEl: HTMLElement, col: KanbanColumn) {
    const wrapper = div("kanban-add-input-wrapper");
    const textarea = el("textarea", {
      cls: "kanban-add-card-input",
      attr: {
        placeholder:
          "Card text... gunakan #tag\n(Enter simpan, Shift+Enter baris baru)",
      },
    }) as HTMLTextAreaElement;
    const actionsEl = div("kanban-add-input-actions");
    const saveBtn = el("button", { cls: "kanban-save-btn", text: "Add" });
    const cancelBtn = el("button", {
      cls: "kanban-cancel-btn",
      text: "Cancel",
    });
    actionsEl.appendChild(saveBtn);
    actionsEl.appendChild(cancelBtn);
    wrapper.appendChild(textarea);
    wrapper.appendChild(actionsEl);
    cardsEl.prepend(wrapper);
    textarea.focus();

    const save = () => {
      const text = textarea.value.trim();
      if (text) {
        col.cards.unshift({
          id: generateId(),
          text,
          tags: text.match(/#[\w-]+/g) || [],
        });
        this.saveAndRender();
      } else {
        wrapper.remove();
      }
    };

    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", () => wrapper.remove());
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") wrapper.remove();
    });
  }

  private applySearch(query: string, board: HTMLElement) {
    const q = query.trim().toLowerCase();
    const columns = board.querySelectorAll(".kanban-column");

    columns.forEach((colEl) => {
      const cards = colEl.querySelectorAll<HTMLElement>(".kanban-card");
      let visibleCount = 0;

      cards.forEach((cardEl) => {
        const textEl = cardEl.querySelector(
          ".kanban-card-text",
        ) as HTMLElement | null;
        if (!textEl) return;

        // Always strip highlight first — read plain text from dataset (source of truth)
        // We store the original plain text in a data attribute on first encounter
        if (!cardEl.dataset.plainText) {
          cardEl.dataset.plainText = textEl.textContent ?? "";
        }
        const plainText = cardEl.dataset.plainText;

        const tags = Array.from(cardEl.querySelectorAll(".kanban-tag"))
          .map((t) => t.textContent?.toLowerCase() ?? "")
          .join(" ");
        const matches =
          !q || plainText.toLowerCase().includes(q) || tags.includes(q);

        cardEl.style.display = matches ? "" : "none";

        if (matches && q) {
          const regex = new RegExp(`(${escapeRegex(q)})`, "gi");
          const linkEl = textEl.querySelector<HTMLElement>(".kanban-card-link");
          if (linkEl) {
            // Card is a wikilink — highlight only inside the <a> text node,
            // never replace innerHTML of textEl (that would destroy the <a> element)
            if (!linkEl.dataset.plainLinkText) {
              linkEl.dataset.plainLinkText = linkEl.textContent ?? "";
            }
            linkEl.innerHTML = linkEl.dataset.plainLinkText.replace(
              regex,
              '<mark class="kanban-highlight">$1</mark>',
            );
          } else {
            // Plain card — safe to replace full innerHTML
            textEl.innerHTML = plainText.replace(
              regex,
              '<mark class="kanban-highlight">$1</mark>',
            );
          }
        } else {
          // Restore: strip all highlights cleanly
          const linkEl = textEl.querySelector<HTMLElement>(".kanban-card-link");
          if (linkEl && linkEl.dataset.plainLinkText) {
            // Restore <a> text without destroying the element
            linkEl.textContent = linkEl.dataset.plainLinkText;
          } else {
            textEl.textContent = plainText;
          }
        }

        if (matches) visibleCount++;
      });

      // Show/hide empty-state message per column
      let emptyMsg = colEl.querySelector<HTMLElement>(".kanban-search-empty");
      if (q && visibleCount === 0) {
        if (!emptyMsg) {
          emptyMsg = div("kanban-search-empty");
          emptyMsg.textContent = "No results";
          const cardsContainer = colEl.querySelector(".kanban-cards");
          cardsContainer?.appendChild(emptyMsg);
        }
        emptyMsg.style.display = "";
      } else if (emptyMsg) {
        emptyMsg.style.display = "none";
      }
    });
  }

  // Insert dragged card into targetCol at targetIndex (-1 = append at end)
  private insertCardAt(
    cardId: string,
    targetCol: KanbanColumn,
    targetIndex: number,
  ) {
    let movedCard: KanbanCard | undefined;
    for (const col of this.columns) {
      const idx = col.cards.findIndex((c) => c.id === cardId);
      if (idx !== -1) {
        movedCard = col.cards.splice(idx, 1)[0];
        break;
      }
    }
    if (!movedCard) return;
    if (targetIndex < 0 || targetIndex >= targetCol.cards.length) {
      targetCol.cards.push(movedCard);
    } else {
      targetCol.cards.splice(targetIndex, 0, movedCard);
    }
    this.saveAndRender();
  }

  private showBoardContextMenu(e: MouseEvent) {
    // Remove any existing context menu
    document.querySelector(".kanban-ctx-menu")?.remove();

    const menu = document.createElement("div");
    menu.className = "kanban-ctx-menu";

    const mkItem = (iconName: string, label: string, cls = "") => {
      const item = document.createElement("div");
      item.className = "kanban-ctx-item" + (cls ? " " + cls : "");
      const iconEl = document.createElement("span");
      iconEl.className = "kanban-ctx-icon";
      si(iconEl, iconName);
      item.appendChild(iconEl);
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      item.appendChild(labelEl);
      return item;
    };
    const mkSep = () => {
      const s = document.createElement("div");
      s.className = "kanban-ctx-sep";
      return s;
    };

    // ── Add Column ────────────────────────────────────────────────────────────
    const addColItem = mkItem("plus-circle", "Add Column");
    addColItem.addEventListener("click", async () => {
      menu.remove();
      const addColBtn = this.boardScrollEl?.querySelector<HTMLElement>(
        ".kanban-add-col-btn",
      );
      const anchor = addColBtn ?? this.containerEl;
      const name = await kanbanPrompt(
        "Column name:",
        anchor as HTMLElement,
        "e.g. In Progress",
        "Create",
      );
      if (!name) return;
      const newParsed = parseBgColor(name.trim());
      this.columns.push({
        id: generateId(),
        title: name.trim(),
        displayTitle: newParsed.displayTitle,
        bgColor: newParsed.bgColor,
        cards: [],
        trailingRaw: [],
      });
      this.saveAndRender();
    });
    menu.appendChild(addColItem);

    menu.appendChild(mkSep());

    // ── Edit Directives ───────────────────────────────────────────────────────
    const editDirItem = mkItem("settings", "Edit Directives");
    editDirItem.addEventListener("click", () => {
      menu.remove();
      this.showDirectivesModal();
    });
    menu.appendChild(editDirItem);

    menu.appendChild(mkSep());

    // ── Copy Source ───────────────────────────────────────────────────────────
    const copyItem = mkItem("clipboard", "Copy Board Source");
    copyItem.addEventListener("click", () => {
      menu.remove();
      navigator.clipboard
        .writeText("```kanban\n" + this.source + "\n```")
        .catch(() => {});
    });
    menu.appendChild(copyItem);

    // Position and show
    menu.style.position = "fixed";
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    document.body.appendChild(menu);

    // Clamp to viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth)
        menu.style.left = e.clientX - rect.width + "px";
      if (rect.bottom > window.innerHeight)
        menu.style.top = e.clientY - rect.height + "px";
    });

    // Dismiss on outside click
    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("click", dismiss, true);
      }
    };
    setTimeout(() => document.addEventListener("click", dismiss, true), 0);
  }

  private showDirectivesModal() {
    // Parse current values
    const curMaxHeight = parseMaxHeight(this.source);
    const curColWidth = parseColWidth(this.source);
    const curPagesFolder = parsePagesFolder(this.source);

    // Build modal
    const backdrop = document.createElement("div");
    backdrop.className = "kanban-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "kanban-modal";
    modal.style.minWidth = "280px";
    modal.style.maxWidth = "360px";

    const title = document.createElement("p");
    title.className = "kanban-modal-msg";
    title.style.fontWeight = "600";
    title.style.fontSize = "1em";
    title.textContent = "Board Directives";
    modal.appendChild(title);

    const mkField = (label: string, value: string, placeholder: string) => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
      const lbl = document.createElement("label");
      lbl.textContent = label;
      lbl.style.cssText =
        "font-size:.8em;color:var(--text-muted);font-weight:500";
      const inp = document.createElement("input");
      inp.className = "kanban-modal-input";
      inp.value = value;
      inp.placeholder = placeholder;
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      return { wrap, inp };
    };

    const { wrap: mhWrap, inp: mhInp } = mkField(
      "Max Height",
      curMaxHeight,
      "e.g. 400px",
    );
    const { wrap: cwWrap, inp: cwInp } = mkField(
      "Column Width",
      curColWidth,
      "e.g. 240px",
    );
    const { wrap: pfWrap, inp: pfInp } = mkField(
      "Pages Folder",
      curPagesFolder,
      "e.g. _kanban-notes",
    );

    modal.appendChild(mhWrap);
    modal.appendChild(cwWrap);
    modal.appendChild(pfWrap);

    const btnRow = document.createElement("div");
    btnRow.className = "kanban-modal-btns";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-modal-btn-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => backdrop.remove());

    const saveBtn = document.createElement("button");
    saveBtn.className = "kanban-modal-btn-confirm";
    saveBtn.textContent = "Apply";
    saveBtn.addEventListener("click", () => {
      backdrop.remove();
      // Strip all existing directive tokens from source, rebuild header
      let newSource = this.source
        .split("\n")
        .filter(
          (l: string) =>
            !MAX_HEIGHT_RE.test(l.trim()) &&
            !COL_WIDTH_RE.test(l.trim()) &&
            !PAGES_FOLDER_RE.test(l.trim()) &&
            !VERSION_RE.test(l.trim()),
        )
        .join("\n");

      const mh = mhInp.value.trim() || DEFAULT_MAX_HEIGHT;
      const cw = cwInp.value.trim() || DEFAULT_COL_WIDTH;
      const pf = pfInp.value.trim() || DEFAULT_PAGES_FOLDER;
      const newHeader = `[v:${CURRENT_FORMAT_VERSION}][maxHeight:${mh}][columnWidth:${cw}][pagesFolder:${pf}]`;
      newSource = newHeader + "\n" + newSource.trimStart();

      this.source = newSource;
      this.columns = parseKanban(newSource);
      this.saveAndRender();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    modal.appendChild(btnRow);
    backdrop.appendChild(modal);

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    mhInp.focus();
  }

  private async saveAndRender() {
    // Save scroll position to static registry BEFORE vault.modify triggers re-mount
    if (this.boardScrollEl) {
      _scrollRegistry.set(this.scrollKey, this.boardScrollEl.scrollLeft);
    }
    // Preserve the [maxHeight:...] header tag from the current source
    const header = extractSourceHeader(this.source);
    const newSource = serializeKanban(this.columns, header);
    await this.saveToFile(newSource);
    this.source = newSource;
    this.render();
  }

  private async saveToFile(newSource: string) {
    const file = this.obsApp.vault.getFileByPath(this.ctx.sourcePath);
    if (!file) return;
    const content = await this.obsApp.vault.read(file);
    const sectionInfo = this.ctx.getSectionInfo(this.containerEl);
    if (sectionInfo) {
      const lines = content.split("\n");
      const before = lines.slice(0, sectionInfo.lineStart + 1).join("\n");
      const after = lines.slice(sectionInfo.lineEnd).join("\n");
      await this.obsApp.vault.modify(
        file,
        before + "\n" + newSource + "\n" + after,
      );
    } else {
      const newContent = content.replace(
        /```kanban\n[\s\S]*?```/,
        "```kanban\n" + newSource + "\n```",
      );
      await this.obsApp.vault.modify(file, newContent);
    }
  }

  private injectStyles() {
    const styleId = "kanban-plugin-styles";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .kanban-plugin-container{display:flex;flex-direction:column;padding:8px 0;gap:0;position:relative}
      .kanban-board-scroll{overflow-x:auto;width:100%}.kanban-board{display:flex;gap:14px;align-items:flex-start;padding:4px 2px 12px;min-width:max-content}
      .kanban-column{background:var(--background-secondary);border-radius:10px;display:flex;flex-direction:column;padding:10px;gap:8px;border:1px solid var(--background-modifier-border);overflow:visible;position:relative}
      .kanban-column-header{display:flex;align-items:center;gap:4px;padding-bottom:6px;border-bottom:2px solid var(--interactive-accent);cursor:grab;user-select:none}
      .kanban-column-title{font-weight:700;font-size:.9em;cursor:pointer;color:var(--text-normal);user-select:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
      .kanban-rename-panel{position:absolute;left:0;right:0;top:100%;z-index:999;display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid var(--background-modifier-border);border-top:none;border-radius:0 0 8px 8px;box-shadow:0 6px 16px rgba(0,0,0,.15);animation:kanban-panel-in .12s ease}
      @keyframes kanban-panel-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
      .kanban-edit-row{display:flex;align-items:center;gap:8px}
      .kanban-edit-label{font-size:.75em;font-weight:600;color:var(--text-muted);width:36px;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
      .kanban-edit-color-right{display:flex;align-items:center;gap:6px;flex:1}
      .kanban-color-swatch{width:22px;height:22px;border-radius:5px;border:1px solid var(--background-modifier-border);cursor:pointer;flex-shrink:0;transition:transform .1s}
      .kanban-color-swatch:hover{transform:scale(1.1)}
      .kanban-color-picker-input{position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:10000}
      .kanban-color-clear-btn{background:transparent!important;border:1px solid var(--background-modifier-border)!important;color:var(--text-muted);font-size:.75em;padding:2px 7px;border-radius:4px;cursor:pointer;transition:background .15s,color .15s;box-shadow:none!important}
      .kanban-color-clear-btn:hover{background:var(--background-modifier-hover)!important;color:var(--text-normal)}
      .kanban-edit-action-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:4px;border-top:1px solid var(--background-modifier-border)}
      .kanban-edit-delete-btn{display:flex;align-items:center;gap:5px;background:transparent!important;border:none!important;color:#e74c3c;font-size:.82em;font-weight:500;cursor:pointer;padding:3px 6px;border-radius:5px;transition:background .15s;box-shadow:none!important}
      .kanban-edit-delete-btn:hover{background:rgba(231,76,60,.1)!important}
      .kanban-edit-delete-btn .kanban-dropdown-icon svg{width:13px;height:13px;stroke:#e74c3c}
      .kanban-rename-input{flex:1;background:var(--background-modifier-form-field);border:1px solid var(--background-modifier-border);border-radius:6px;padding:4px 8px;font-size:.9em;color:var(--text-normal);outline:none;min-width:0}
      .kanban-rename-input:focus{border-color:var(--interactive-accent);box-shadow:0 0 0 2px rgba(var(--interactive-accent-rgb),.15)}
      .kanban-rename-input.kanban-modal-input-error{border-color:#e74c3c}
      .kanban-rename-done-btn{display:flex;align-items:center;gap:4px;background:var(--interactive-accent)!important;color:#fff!important;border:none!important;border-radius:6px;padding:4px 10px;font-size:.82em;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:opacity .15s;box-shadow:none!important}
      .kanban-rename-done-btn:hover{opacity:.85}
      .kanban-rename-done-icon{display:flex;align-items:center}.kanban-rename-done-icon svg{width:12px;height:12px;stroke:#fff}
      .kanban-header-spacer{flex:1;min-width:4px}
      .kanban-count-badge{background:var(--interactive-accent);color:#fff;border-radius:8px;padding:1px 6px;font-size:.7em;font-weight:700}
      .kanban-header-add-btn{background:transparent!important;border:none;color:var(--text-muted);cursor:pointer;padding:0;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease;box-shadow:none!important;width:24px;height:24px;flex-shrink:0}.kanban-header-add-btn svg{width:15px;height:15px}
      .kanban-header-add-btn:hover{background:var(--background-modifier-hover)!important}
      .kanban-column-header:active{cursor:grabbing}
      .kanban-col-dragging{opacity:.5;outline:2px dashed var(--interactive-accent);outline-offset:2px;border-radius:10px}
      .kanban-grip-btn{background:transparent!important;border:none;color:var(--text-muted);cursor:pointer;padding:0;border-radius:4px;display:flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease;box-shadow:none!important;width:24px;height:24px;flex-shrink:0}.kanban-grip-btn svg{width:15px;height:15px}
      .kanban-grip-btn:hover{color:var(--text-normal)!important;background:var(--background-modifier-hover)!important}
      .kanban-cards-wrapper{position:relative;border-radius:6px}.kanban-cards-wrapper.kanban-cards-shadow::after{content:'';position:absolute;bottom:0;left:0;right:0;height:32px;border-radius:0 0 6px 6px;background:linear-gradient(to bottom,transparent,rgba(0,0,0,0.13));pointer-events:none;z-index:1}.kanban-cards{display:flex;flex-direction:column;gap:7px;min-height:40px;border-radius:6px;padding:2px;transition:background .15s}.kanban-cards::-webkit-scrollbar{display:none}.kanban-cards{scrollbar-width:none;-ms-overflow-style:none}
      .kanban-drop-indicator{display:none;height:3px;border-radius:3px;background:var(--interactive-accent);margin:2px 0;pointer-events:none;box-shadow:0 0 6px var(--interactive-accent);transition:none}
      .kanban-card{background:var(--background-primary);border-radius:7px;padding:8px 10px;cursor:grab;border:1px solid var(--background-modifier-border);transition:box-shadow .15s;position:relative}
      .kanban-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}
      .kanban-card:hover .kanban-card-menu-btn{opacity:1}
      .kanban-card.kanban-dragging{opacity:.4;cursor:grabbing}
      .kanban-card-text{font-size:.88em;color:var(--text-normal);display:block;line-height:1.45;padding-right:28px;white-space:pre-wrap}
      .kanban-card-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
      .kanban-tag{font-size:.7em;color:#fff;border-radius:8px;padding:1px 7px;font-weight:600}
      .kanban-card-quick-edit-btn{position:absolute;top:6px;right:32px;background:transparent!important;border:none;cursor:pointer;padding:0;border-radius:4px;opacity:0;transition:opacity .15s ease,background .15s ease,color .15s ease;color:var(--text-muted);display:flex;align-items:center;justify-content:center;box-shadow:none!important;width:22px;height:22px}.kanban-card-quick-edit-btn svg{width:13px;height:13px}
      .kanban-card:hover .kanban-card-quick-edit-btn{opacity:1}
      .kanban-card-quick-edit-btn:hover{opacity:1!important;background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
      .kanban-card-menu-btn{position:absolute;top:6px;right:6px;background:transparent!important;border:none;cursor:pointer;padding:0;border-radius:4px;opacity:0;transition:opacity .15s ease,background .15s ease,color .15s ease;color:var(--text-muted);display:flex;align-items:center;justify-content:center;box-shadow:none!important;width:22px;height:22px}.kanban-card-menu-btn svg{width:14px;height:14px}
      .kanban-card-menu-btn:hover{opacity:1!important;background:var(--background-modifier-hover)!important;color:var(--text-normal)!important}
      .kanban-card-dropdown{position:fixed;z-index:9999;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.1);min-width:170px;padding:4px;display:flex;flex-direction:column;gap:2px}
      .kanban-dropdown-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:5px;cursor:pointer;font-size:.85em;color:var(--text-normal);user-select:none}
      .kanban-dropdown-item:hover{background:var(--background-modifier-hover)}
      .kanban-dropdown-danger{color:#e74c3c}
      .kanban-dropdown-danger:hover{background:rgba(231,76,60,.1)}
      .kanban-dropdown-sep{height:1px;background:var(--background-modifier-border);margin:4px 0}
      .kanban-dropdown-icon{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0}.kanban-dropdown-icon svg{width:14px;height:14px}
      .kanban-add-card-btn{background:var(--background-secondary);border:1px solid var(--background-modifier-border);color:var(--text-muted);border-radius:7px;padding:6px;cursor:pointer;width:100%;font-size:.82em;display:flex;align-items:center;justify-content:center;gap:5px;transition:opacity .15s ease,color .15s ease;box-shadow:none!important}
      .kanban-add-card-btn:hover{opacity:.85;color:var(--text-normal)}
      .kanban-add-card-icon{display:flex;align-items:center;flex-shrink:0}.kanban-add-card-icon svg{width:13px;height:13px}
      .kanban-add-col-btn{background:var(--background-secondary);border:2px solid var(--background-modifier-border);color:var(--text-muted);border-radius:10px;padding:10px 18px;cursor:pointer;font-size:.85em;align-self:flex-start;white-space:nowrap;display:flex;align-items:center;gap:6px;transition:background .15s ease,border-color .15s ease,color .15s ease;box-shadow:none!important}
      .kanban-add-col-btn:hover{background:var(--background-secondary)!important;opacity:.7;border-color:var(--text-muted)!important;color:var(--text-normal)!important}
      .kanban-add-col-icon{display:flex;align-items:center;flex-shrink:0}.kanban-add-col-icon svg{width:14px;height:14px}
      .kanban-add-input-wrapper{display:flex;flex-direction:column;gap:6px}
      .kanban-add-card-input,.kanban-card-edit-input{width:100%;padding:7px;border-radius:6px;border:1px solid var(--interactive-accent);background:var(--background-primary);color:var(--text-normal);font-size:.85em;resize:vertical;min-height:60px;box-sizing:border-box}
      .kanban-add-input-actions{display:flex;gap:6px}
      .kanban-save-btn{background:var(--interactive-accent);color:#fff;border:none;border-radius:5px;padding:4px 12px;cursor:pointer;font-size:.82em;font-weight:600}
      .kanban-cancel-btn{background:transparent;color:var(--text-muted);border:1px solid var(--background-modifier-border);border-radius:5px;padding:4px 10px;cursor:pointer;font-size:.82em}
      .kanban-inline-wrap{display:flex;flex-direction:column;flex:1;min-width:0;gap:2px}
      .kanban-inline-input{font-weight:700;font-size:.9em;background:var(--background-primary);border:1px solid var(--interactive-accent);border-radius:4px;padding:2px 6px;color:var(--text-normal);width:100%;box-sizing:border-box}
      .kanban-inline-error{font-size:.72em;color:#e74c3c;line-height:1.2;padding:0 2px}
      .kanban-search-wrap{display:flex;align-items:center;gap:6px;margin-bottom:8px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:5px 10px;width:100%;box-sizing:border-box;flex-shrink:0}
      .kanban-search-icon{display:flex;align-items:center;opacity:.5;flex-shrink:0;width:16px;height:16px}.kanban-search-icon svg{width:16px;height:16px}
      .kanban-search-input{flex:1;background:transparent;border:none;outline:none;color:var(--text-normal);font-size:.88em;min-width:0}
      .kanban-search-input::placeholder{color:var(--text-muted)}
      .kanban-search-clear{background:transparent;border:none;color:var(--text-muted);cursor:pointer;padding:0 2px;border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;width:20px;height:20px}.kanban-search-clear svg{width:14px;height:14px}
      .kanban-search-clear:hover{color:var(--text-normal);background:var(--background-modifier-hover)}
      .kanban-highlight{background:rgba(255,213,0,.45);border-radius:2px;padding:0 1px;color:inherit}
      .kanban-search-empty{text-align:center;color:var(--text-muted);font-size:.8em;padding:10px 0;font-style:italic}
      .kanban-card-link{color:var(--link-color, var(--interactive-accent));text-decoration:underline;cursor:pointer;font-size:inherit;background:none;border:none;padding:0}
      .kanban-card-link:hover{color:var(--link-color-hover, var(--interactive-accent-hover));text-decoration:underline}
      .kanban-ghost-pill{display:inline-flex;align-items:center;gap:4px;cursor:pointer;border-radius:6px;padding:2px 4px 2px 2px;transition:background .15s;max-width:100%;overflow:hidden}
      .kanban-ghost-pill:hover{background:rgba(0,0,0,.04)}
      .kanban-ghost-icon{display:flex;align-items:center;opacity:.6;flex-shrink:0}.kanban-ghost-icon svg{width:12px;height:12px}
      .kanban-ghost-name{color:var(--link-color,var(--interactive-accent));font-size:.88em;font-weight:500;text-decoration:underline;text-decoration-style:dashed;text-underline-offset:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .kanban-ghost-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--interactive-accent);color:#fff;flex-shrink:0;transition:transform .15s,opacity .15s;opacity:.9}.kanban-ghost-badge svg{width:10px;height:10px;stroke:#fff}
      .kanban-ghost-pill:hover .kanban-ghost-badge{opacity:1;transform:scale(1.1)}
      .kanban-ctx-menu{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:4px;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:99999}
      .kanban-ctx-item{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:5px;cursor:pointer;font-size:.88em;color:var(--text-normal);transition:background .1s}
      .kanban-ctx-item:hover{background:var(--background-modifier-hover)}
      .kanban-ctx-item.kanban-ctx-danger{color:#e74c3c}
      .kanban-ctx-icon{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0}.kanban-ctx-icon svg{width:14px;height:14px}
      .kanban-ctx-sep{height:1px;background:var(--background-modifier-border);margin:4px 8px}
      .kanban-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:99999}
      .kanban-modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:10px;padding:20px 22px;min-width:220px;max-width:320px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:16px}
      .kanban-modal-msg{margin:0;font-size:.9em;color:var(--text-normal);line-height:1.5;white-space:pre-wrap}
      .kanban-modal-btns{display:flex;gap:8px;justify-content:flex-end}
      .kanban-modal-input{width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--interactive-accent);background:var(--background-primary);color:var(--text-normal);font-size:.9em;box-sizing:border-box;outline:none}
      .kanban-modal-input-error{border-color:#e74c3c!important;}
      .kanban-modal-error{margin:4px 0 0;font-size:.8em;color:#e74c3c}
    `;
    document.head.appendChild(style);
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const KANBAN_TEMPLATE = `\`\`\`kanban
[v:1][maxHeight:400px]
## To Do
- 
## In Progress
- 
## Done
- 
\`\`\``;

export default class KanbanBlockPlugin extends Plugin {
  async onload() {
    console.log("Kanban Block plugin loaded");

    // ── Register kanban code block renderer ──
    this.registerMarkdownCodeBlockProcessor(
      "kanban",
      (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const renderer = new KanbanRenderer(el, source, ctx, this.app);
        ctx.addChild(renderer);
      },
    );

    // ── Command palette: Insert Kanban Block ──
    this.addCommand({
      id: "insert-kanban-block",
      name: "Insert Kanban Block",
      editorCallback: (editor: Editor) => {
        insertKanbanBlock(editor);
      },
    });

    // ── Editor context menu: Insert Kanban Block ──
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        menu.addSeparator();
        menu.addItem((item: MenuItem) => {
          item
            .setTitle("Insert Kanban Block")
            .setIcon("layout-dashboard")
            .setSection("insert")
            .onClick(() => insertKanbanBlock(editor));
        });
      }),
    );
  }

  onunload() {
    document.getElementById("kanban-plugin-styles")?.remove();
    console.log("Kanban Block plugin unloaded");
  }
}

function insertKanbanBlock(editor: Editor) {
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);

  // If current line is not empty, insert on a new line below
  const prefix = line.trim() ? "\n" : "";
  const snippet = prefix + KANBAN_TEMPLATE + "\n";

  editor.replaceRange(snippet, { line: cursor.line, ch: line.length });

  // Place cursor inside the first card slot (after "- " on line 3 of the block)
  const insertedAt = cursor.line + (line.trim() ? 1 : 0);
  // Line offsets: 0=fence, 1=[maxHeight], 2=## To Do, 3=- (first card)
  editor.setCursor({ line: insertedAt + 3, ch: 2 });
}
