import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  App,
  Editor,
  Menu,
  MenuItem,
} from "obsidian";

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
      const cardText = trimmed.slice(2).trim();
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
    confirmBtn.textContent = "Delete";
    confirmBtn.style.background = "#e74c3c";

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

    // Mount inside the kanban container so it stays scoped
    const root = anchorEl.closest(".kanban-plugin-container") ?? document.body;
    root.appendChild(backdrop);
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
    const root = anchorEl.closest(".kanban-plugin-container") ?? document.body;
    root.appendChild(backdrop);
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

    const root = anchorEl.closest(".kanban-plugin-container") ?? document.body;
    root.appendChild(backdrop);
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

// Build a safe filename from card text: strip tags, take first 50 words, sanitize
function cardTextToFilename(text: string): string {
  const stripped = text.replace(/#[\w-]+/g, "").trim();
  const words = stripped.split(/\s+/).slice(0, 50).join(" ");
  // Remove characters not allowed in filenames
  return words.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim();
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
    const cards = col.cards.map((c) => `- ${c.text}`).join("\n");
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

class KanbanRenderer extends MarkdownRenderChild {
  private columns: KanbanColumn[];
  private source: string;
  private ctx: MarkdownPostProcessorContext;
  private obsApp: App;
  private searchQuery: string = "";
  private draggingColId: string | null = null;
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
  }

  onload() {
    this.render();
  }

  private render() {
    this.containerEl.innerHTML = "";
    this.containerEl.className = "kanban-plugin-container";
    // Re-parse directives every render so edits to source are reflected live
    const maxHeight = parseMaxHeight(this.source);
    const colWidth = parseColWidth(this.source);

    // ── Search bar ──
    const searchWrap = div("kanban-search-wrap");
    const searchIcon = el("span", { cls: "kanban-search-icon", text: "🔍" });
    const searchInput = el("input", {
      cls: "kanban-search-input",
      attr: { type: "text", placeholder: "Search cards..." },
    }) as HTMLInputElement;
    searchInput.value = this.searchQuery;
    const clearBtn = el("button", { cls: "kanban-search-clear", text: "×" });
    clearBtn.style.display = this.searchQuery ? "flex" : "none";
    clearBtn.addEventListener("click", () => {
      this.searchQuery = "";
      searchInput.value = "";
      clearBtn.style.display = "none";
      this.applySearch("", board);
    });
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      clearBtn.style.display = this.searchQuery ? "flex" : "none";
      this.applySearch(this.searchQuery, board);
    });
    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(clearBtn);
    this.containerEl.appendChild(searchWrap);

    // Board goes inside a separate horizontally-scrollable wrapper
    // so the search bar above it stays fixed/sticky and doesn't scroll
    const boardScroll = div("kanban-board-scroll");
    this.containerEl.appendChild(boardScroll);

    const board = div("kanban-board");
    boardScroll.appendChild(board);

    for (const col of this.columns) {
      this.renderColumn(board, col, maxHeight, colWidth);
    }

    // Apply search state immediately after render (preserves search across re-renders)
    if (this.searchQuery) this.applySearch(this.searchQuery, board);

    const addColBtn = el("button", {
      cls: "kanban-add-col-btn",
      text: "+ Add Column",
    });
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

    // ── Column drag-over: show vertical drop indicator between columns ────────
    board.addEventListener("dragover", (e) => {
      if (!this.draggingColId) return;
      e.preventDefault();

      // Use ALL columns (including dragging one) so DOM positions stay accurate
      const cols = Array.from(
        board.querySelectorAll<HTMLElement>(".kanban-column"),
      );
      let insertBefore: HTMLElement | null = null;
      for (const c of cols) {
        const rect = c.getBoundingClientRect();
        if (rect.width === 0) continue; // skip hidden
        if (e.clientX < rect.left + rect.width / 2) {
          insertBefore = c;
          break;
        }
      }

      board
        .querySelectorAll<HTMLElement>(".kanban-col-drop-indicator")
        .forEach((el) => el.remove());

      const indicator = div("kanban-col-drop-indicator");
      if (insertBefore) {
        board.insertBefore(indicator, insertBefore);
      } else {
        board.insertBefore(indicator, addColBtn);
      }
    });

    board.addEventListener("dragleave", (e) => {
      if (!board.contains(e.relatedTarget as Node)) {
        board
          .querySelectorAll<HTMLElement>(".kanban-col-drop-indicator")
          .forEach((el) => el.remove());
      }
    });

    board.addEventListener("drop", (e) => {
      const data = e.dataTransfer?.getData("text/plain") ?? "";
      if (!data.startsWith("col:")) return;
      e.preventDefault();

      const draggedTitle = data.slice(4);

      // Snapshot all column DOM elements (in current DOM order) BEFORE removing indicator
      const allColEls = Array.from(
        board.querySelectorAll<HTMLElement>(".kanban-column"),
      );
      const indicator = board.querySelector<HTMLElement>(
        ".kanban-col-drop-indicator",
      );
      // Find the index in the DOM where indicator sits among column elements
      // by checking which column comes right after the indicator
      let insertBeforeEl: HTMLElement | null = null;
      if (indicator) {
        let node = indicator.nextElementSibling as HTMLElement | null;
        while (node) {
          if (node.classList.contains("kanban-column")) {
            insertBeforeEl = node;
            break;
          }
          node = node.nextElementSibling as HTMLElement | null;
        }
      }
      board
        .querySelectorAll<HTMLElement>(".kanban-col-drop-indicator")
        .forEach((el) => el.remove());

      // Map DOM order to this.columns order using colId
      // allColEls is the ground truth for current visual order
      const domOrder = allColEls.map((el) => el.dataset.colId ?? "");
      // Build reordered array: remove dragged, insert at target position
      const fromDomIdx = domOrder.indexOf(draggedTitle); // draggedTitle is now col.id
      if (fromDomIdx < 0) return;

      // Target: index of insertBeforeEl in DOM, or end if null
      const insertBeforeTitle = insertBeforeEl?.dataset.colId ?? null;
      let toDomIdx = insertBeforeTitle
        ? domOrder.indexOf(insertBeforeTitle)
        : domOrder.length;
      if (toDomIdx < 0) toDomIdx = domOrder.length;

      // Reorder this.columns to match new DOM order
      // 1. Build new order from domOrder
      const newOrder = [...domOrder];
      newOrder.splice(fromDomIdx, 1);
      if (toDomIdx > fromDomIdx) toDomIdx--; // adjust after removal
      newOrder.splice(toDomIdx, 0, draggedTitle);

      // 2. Remap this.columns to new order
      const colMap = new Map(this.columns.map((c) => [c.id, c]));
      this.columns = newOrder.map((t) => colMap.get(t)!).filter(Boolean);

      this.saveAndRender();
    });

    this.injectStyles();
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
    titleEl.addEventListener("dblclick", () => {
      const inputWrap = div("kanban-inline-wrap");
      const input = el("input", {
        cls: "kanban-inline-input",
      }) as HTMLInputElement;
      input.value = col.displayTitle;
      const errorEl = document.createElement("span");
      errorEl.className = "kanban-inline-error";
      errorEl.textContent = "Title cannot be empty";
      errorEl.style.display = "none";
      inputWrap.appendChild(input);
      inputWrap.appendChild(errorEl);
      header.replaceChild(inputWrap, titleEl);
      input.focus();
      input.select();

      const finishRename = () => {
        const newName = input.value.trim();
        if (!newName) {
          // Show inline error, stay in edit mode
          errorEl.style.display = "block";
          input.classList.add("kanban-modal-input-error");
          input.focus();
          return;
        }
        // Preserve existing [bg:...] tag when renaming
        const bgTag = col.title.match(BG_TAG_RE);
        col.title = bgTag ? `${newName} ${bgTag[0]}` : newName;
        const parsed = parseBgColor(col.title);
        col.displayTitle = parsed.displayTitle || "Untitled";
        col.bgColor = parsed.bgColor;
        this.saveAndRender();
      };
      input.addEventListener("input", () => {
        if (input.value.trim()) {
          errorEl.style.display = "none";
          input.classList.remove("kanban-modal-input-error");
        }
      });
      input.addEventListener("blur", finishRename);
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finishRename();
        }
        if (e.key === "Escape") this.render();
      });
    });

    const badge = el("span", {
      cls: "kanban-count-badge",
      text: String(col.cards.length),
    });

    // ── + Add Card button in header ──
    const headerAddBtn = el("button", {
      cls: "kanban-header-add-btn",
      text: "+",
    });
    headerAddBtn.title = "Add card";

    // ── Grip / menu button ──
    const gripBtn = el("button", { cls: "kanban-grip-btn", text: "⠿" });
    gripBtn.title = "Drag to reorder · Click for options";
    gripBtn.draggable = true;

    // Grip drag events — drag the whole column
    gripBtn.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      this.draggingColId = col.id;
      colEl.classList.add("kanban-col-dragging");
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", "col:" + col.id);
    });
    gripBtn.addEventListener("dragend", () => {
      colEl.classList.remove("kanban-col-dragging");
      this.draggingColId = null;
      // Remove all column drop indicators
      document
        .querySelectorAll<HTMLElement>(".kanban-col-drop-indicator")
        .forEach((el) => el.remove());
    });

    // Grip click — open column dropdown menu
    let colMenuEl: HTMLElement | null = null;
    const closeColMenu = () => {
      colMenuEl?.remove();
      colMenuEl = null;
    };

    const doEditTitle = () => {
      closeColMenu();
      const inputWrap = div("kanban-inline-wrap");
      const input = el("input", {
        cls: "kanban-inline-input",
      }) as HTMLInputElement;
      input.value = col.displayTitle;
      const errorEl = document.createElement("span");
      errorEl.className = "kanban-inline-error";
      errorEl.textContent = "Title cannot be empty";
      errorEl.style.display = "none";
      inputWrap.appendChild(input);
      inputWrap.appendChild(errorEl);
      header.replaceChild(inputWrap, titleEl);
      input.focus();
      input.select();

      const finishRename = () => {
        const newName = input.value.trim();
        if (!newName) {
          errorEl.style.display = "block";
          input.classList.add("kanban-modal-input-error");
          input.focus();
          return;
        }
        const bgTag = col.title.match(BG_TAG_RE);
        col.title = bgTag ? `${newName} ${bgTag[0]}` : newName;
        const parsed = parseBgColor(col.title);
        col.displayTitle = parsed.displayTitle || "Untitled";
        col.bgColor = parsed.bgColor;
        this.saveAndRender();
      };
      input.addEventListener("input", () => {
        if (input.value.trim()) {
          errorEl.style.display = "none";
          input.classList.remove("kanban-modal-input-error");
        }
      });
      input.addEventListener("blur", finishRename);
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finishRename();
        }
        if (e.key === "Escape") this.render();
      });
    };

    const doDeleteCol = async () => {
      closeColMenu();
      const confirmed = await kanbanConfirm(
        `Delete "${col.displayTitle}" and all its cards?`,
        colEl,
      );
      if (!confirmed) return;
      this.columns = this.columns.filter((c) => c !== col);
      this.saveAndRender();
    };

    gripBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (colMenuEl) {
        closeColMenu();
        return;
      }
      colMenuEl = div("kanban-card-dropdown");

      const mkItem = (icon: string, label: string, danger = false) => {
        const item = div(
          "kanban-dropdown-item" + (danger ? " kanban-dropdown-danger" : ""),
        );
        item.innerHTML = `<span class="kanban-dropdown-icon">${icon}</span><span>${label}</span>`;
        return item;
      };

      const editItem = mkItem("✏️", "Edit Title");
      editItem.addEventListener("click", (e) => {
        e.stopPropagation();
        doEditTitle();
      });
      colMenuEl.appendChild(editItem);

      const delItem = mkItem("🗑️", "Delete Column", true);
      delItem.addEventListener("click", (e) => {
        e.stopPropagation();
        doDeleteCol();
      });
      colMenuEl.appendChild(delItem);

      // Mount on body so overflow:hidden on colEl doesn't clip the menu
      colMenuEl.style.position = "fixed";
      document.body.appendChild(colMenuEl);
      const btnRect = gripBtn.getBoundingClientRect();
      // Position below the grip button, left-aligned with it
      colMenuEl.style.top = btnRect.bottom + 4 + "px";
      colMenuEl.style.left = btnRect.left + "px";
      colMenuEl.style.right = "auto";

      const onOutside = (ev: MouseEvent) => {
        if (!colMenuEl?.contains(ev.target as Node)) {
          closeColMenu();
          document.removeEventListener("click", onOutside, true);
        }
      };
      setTimeout(() => document.addEventListener("click", onOutside, true), 0);
    });

    header.appendChild(titleEl);
    header.appendChild(badge);
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

    const addCardBtn = el("button", {
      cls: "kanban-add-card-btn",
      text: "+ Add Card",
    });
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
      // Render as clickable wikilink
      const linkEl = el("a", { cls: "kanban-card-link", text: wikilinkTarget });
      linkEl.title = `Open: ${wikilinkTarget}`;
      linkEl.addEventListener("click", (e) => {
        e.stopPropagation();
        // Check pages folder first, then fallback to kanban folder (legacy support)
        const pagesFolder = (() => {
          const kf = getFolderPath(this.ctx.sourcePath);
          const sub = parsePagesFolder(this.source);
          return kf ? `${kf}/${sub}` : sub;
        })();
        let file = this.obsApp.vault.getFileByPath(
          `${pagesFolder}/${wikilinkTarget}.md`,
        );
        if (!file) {
          const kanbanFolder = getFolderPath(this.ctx.sourcePath);
          const legacy = kanbanFolder
            ? `${kanbanFolder}/${wikilinkTarget}.md`
            : `${wikilinkTarget}.md`;
          file = this.obsApp.vault.getFileByPath(legacy);
        }
        if (file) {
          // Open in a vertical split to the right, keeping kanban visible
          const leaf = this.obsApp.workspace.getLeaf("split");
          leaf.openFile(file);
        }
      });
      textEl.appendChild(linkEl);
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
    const menuBtn = el("button", { cls: "kanban-card-menu-btn", text: "⋯" });
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
        const confirmed = await kanbanConfirm(
          `Delete card and its linked page "${wt}.md"?`,
          cardEl,
        );
        if (!confirmed) return;
        await this.obsApp.vault.trash(linkedFile, true);
      }
      col.cards = col.cards.filter((c) => c.id !== card.id);
      this.saveAndRender();
    };

    const doConvertToPage = async () => {
      closeMenu();
      const filename = cardTextToFilename(card.text);
      if (!filename) return;

      // Ensure pages folder exists
      const pagesFolder = getPagesFolder();
      if (!this.obsApp.vault.getAbstractFileByPath(pagesFolder)) {
        await this.obsApp.vault.createFolder(pagesFolder);
      }

      const filePath = `${pagesFolder}/${filename}.md`;
      const existing = this.obsApp.vault.getFileByPath(filePath);
      if (!existing)
        await this.obsApp.vault.create(filePath, `# ${filename}\n`);

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
      const isWikilink = !!extractWikilink(card.text);

      const mkItem = (icon: string, label: string, cls = "") => {
        const item = div("kanban-dropdown-item" + (cls ? " " + cls : ""));
        item.innerHTML = `<span class="kanban-dropdown-icon">${icon}</span><span>${label}</span>`;
        return item;
      };
      const mkSep = () => {
        const s = div("kanban-dropdown-sep");
        return s;
      };

      if (isWikilink) {
        // ── Open group ──
        const tabItem = mkItem("📂", "Open in New Tab");
        tabItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("tab");
        });
        menuEl.appendChild(tabItem);

        const rightItem = mkItem("➡️", "Open to the Right");
        rightItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("split");
        });
        menuEl.appendChild(rightItem);

        const winItem = mkItem("🪟", "Open in New Window");
        winItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("window");
        });
        menuEl.appendChild(winItem);

        menuEl.appendChild(mkSep());

        // ── Page actions ──
        const renameItem = mkItem("✏️", "Rename");
        renameItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doRename();
        });
        menuEl.appendChild(renameItem);

        const delItem = mkItem("🗑️", "Delete", "kanban-dropdown-danger");
        delItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doDelete();
        });
        menuEl.appendChild(delItem);
      } else {
        // ── Plain card ──
        const editItem = mkItem("✏️", "Edit");
        editItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doEdit();
        });
        menuEl.appendChild(editItem);

        const pageItem = mkItem("📄", "Convert to Page");
        pageItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doConvertToPage();
        });
        menuEl.appendChild(pageItem);

        const delItem = mkItem("🗑️", "Delete", "kanban-dropdown-danger");
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
        }
      };
      setTimeout(() => document.addEventListener("click", onOutside, true), 0);
    };

    menuBtn.addEventListener("click", openMenu);
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

  private async saveAndRender() {
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
      .kanban-column{background:var(--background-secondary);border-radius:10px;display:flex;flex-direction:column;padding:10px;gap:8px;border:1px solid var(--background-modifier-border);overflow:hidden}
      .kanban-column-header{display:flex;align-items:center;gap:4px;padding-bottom:6px;border-bottom:2px solid var(--interactive-accent)}
      .kanban-column-title{font-weight:700;font-size:.9em;flex:1;cursor:pointer;color:var(--text-normal);user-select:none}
      .kanban-count-badge{background:var(--interactive-accent);color:#fff;border-radius:10px;padding:1px 7px;font-size:.75em;font-weight:700}
      .kanban-header-add-btn{background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:1.1em;padding:0 4px;border-radius:4px;line-height:1;font-weight:300}
      .kanban-header-add-btn:hover{color:var(--interactive-accent);background:var(--background-modifier-hover)}
      .kanban-grip-btn{background:transparent;border:none;color:var(--text-muted);cursor:grab;font-size:1em;padding:0 4px;border-radius:4px;line-height:1;user-select:none}
      .kanban-grip-btn:hover{color:var(--text-normal);background:var(--background-modifier-hover)}
      .kanban-grip-btn:active{cursor:grabbing}
      .kanban-col-dragging{opacity:.4}
      .kanban-col-drop-indicator{width:3px;min-height:60px;border-radius:3px;background:var(--interactive-accent);box-shadow:0 0 6px var(--interactive-accent);flex-shrink:0;align-self:stretch;pointer-events:none}
      .kanban-cards-wrapper{position:relative;border-radius:6px}.kanban-cards-wrapper.kanban-cards-shadow::after{content:'';position:absolute;bottom:0;left:0;right:0;height:32px;border-radius:0 0 6px 6px;background:linear-gradient(to bottom,transparent,rgba(0,0,0,0.13));pointer-events:none;z-index:1}.kanban-cards{display:flex;flex-direction:column;gap:7px;min-height:40px;border-radius:6px;padding:2px;transition:background .15s}.kanban-cards::-webkit-scrollbar{display:none}.kanban-cards{scrollbar-width:none;-ms-overflow-style:none}
      .kanban-drop-indicator{display:none;height:3px;border-radius:3px;background:var(--interactive-accent);margin:2px 0;pointer-events:none;box-shadow:0 0 6px var(--interactive-accent);transition:none}
      .kanban-card{background:var(--background-primary);border-radius:7px;padding:8px 10px;cursor:grab;border:1px solid var(--background-modifier-border);transition:box-shadow .15s;position:relative}
      .kanban-card:hover{box-shadow:0 2px 8px rgba(0,0,0,.15)}
      .kanban-card:hover .kanban-card-menu-btn{opacity:1}
      .kanban-card.kanban-dragging{opacity:.4;cursor:grabbing}
      .kanban-card-text{font-size:.88em;color:var(--text-normal);display:block;line-height:1.45;padding-right:28px}
      .kanban-card-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
      .kanban-tag{font-size:.7em;color:#fff;border-radius:8px;padding:1px 7px;font-weight:600}
      .kanban-card-menu-btn{position:absolute;top:6px;right:6px;background:transparent;border:none;cursor:pointer;font-size:1em;padding:0 4px;border-radius:4px;opacity:0;transition:opacity .15s;color:var(--text-muted);line-height:1.2;letter-spacing:1px}
      .kanban-card-menu-btn:hover{opacity:1!important;background:var(--background-modifier-hover);color:var(--text-normal)}
      .kanban-card-dropdown{position:fixed;z-index:9999;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18);min-width:160px;padding:4px;display:flex;flex-direction:column;gap:2px}
      .kanban-dropdown-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:5px;cursor:pointer;font-size:.85em;color:var(--text-normal);user-select:none}
      .kanban-dropdown-item:hover{background:var(--background-modifier-hover)}
      .kanban-dropdown-danger{color:#e74c3c}
      .kanban-dropdown-danger:hover{background:rgba(231,76,60,.1)}
      .kanban-dropdown-sep{height:1px;background:var(--background-modifier-border);margin:4px 0}
      .kanban-dropdown-icon{font-size:.9em;width:18px;text-align:center;flex-shrink:0}
      .kanban-add-card-btn{background:transparent;border:1px dashed var(--background-modifier-border);color:var(--text-muted);border-radius:7px;padding:6px;cursor:pointer;width:100%;font-size:.82em}
      .kanban-add-card-btn:hover{background:var(--background-modifier-hover);color:var(--text-normal)}
      .kanban-add-col-btn{background:var(--background-secondary);border:2px dashed var(--background-modifier-border);color:var(--text-muted);border-radius:10px;padding:10px 18px;cursor:pointer;font-size:.85em;align-self:flex-start;white-space:nowrap}
      .kanban-add-col-btn:hover{background:var(--background-modifier-hover);color:var(--text-normal)}
      .kanban-add-input-wrapper{display:flex;flex-direction:column;gap:6px}
      .kanban-add-card-input,.kanban-card-edit-input{width:100%;padding:7px;border-radius:6px;border:1px solid var(--interactive-accent);background:var(--background-primary);color:var(--text-normal);font-size:.85em;resize:vertical;min-height:60px;box-sizing:border-box}
      .kanban-add-input-actions{display:flex;gap:6px}
      .kanban-save-btn{background:var(--interactive-accent);color:#fff;border:none;border-radius:5px;padding:4px 12px;cursor:pointer;font-size:.82em;font-weight:600}
      .kanban-cancel-btn{background:transparent;color:var(--text-muted);border:1px solid var(--background-modifier-border);border-radius:5px;padding:4px 10px;cursor:pointer;font-size:.82em}
      .kanban-inline-wrap{display:flex;flex-direction:column;flex:1;min-width:0;gap:2px}
      .kanban-inline-input{font-weight:700;font-size:.9em;background:var(--background-primary);border:1px solid var(--interactive-accent);border-radius:4px;padding:2px 6px;color:var(--text-normal);width:100%;box-sizing:border-box}
      .kanban-inline-error{font-size:.72em;color:#e74c3c;line-height:1.2;padding:0 2px}
      .kanban-search-wrap{display:flex;align-items:center;gap:6px;margin-bottom:8px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:5px 10px;width:100%;box-sizing:border-box;flex-shrink:0}
      .kanban-search-icon{font-size:.9em;opacity:.5;flex-shrink:0}
      .kanban-search-input{flex:1;background:transparent;border:none;outline:none;color:var(--text-normal);font-size:.88em;min-width:0}
      .kanban-search-input::placeholder{color:var(--text-muted)}
      .kanban-search-clear{background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:1.1em;padding:0 2px;border-radius:4px;align-items:center;justify-content:center;line-height:1;flex-shrink:0}
      .kanban-search-clear:hover{color:var(--text-normal);background:var(--background-modifier-hover)}
      .kanban-highlight{background:rgba(255,213,0,.45);border-radius:2px;padding:0 1px;color:inherit}
      .kanban-search-empty{text-align:center;color:var(--text-muted);font-size:.8em;padding:10px 0;font-style:italic}
      .kanban-card-link{color:var(--link-color, var(--interactive-accent));text-decoration:underline;cursor:pointer;font-size:inherit;background:none;border:none;padding:0}
      .kanban-card-link:hover{color:var(--link-color-hover, var(--interactive-accent-hover));text-decoration:underline}
      .kanban-modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:9999;border-radius:10px}
      .kanban-modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:10px;padding:20px 22px;min-width:220px;max-width:320px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:16px}
      .kanban-modal-msg{margin:0;font-size:.9em;color:var(--text-normal);line-height:1.5}
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
