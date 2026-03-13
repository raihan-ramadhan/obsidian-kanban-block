import {
  Plugin,
  MarkdownPostProcessorContext,
  MarkdownRenderChild,
  App,
  Editor,
  Menu,
  MenuItem,
  setIcon,
  setTooltip,
  Notice,
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
  updatedAt?: string; // ISO 8601 format: "2024-01-15T10:30"
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
      NOTES_FOLDER_RE.test(trimmed) ||
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
    } else if ((trimmed === "-" || trimmed === "*") && currentColumn) {
      continue; // bare "-" or "*" with no content — skip and drop from source on next save
    } else if (
      (trimmed.startsWith("- ") || trimmed.startsWith("* ")) &&
      currentColumn
    ) {
      const rawCard = trimmed.slice(2).trim().replace(/\\n/g, "\n");
      const updatedMatch = rawCard.match(UPDATED_AT_RE);
      const updatedAt = updatedMatch ? updatedMatch[1] : undefined;
      const cardText = rawCard.replace(UPDATED_AT_RE, "").trim();
      if (!cardText) continue; // skip empty cards — cleaned up on next save
      const tags = cardText.match(/#[\w-]+/g) || [];
      currentColumn.cards.push({
        id: generateId(),
        text: cardText,
        tags,
        updatedAt,
      });
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

function setCssProps(
  el: HTMLElement,
  props: Partial<CSSStyleDeclaration>,
): void {
  Object.assign(el.style, props);
}

function escapeRegex(s: string): string {
  return s.replace(/[-.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build highlight nodes from plain text + regex without using innerHTML
function applyHighlight(el: HTMLElement, plainText: string, regex: RegExp) {
  el.replaceChildren();
  const parts = plainText.split(regex);
  regex.lastIndex = 0;
  for (const part of parts) {
    if (regex.test(part)) {
      const mark = document.createElement("mark");
      mark.className = "kanban-highlight";
      mark.textContent = part;
      el.appendChild(mark);
    } else {
      el.appendChild(document.createTextNode(part));
    }
    regex.lastIndex = 0;
  }
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
    // Support HTML message (for styled highlights)
    if (message.includes("<")) {
      const range = document.createRange();
      range.selectNode(document.body);
      msg.appendChild(range.createContextualFragment(message));
    } else {
      msg.textContent = message;
    }

    const btnRow = document.createElement("div");
    btnRow.className = "kanban-modal-btns";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-cancel-btn";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "kanban-save-btn";
    confirmBtn.textContent = confirmLabel;
    if (danger) confirmBtn.classList.add("kanban-btn-danger");

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

// Confirm dialog with optional checkbox
function kanbanConfirmWithCheckbox(
  message: string,
  checkboxLabel: string,
  confirmLabel = "Delete",
  danger = true,
): Promise<{ confirmed: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "kanban-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "kanban-modal";

    const msg = document.createElement("p");
    msg.className = "kanban-modal-msg";
    if (message.includes("<")) {
      const range = document.createRange();
      range.selectNode(document.body);
      msg.appendChild(range.createContextualFragment(message));
    } else msg.textContent = message;

    const checkRow = document.createElement("label");
    checkRow.className = "kanban-modal-check-row";
    const checkInput = document.createElement("input");
    checkInput.type = "checkbox";
    checkInput.className = "kanban-modal-checkbox";
    checkRow.appendChild(checkInput);
    checkRow.appendChild(document.createTextNode(" " + checkboxLabel));

    const btnRow = document.createElement("div");
    btnRow.className = "kanban-modal-btns";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "kanban-cancel-btn";
    cancelBtn.textContent = "Cancel";
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "kanban-save-btn";
    confirmBtn.textContent = confirmLabel;
    if (danger) confirmBtn.classList.add("kanban-btn-danger");

    const close = (confirmed: boolean) => {
      backdrop.remove();
      resolve({ confirmed, checked: checkInput.checked });
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
    modal.appendChild(checkRow);
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
    errorEl.classList.remove("kanban-visible");

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
      errorEl.classList.add("kanban-visible");
      input.classList.add("kanban-modal-input-error");
      input.focus();
    };

    const clearError = () => {
      errorEl.classList.remove("kanban-visible");
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
      .filter((c) => c.text.trim())
      .map((c) => {
        // Encode newlines as literal \\n so multi-line cards stay on one line
        const encoded = c.text.replace(/\n/g, "\\n");
        const updatedTag = c.updatedAt ? ` [updatedAt:${c.updatedAt}]` : "";
        return `- ${encoded}${updatedTag}`;
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
        !NOTES_FOLDER_RE.test(l.trim()) &&
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
      const nf = line.match(NOTES_FOLDER_RE);
      if (nf) {
        tokens.push(nf[0].trim());
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

const DEFAULT_NOTES_FOLDER = "_kanban-notes";

// Matches [notesFolder:_my-notes], [notesfolder: notes], etc.
const NOTES_FOLDER_RE = /\[\s*notesFolder\s*:\s*([^\]]+?)\s*\]/i;

function parseNotesFolder(source: string): string {
  for (const line of source.split("\n")) {
    const match = line.match(NOTES_FOLDER_RE);
    if (match) return match[1].trim();
  }
  return DEFAULT_NOTES_FOLDER;
}

// ── Sort directive [s:title-asc] ─────────────────────────────────────────────
const SORT_RE = /\[\s*s\s*:\s*([^\]]+?)\s*\]/i;
type SortMode =
  | "title-asc"
  | "title-desc"
  | "updated-desc"
  | "updated-asc"
  | "tag-asc"
  | "none";

function parseSort(source: string): SortMode {
  for (const line of source.split("\n")) {
    const match = line.match(SORT_RE);
    if (match) {
      const val = match[1].trim();
      const modes = [
        "title-asc",
        "title-desc",
        "updated-desc",
        "updated-asc",
        "tag-asc",
        "none",
      ];
      const found = modes.find((m) => m === val);
      if (found) return found as SortMode;
    }
  }
  return "none";
}

function updateDirective(
  source: string,
  re: RegExp,
  newTag: string | null,
  defaultCheck?: string,
): string {
  const lines = source.split("\n");
  const idx = lines.findIndex((l) => re.test(l.trim()));
  if (idx >= 0) {
    if (newTag === null) {
      lines.splice(idx, 1);
    } else {
      lines[idx] = newTag;
    }
  } else if (newTag !== null) {
    // Insert after last known directive or at top
    const insertIdx = lines.findIndex((l) => l.startsWith("## "));
    if (insertIdx > 0) lines.splice(insertIdx, 0, newTag);
    else lines.unshift(newTag);
  }
  return lines.join("\n");
}

// ── Properties directive [showProps:updatedAt,tags] ───────────────────────────
const SHOW_PROPS_RE = /\[\s*showProps\s*:\s*([^\]]*)\s*\]/i;
type PropKey = "updatedAt" | "tags";

function parseShowProps(source: string): Set<PropKey> {
  for (const line of source.split("\n")) {
    const match = line.match(SHOW_PROPS_RE);
    if (match) {
      const props = match[1]
        .split(",")
        .map((p) => p.trim())
        .filter((p): p is PropKey => p.length > 0);
      return new Set(props);
    }
  }
  return new Set();
}

// ── updatedAt helper ──────────────────────────────────────────────────────────
const UPDATED_AT_RE = /\[updatedAt:([^\]]+)\]/;

function nowISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins > 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} week${weeks > 1 ? "s" : ""} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? "s" : ""} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

function sortCards(cards: KanbanCard[], mode: SortMode): KanbanCard[] {
  if (mode === "none") return cards;
  const sorted = [...cards];
  if (mode === "title-asc") sorted.sort((a, b) => a.text.localeCompare(b.text));
  if (mode === "title-desc")
    sorted.sort((a, b) => b.text.localeCompare(a.text));
  if (mode === "updated-desc")
    sorted.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  if (mode === "updated-asc")
    sorted.sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
  if (mode === "tag-asc")
    sorted.sort((a, b) => (a.tags[0] ?? "").localeCompare(b.tags[0] ?? ""));
  return sorted;
}

// ── Format version — for future migration support ─────────────────────────────
// Current format version is 1. Bump this when the kanban syntax changes
// in a breaking way, then add a migrateSource(source, fromVersion) function.
const CURRENT_FORMAT_VERSION = 1;
const VERSION_RE = /\[\s*v\s*:\s*(\d+)\s*\]/i;

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
  private sortMode: SortMode = "none";
  private filterTags: Set<string> = new Set();
  private filterType: "all" | "notes" | "plain" = "all";
  private showProps: Set<PropKey> = new Set();
  private draggingColId: string | null = null;
  private boardScrollEl: HTMLElement | null = null;
  private boardEl: HTMLElement | null = null;
  private scrollKey: string = "";
  private flairObserver: MutationObserver | null = null;
  private selectedCards: Set<string> = new Set();
  private lastSelectedCardId: string | null = null;
  private anchorCardId: string | null = null;
  private actionBar: HTMLElement | null = null;
  private selectMode: boolean = false;
  private selectBtn: HTMLElement | null = null;
  private sortBtn2: HTMLElement | null = null;
  private filterBtn: HTMLElement | null = null;

  private _escHandler: ((e: KeyboardEvent) => void) | null = null;
  private _selectEventHandler: ((e: Event) => void) | null = null;

  onunload() {
    this.flairObserver?.disconnect();
    if (this._escHandler)
      document.removeEventListener("keydown", this._escHandler, false);
    if (this._selectEventHandler)
      document.removeEventListener(
        "kanban-select-activated",
        this._selectEventHandler,
        false,
      );
    // Remove action bar immediately when switching to source editor
    if (this.actionBar) {
      this.actionBar.remove();
      this.actionBar = null;
    }
    this.selectMode = false;
    this.selectedCards.clear();
  }
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
    this.sortMode = parseSort(source);
    this.showProps = parseShowProps(source);
  }

  onload() {
    this.containerEl.className = "kanban-plugin-container";

    // ── Kanban toolbar — created once, never destroyed ──────────────────────
    const toolbar = div("kanban-toolbar");

    // Toolbar right buttons
    const toolbarRight = div("kanban-toolbar-right");

    // Search — icon button, expands to input on click
    const searchWrap = div("kanban-search-wrap");
    const searchIconEl = el("button", { cls: "kanban-search-icon-el" });
    si(searchIconEl, "search");
    const searchInput = el("input", {
      cls: "kanban-search-input",
      attr: { type: "text", placeholder: "Search..." },
    });
    const clearBtn = el("button", { cls: "kanban-search-clear" });
    si(clearBtn, "x");
    setTooltip(clearBtn, "Clear search");
    setTooltip(searchIconEl, "Search");

    let searchOpen = false;
    const openSearch = () => {
      searchOpen = true;
      searchWrap.classList.add("kanban-search-open");
      requestAnimationFrame(() => searchInput.focus());
    };
    const closeSearch = () => {
      if (this.searchQuery) return;
      searchOpen = false;
      searchWrap.classList.remove("kanban-search-open");
    };

    searchWrap.addEventListener("click", (e) => {
      if (!searchOpen) openSearch();
    });
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.searchQuery = "";
      searchInput.value = "";
      searchWrap.classList.remove("kanban-search-has-query");
      if (this.boardEl) this.applyFilters(this.boardEl);
      closeSearch();
    });
    searchInput.addEventListener("click", (e) => e.stopPropagation());
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value;
      searchWrap.classList.toggle(
        "kanban-search-has-query",
        !!this.searchQuery,
      );
      if (this.boardEl) this.applyFilters(this.boardEl);
    });
    searchInput.addEventListener("blur", () => {
      if (!this.searchQuery) closeSearch();
    });
    searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        clearBtn.click();
      }
    });

    searchWrap.appendChild(searchIconEl);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(clearBtn);
    toolbarRight.appendChild(searchWrap);

    // Sort button
    const sortBtn = el("button", { cls: "kanban-toolbar-btn" });
    si(sortBtn, "arrow-up-down");
    setTooltip(sortBtn, "Sort");
    sortBtn.addEventListener("click", (e) => this.showSortMenu(e, sortBtn));
    toolbarRight.appendChild(sortBtn);
    this.sortBtn2 = sortBtn;

    // Filter button
    const filterBtn = el("button", { cls: "kanban-toolbar-btn" });
    si(filterBtn, "filter");
    setTooltip(filterBtn, "Filter");
    filterBtn.addEventListener("click", (e) =>
      this.showFilterMenu(e, filterBtn),
    );
    toolbarRight.appendChild(filterBtn);
    this.filterBtn = filterBtn;
    this.updateFilterSortBtns();

    // Properties button
    const propsBtn = el("button", { cls: "kanban-toolbar-btn" });
    si(propsBtn, "layout-list");
    setTooltip(propsBtn, "Properties");
    propsBtn.addEventListener("click", (e) => this.showPropsMenu(e, propsBtn));
    toolbarRight.appendChild(propsBtn);

    // Directives button
    const directivesBtn = el("button", { cls: "kanban-toolbar-btn" });
    si(directivesBtn, "settings");
    setTooltip(directivesBtn, "Directives");
    directivesBtn.addEventListener("click", () => this.showDirectivesModal());
    toolbarRight.appendChild(directivesBtn);

    // Select Cards button
    const selectCardsBtn = el("button", {
      cls: "kanban-toolbar-btn kanban-select-btn",
    });
    const selectIcon = el("span", { cls: "kanban-toolbar-btn-icon" });
    si(selectIcon, "mouse-pointer-2");
    selectCardsBtn.appendChild(selectIcon);
    selectCardsBtn.appendChild(el("span", { text: "Select cards" }));
    setTooltip(selectCardsBtn, "Select cards");
    this.selectBtn = selectCardsBtn;
    selectCardsBtn.addEventListener("click", () => {
      this.selectMode = !this.selectMode;
      selectCardsBtn.classList.toggle(
        "kanban-toolbar-btn-active",
        this.selectMode,
      );
      if (!this.selectMode) {
        this.selectedCards.clear();
        this.lastSelectedCardId = null;
        this.anchorCardId = null;
        this.hideActionBar();
      }
      this.render();
      if (this.selectMode) {
        this.updateActionBar();
        this.boardEl?.classList.add("kanban-select-mode");
        // Small delay so other block's bar animates out first
        setTimeout(() => {
          document.dispatchEvent(
            new CustomEvent("kanban-select-activated", {
              detail: { source: this },
            }),
          );
        }, 0);
      } else {
        this.boardEl?.classList.remove("kanban-select-mode");
      }
    });
    // New Column button (accent)
    const newColBtn = el("button", { cls: "kanban-toolbar-new-col-btn" });
    const newColIcon = el("span", { cls: "kanban-toolbar-new-col-icon" });
    si(newColIcon, "plus");
    newColBtn.appendChild(newColIcon);
    newColBtn.appendChild(el("span", { text: "New column" }));
    newColBtn.addEventListener("click", () => {
      void (async () => {
        if (this.selectMode) {
          this.shakeActionBar();
          return;
        }
        const name = await kanbanPrompt(
          "Column name:",
          newColBtn,
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
        await this.saveAndRender();
      })();
    });
    toolbarRight.appendChild(newColBtn);

    const toolbarLeft = div("kanban-toolbar-left");
    toolbarLeft.appendChild(selectCardsBtn);
    toolbar.appendChild(toolbarLeft);
    toolbar.appendChild(toolbarRight);
    this.containerEl.appendChild(toolbar);

    // Global Esc → cancel select mode
    this._escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.selectMode) {
        e.stopPropagation();
        this.clearSelection();
      }
    };
    document.addEventListener("keydown", this._escHandler, false);

    // Shift/Ctrl/Cmd held → add class to board for cursor override on links
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Shift")
          this.containerEl.classList.add("kanban-shift-held");
        if (e.key === "Control" || e.key === "Meta")
          this.containerEl.classList.add("kanban-ctrl-held");
      },
      false,
    );
    document.addEventListener(
      "keyup",
      (e: KeyboardEvent) => {
        if (e.key === "Shift")
          this.containerEl.classList.remove("kanban-shift-held");
        if (e.key === "Control" || e.key === "Meta")
          this.containerEl.classList.remove("kanban-ctrl-held");
      },
      false,
    );
    window.addEventListener(
      "blur",
      () => {
        this.containerEl.classList.remove("kanban-shift-held");
        this.containerEl.classList.remove("kanban-ctrl-held");
      },
      false,
    );

    // Mutual exclusive: cancel selectMode if another kanban block activates select
    this._selectEventHandler = (e: Event) => {
      if ((e as CustomEvent).detail?.source !== this && this.selectMode) {
        // Animate out first, then new block's bar will animate in after 200ms delay
        this.clearSelection();
      }
    };
    document.addEventListener(
      "kanban-select-activated",
      this._selectEventHandler,
      false,
    );

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
    this.boardScrollEl.replaceChildren();

    // Re-parse directives every render so edits to source are reflected live
    const maxHeight = parseMaxHeight(this.source);
    const colWidth = parseColWidth(this.source);

    const boardScroll = this.boardScrollEl;
    const board = div("kanban-board");
    boardScroll.appendChild(board);
    this.boardEl = board;
    if (this.selectMode) board.classList.add("kanban-select-mode");

    for (const col of this.columns) {
      // Sort cards for display only — pass original col so mutations work correctly
      const sortedCards = sortCards(col.cards, this.sortMode);
      this.renderColumn(board, col, sortedCards, maxHeight, colWidth);
    }

    // Apply filters (search + tag filter + type filter) after render
    this.applyFilters(board);

    // Restore scroll from static registry — handles Obsidian re-mounting the instance
    const savedScroll = _scrollRegistry.get(this.scrollKey);
    if (savedScroll && savedScroll > 0 && this.boardScrollEl) {
      const bsEl = this.boardScrollEl;
      requestAnimationFrame(() => {
        bsEl.scrollLeft = savedScroll;
      });
    }

    // No add-column button at end of board — moved to toolbar

    // ── Column live reorder on dragover with FLIP animation ────────────────
    board.addEventListener("dragover", (e) => {
      if (!this.draggingColId) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";

      const draggingEl = board.querySelector<HTMLElement>(
        `[data-col-id="${this.draggingColId}"]`,
      );
      if (!draggingEl) return;

      const allCols = Array.from(
        board.querySelectorAll<HTMLElement>(".kanban-column"),
      );
      const cols = allCols.filter((c) => c !== draggingEl);

      let insertBefore: HTMLElement | null = null;
      for (const c of cols) {
        const rect = c.getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
          insertBefore = c;
          break;
        }
      }

      // Check if reorder is needed
      const willChange = insertBefore
        ? draggingEl.nextElementSibling !== insertBefore
        : draggingEl.nextElementSibling !== null;

      if (!willChange) return;

      // FLIP — record positions BEFORE reorder
      const first = new Map<HTMLElement, DOMRect>();
      allCols.forEach((c) => {
        if (c !== draggingEl) first.set(c, c.getBoundingClientRect());
      });

      // Reorder DOM
      if (insertBefore) {
        board.insertBefore(draggingEl, insertBefore);
      } else {
        board.appendChild(draggingEl);
      }

      // FLIP — record positions AFTER reorder, then invert+play
      allCols.forEach((c) => {
        if (c === draggingEl) return;
        const f = first.get(c);
        if (!f) return;
        const l = c.getBoundingClientRect();
        const dx = f.left - l.left;
        if (Math.abs(dx) < 1) return;
        // Cancel any ongoing animation
        setCssProps(c, { transition: "none" });
        setCssProps(c, { transform: `translateX(${dx}px)` });
        requestAnimationFrame(() => {
          setCssProps(c, {
            transition: "transform 0.18s cubic-bezier(0.25,0.46,0.45,0.94)",
          });
          setCssProps(c, { transform: "translateX(0)" });
        });
      });
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

      void this.saveAndRender();
    });
  }

  private renderColumn(
    board: HTMLElement,
    col: KanbanColumn,
    sortedCards: KanbanCard[],
    maxHeight: string,
    colWidth: string,
  ) {
    const colEl = div("kanban-column");
    setCssProps(colEl, { width: colWidth, minWidth: colWidth });
    colEl.dataset.colId = col.id; // runtime id — stable even with duplicate titles

    // Apply dynamic bg color if present
    if (col.bgColor) {
      setCssProps(colEl, { backgroundColor: col.bgColor });
      setCssProps(colEl, { borderColor: borderColor(col.bgColor) });
    }

    const header = div("kanban-column-header");

    // Border color under header: use darken of bg or accent
    if (col.bgColor) {
      setCssProps(header, { borderBottomColor: headerLineColor(col.bgColor) });
    }

    const titleEl = el("span", {
      cls: "kanban-column-title",
      text: col.displayTitle,
    });
    if (col.bgColor) {
      setCssProps(titleEl, { color: adaptiveForeground(col.bgColor) });
    }
    // pointer-events:none so drag events go straight to header (the draggable parent)
    // dblclick is handled on header instead (see below)
    titleEl.classList.add("kanban-no-pointer");

    // dblclick handled on header — titleEl has pointer-events:none

    const badge = el("span", {
      cls: "kanban-count-badge",
      text: String(col.cards.length),
    });
    badge.classList.add("kanban-no-pointer");

    // ── + Add Card button in header ──
    const headerAddBtn = el("button", { cls: "kanban-header-add-btn" });
    setTooltip(headerAddBtn, "Add card");
    si(headerAddBtn, "plus");

    // Apply adaptive foreground to all header icon buttons when column has bgColor
    if (col.bgColor) {
      const fg = adaptiveForeground(col.bgColor);
      setCssProps(headerAddBtn, { color: fg });
    }

    // ── Header drag — entire header is drag handle ──────────────────────────
    // header.draggable = true permanently so browser can start drag from any child.
    // We distinguish click vs drag in dragstart by checking mouse travel distance.
    header.draggable = true;
    let headerDragStarted = false;

    // Track mousedown position — works even when target is a child span
    header.addEventListener("mousedown", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("button,input,a")) return;
      headerDragStarted = false;
    });

    header.addEventListener("dragstart", (e: DragEvent) => {
      if (this.selectMode) {
        e.preventDefault();
        return;
      }
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
      ghost.classList.add("kanban-drag-ghost");
      document.body.appendChild(ghost);
      e.dataTransfer!.setDragImage(ghost, 0, 0);
      setTimeout(() => ghost.remove(), 0);
    });

    header.addEventListener("dragend", () => {
      header.draggable = true;
      headerDragStarted = false;
      colEl.classList.remove("kanban-col-dragging");
      this.draggingColId = null;
      // Clean up any leftover FLIP transforms on all columns
      board.querySelectorAll<HTMLElement>(".kanban-column").forEach((c) => {
        setCssProps(c, { transition: "none" });
        setCssProps(c, { transform: "" });
      });
    });

    // ── Double-click on header → rename panel ───────────────────────────────
    header.addEventListener("dblclick", (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("button,input,a")) return;
      if (headerDragStarted) return;
      doEditTitle();
    });

    // ── Column options button (⋯) — replaces grip ────────────────────────────
    const gripBtn = el("button", { cls: "kanban-grip-btn" });
    setTooltip(gripBtn, "Column options");
    si(gripBtn, "more-horizontal");
    if (col.bgColor) {
      const fg = adaptiveForeground(col.bgColor);
      setCssProps(gripBtn, { color: fg });
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
      setCssProps(panel, {
        background: col.bgColor || "var(--background-secondary)",
      });
      const input = el("input", { cls: "kanban-rename-input" });
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
      setCssProps(panel, { top: headerRect.bottom - colRect.top + "px" });
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
        void this.saveAndRender();
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
            document.removeEventListener("mousedown", onOut, false);
          }
        };
        document.addEventListener("mousedown", onOut, false);
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
      const addCardItem = mkItem("plus", "Add card");
      addCardItem.addEventListener("click", (e) => {
        e.stopPropagation();
        closeColMenu();
        this.showAddCardInput(cardsEl, col);
      });
      colMenuEl.appendChild(addCardItem);

      colMenuEl.appendChild(mkSep());

      // Edit Title
      const editItem = mkItem("pencil", "Edit title");
      editItem.addEventListener("click", (e) => {
        e.stopPropagation();
        doEditTitle();
      });
      colMenuEl.appendChild(editItem);

      // Delete Column
      const delItem = mkItem("trash-2", "Delete column", true);
      delItem.addEventListener("click", (e) => {
        void (async () => {
          e.stopPropagation();
          closeColMenu();

          // Collect all linked files in this column
          const linkedWikilinks = col.cards
            .map((c) => extractWikilink(c.text))
            .filter(
              (wt): wt is string => !!wt && !!this.getLinkedFileByName(wt),
            );
          const uniqueFiles = [...new Set(linkedWikilinks)];

          // Check cross-refs: files also linked by cards in OTHER columns
          const crossRefs: string[] = [];
          for (const wt of uniqueFiles) {
            for (const otherCol of this.columns) {
              if (otherCol === col) continue;
              for (const card of otherCol.cards) {
                if (extractWikilink(card.text) === wt) {
                  crossRefs.push(wt);
                }
              }
            }
          }

          // Build confirm message
          const cardCount = col.cards.length;
          let msg = `Delete column <strong>"${col.displayTitle}"</strong> and its <strong>${cardCount} card${cardCount !== 1 ? "s" : ""}</strong>?`;
          if (uniqueFiles.length > 0) {
            const fileList = uniqueFiles.map((f) => `${f}.md`).join(", ");
            msg += `<br><span class="kanban-modal-filenote">${uniqueFiles.length} linked note${uniqueFiles.length !== 1 ? "s" : ""}: ${fileList}</span>`;
          }
          if (crossRefs.length > 0) {
            const affected = [...new Set(crossRefs)]
              .map((w) => `"${w}.md"`)
              .join(", ");
            msg += `<br><span class="kanban-modal-warn">⚠️ Also linked from other columns: ${affected} — deleting files will affect those cards too.</span>`;
          }

          let deleteFiles = false;
          if (uniqueFiles.length > 0) {
            const { confirmed, checked } = await kanbanConfirmWithCheckbox(
              msg,
              `Also delete ${uniqueFiles.length} linked file${uniqueFiles.length !== 1 ? "s" : ""}`,
              "Delete",
              true,
            );
            if (!confirmed) return;
            deleteFiles = checked;
          } else {
            const confirmed = await kanbanConfirm(msg, colEl, "Delete", true);
            if (!confirmed) return;
          }

          // Snapshot for undo
          const sourceSnapshot = this.source;
          this.columns = this.columns.filter((c) => c !== col);
          await this.saveAndRender();

          // Toast with undo
          let undone = false;
          const frag = document.createDocumentFragment();
          frag.createEl("span", {
            text: `Column "${col.displayTitle}" deleted. `,
          });
          const undoBtn = frag.createEl("a", { text: "Undo", href: "#" });
          undoBtn.classList.add("kanban-undo-btn");

          const notice = new Notice(frag, deleteFiles ? 5000 : 4000);
          undoBtn.addEventListener("click", (e) => {
            void (async () => {
              e.preventDefault();
              undone = true;
              notice.hide();
              this.columns = parseKanban(sourceSnapshot);
              this.source = sourceSnapshot;
              await this.saveAndRender();
              new Notice("Undo successful.", 2000);
            })();
          });

          if (deleteFiles) {
            setTimeout(() => {
              void (async () => {
                if (undone) return;
                for (const wt of uniqueFiles) {
                  const file = this.getLinkedFileByName(wt);
                  if (file) await this.obsApp.fileManager.trashFile(file);
                }
              })();
            }, 5000);
          }
        })();
      });
      colMenuEl.appendChild(delItem);

      // ── separator ──
      colMenuEl.appendChild(mkSep());

      // Change Color — swatch shows current color
      const colorItem = div("kanban-dropdown-item kanban-dropdown-color-item");
      const colorIconEl = el("span", { cls: "kanban-dropdown-icon" });
      si(colorIconEl, "palette");
      const colorItemSwatch = div("kanban-dropdown-color-swatch");
      setCssProps(colorItemSwatch, {
        background: col.bgColor || "transparent",
      });
      setCssProps(colorItemSwatch, {
        border: col.bgColor ? "none" : "1px dashed var(--text-muted)",
      });
      colorItem.appendChild(colorIconEl);
      colorItem.appendChild(el("span", { text: "Change color" }));
      colorItem.appendChild(colorItemSwatch);
      // ── color picker appended INSIDE colMenuEl so it's never "outside" ─────
      const colorPicker = el("input", { attr: { type: "color" } });
      colorPicker.className = "kanban-color-picker-input";
      colorPicker.value = col.bgColor || "#ffffff";
      colMenuEl.appendChild(colorPicker);
      // Position picker at right edge of dropdown after menu is mounted
      const positionPicker = () => {
        const menuRect = colMenuEl!.getBoundingClientRect();
        const spaceRight = window.innerWidth - menuRect.right;
        if (spaceRight >= 20) {
          // Enough space on right — place picker at right edge of dropdown, vertically at colorItem
          setCssProps(colorPicker, {
            position: "fixed",
            left: menuRect.right + "px",
            top: menuRect.top + menuRect.height / 2 + "px",
            width: "1px",
            height: "1px",
          });
        } else {
          // Not enough space — place at left edge so picker opens to the left
          setCssProps(colorPicker, {
            position: "fixed",
            left: menuRect.left + "px",
            top: menuRect.top + menuRect.height / 2 + "px",
            width: "1px",
            height: "1px",
          });
        }
      };
      const applyPickedColor = () => {
        const newColor = colorPicker.value;
        col.title = col.bgColor
          ? col.title.replace(BG_TAG_RE, `[bg:${newColor}]`)
          : `${col.displayTitle} [bg:${newColor}]`;
        const parsed = parseBgColor(col.title);
        col.displayTitle = parsed.displayTitle || "Untitled";
        col.bgColor = parsed.bgColor;
        closeColMenu();
        void this.saveAndRender();
      };

      // change fires when user picks a color and confirms/closes the native dialog
      colorPicker.addEventListener("change", applyPickedColor);

      colorItem.addEventListener("click", (e) => {
        e.stopPropagation();
        colorPicker.click();
      });

      colMenuEl.appendChild(colorItem);

      // Remove Color — only shown if column has a color
      if (col.bgColor) {
        const removeColorItem = mkItem("x-circle", "Remove color");
        removeColorItem.addEventListener("click", (e) => {
          e.stopPropagation();
          closeColMenu();
          col.title = col.title.replace(BG_TAG_RE, "").trim();
          const parsed = parseBgColor(col.title);
          col.displayTitle = parsed.displayTitle || "Untitled";
          col.bgColor = parsed.bgColor;
          void this.saveAndRender();
        });
        colMenuEl.appendChild(removeColorItem);
      }

      // Position dropdown
      setCssProps(colMenuEl, { position: "fixed" });
      colMenuEl.classList.add("kanban-measuring");
      document.body.appendChild(colMenuEl);
      const btnRect = gripBtn.getBoundingClientRect();
      setCssProps(colMenuEl, { left: btnRect.left + "px" });
      setCssProps(colMenuEl, { right: "auto" });

      // Flip up/down and clamp horizontal, then position color picker
      requestAnimationFrame(() => {
        const r = colMenuEl!.getBoundingClientRect();
        const spaceBelow = window.innerHeight - btnRect.bottom - 8;
        const spaceAbove = btnRect.top - 8;
        if (spaceBelow >= r.height || spaceBelow >= spaceAbove) {
          setCssProps(colMenuEl!, { top: btnRect.bottom + 4 + "px" });
        } else {
          setCssProps(colMenuEl!, { top: btnRect.top - r.height - 4 + "px" });
        }
        if (r.right > window.innerWidth - 8)
          setCssProps(colMenuEl!, {
            left: window.innerWidth - r.width - 8 + "px",
          });
        colMenuEl!.classList.remove("kanban-measuring");
        positionPicker();
      });

      const onOutside = (ev: MouseEvent) => {
        if (!colMenuEl?.contains(ev.target as Node)) {
          closeColMenu();
          document.removeEventListener("mousedown", onOutside, false);
          document.removeEventListener("keydown", onEsc, false);
        }
      };
      const onEsc = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeColMenu();
          document.removeEventListener("mousedown", onOutside, false);
          document.removeEventListener("keydown", onEsc, false);
        }
      };
      setTimeout(() => {
        document.addEventListener("mousedown", onOutside, false);
        document.addEventListener("keydown", onEsc, false);
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
    (cardsEl as unknown as Record<string, unknown>).__col_cards = sortedCards;
    cardsEl.dataset.colTitle = col.title;
    setCssProps(cardsEl, { maxHeight });
    cardsEl.classList.add("kanban-cards-scrollable");

    for (const card of sortedCards) {
      this.renderCard(cardsEl, card, col);
    }

    // ── Drop indicator line (shared, one per cards container) ──
    const dropIndicator = div("kanban-drop-indicator");
    cardsEl.appendChild(dropIndicator);

    const clearIndicator = () => {
      dropIndicator.classList.remove("kanban-visible");
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
      dropIndicator.classList.add("kanban-visible");
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
      if (this.selectMode) {
        this.shakeActionBar();
        return;
      }
      this.showAddCardInput(cardsEl, col);
    });

    const addCardBtn = el("button", { cls: "kanban-add-card-btn" });
    const addCardIcon = el("span", { cls: "kanban-add-card-icon" });
    si(addCardIcon, "plus");
    addCardBtn.appendChild(addCardIcon);
    addCardBtn.appendChild(el("span", { text: "Add card" }));
    if (this.selectMode) {
      addCardBtn.disabled = true;
      addCardBtn.classList.add("kanban-btn-disabled");
      addCardBtn.addEventListener("click", () => this.shakeActionBar());
    } else {
      addCardBtn.addEventListener("click", () =>
        this.showAddCardInput(cardsEl, col),
      );
    }
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
      if (this.selectMode) {
        e.preventDefault();
        return;
      }
      e.dataTransfer?.setData("text/plain", card.id);
      // Delay adding class so drag image captures the normal card look
      setTimeout(() => cardEl.classList.add("kanban-dragging"), 0);
    });
    cardEl.addEventListener("dragend", () => {
      cardEl.classList.remove("kanban-dragging");
      // Clean up any lingering drop indicators across all columns
      document.querySelectorAll(".kanban-drop-indicator").forEach((el) => {
        el.classList.add("kanban-hidden");
      });
    });

    const textEl = el("span", { cls: "kanban-card-text" });
    const wikilinkTarget = extractWikilink(card.text);
    if (wikilinkTarget) {
      // Resolve file — pages folder first, then legacy fallback
      const resolveWikiFile = () => {
        const kf = getFolderPath(this.ctx.sourcePath);
        const sub = parseNotesFolder(this.source);
        const nf = sub.startsWith("/")
          ? sub.slice(1)
          : kf
            ? `${kf}/${sub}`
            : sub;
        const inPages = this.obsApp.vault.getFileByPath(
          `${nf}/${wikilinkTarget}.md`,
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
            void leaf.openFile(file);
          }
        });
        textEl.appendChild(linkEl);
      } else {
        // ── File does not exist — render as ghost link with + badge ────────
        // Pill wrapper: [📄 FileName +]
        const ghostPill = el("span", { cls: "kanban-ghost-pill" });
        ghostPill.title = `Create note: ${wikilinkTarget}`;

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
          const sub = parseNotesFolder(this.source);
          const notesFolder = sub.startsWith("/")
            ? sub.slice(1)
            : kf
              ? `${kf}/${sub}`
              : sub;
          await this.ensureFolderPath(notesFolder);
          const filePath = `${notesFolder}/${wikilinkTarget}.md`;
          await this.obsApp.vault.create(filePath, `# ${wikilinkTarget}\n`);
          const newFile = this.obsApp.vault.getFileByPath(filePath);
          if (newFile) {
            const leaf = this.obsApp.workspace.getLeaf("split");
            void leaf.openFile(newFile);
          }
          this.render();
        };

        ghostPill.addEventListener("click", (e) => {
          void createPage(e);
        });
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
        setCssProps(tagEl, { backgroundColor: getTagColor(tag) });
        tagsEl.appendChild(tagEl);
      }
      cardEl.appendChild(tagsEl);
    }

    // ── Single ⋯ menu button ─────────────────────────────────────────────────
    const menuBtn = el("button", { cls: "kanban-card-menu-btn" });
    si(menuBtn, "more-horizontal");
    setTooltip(menuBtn, "Card options");

    // ── Helpers ──────────────────────────────────────────────────────────────
    // Full path to the _kanban-notes (or custom) folder for this kanban file
    const getNotesFolder = () => {
      const subFolder = parseNotesFolder(this.source);
      // Absolute path: starts with / → relative to vault root
      if (subFolder.startsWith("/")) return subFolder.slice(1);
      // Relative path: resolve relative to kanban file location
      const kanbanFolder = getFolderPath(this.ctx.sourcePath);
      return kanbanFolder ? `${kanbanFolder}/${subFolder}` : subFolder;
    };

    const getLinkedFile = () => {
      const wt = extractWikilink(card.text);
      if (!wt) return null;
      return this.resolveWikiFile(wt, getNotesFolder());
    };

    // ── Action handlers ───────────────────────────────────────────────────────
    const doEdit = () => {
      closeMenu();
      const textarea = el("textarea", { cls: "kanban-card-edit-input" });
      textarea.value = card.text;
      cardEl.replaceChildren();
      cardEl.appendChild(textarea);
      textarea.focus();
      const finish = () => {
        const newText = textarea.value.trim();
        if (newText) {
          card.text = newText;
          card.tags = newText.match(/#[\w-]+/g) || [];
          card.updatedAt = nowISO();
        }
        void this.saveAndRender();
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
      let deleteFile = false;

      if (linkedFile) {
        const wt = extractWikilink(card.text)!;

        // Find other cards linking to the same file
        const otherRefs: { colTitle: string }[] = [];
        for (const c of this.columns) {
          for (const cd of c.cards) {
            if (cd.id === card.id) continue;
            if (extractWikilink(cd.text) === wt) {
              otherRefs.push({ colTitle: c.displayTitle });
            }
          }
        }

        let msg = `Delete card <strong>"${wt}"</strong>?`;
        if (otherRefs.length > 0) {
          const cols = [...new Set(otherRefs.map((r) => r.colTitle))]
            .map((t) => `"${t}"`)
            .join(", ");
          msg += `<br><span class="kanban-modal-warn">⚠️ Also linked from: ${cols} — deleting the file will affect those cards too.</span>`;
        }

        const { confirmed, checked } = await kanbanConfirmWithCheckbox(
          msg,
          `Also delete ${wt}.md`,
          "Delete",
          true,
        );
        if (!confirmed) return;
        deleteFile = checked;
      } else {
        const confirmed = await kanbanConfirm(
          `Delete this card?`,
          cardEl,
          "Delete",
          true,
        );
        if (!confirmed) return;
      }

      // Soft delete: snapshot source string before delete for reliable undo
      const sourceSnapshot = this.source;
      col.cards = col.cards.filter((c) => c.id !== card.id);
      await this.saveAndRender();

      let undone = false;
      const frag = document.createDocumentFragment();
      frag.createEl("span", { text: "Card deleted. " });
      const undoBtn = frag.createEl("a", { text: "Undo", href: "#" });
      undoBtn.classList.add("kanban-undo-btn");

      const notice = new Notice(frag, deleteFile ? 5000 : 4000);
      undoBtn.addEventListener("click", (e) => {
        void (async () => {
          e.preventDefault();
          undone = true;
          notice.hide();
          this.columns = parseKanban(sourceSnapshot);
          this.source = sourceSnapshot;
          await this.saveAndRender();
          new Notice("Undo successful.", 2000);
        })();
      });

      if (deleteFile && linkedFile) {
        setTimeout(() => {
          void (async () => {
            if (!undone) await this.obsApp.fileManager.trashFile(linkedFile);
          })();
        }, 5000);
      }
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
      const notesFolder = getNotesFolder();
      await this.ensureFolderPath(notesFolder);

      const filePath = `${notesFolder}/${filename}.md`;

      // Case-insensitive search for existing file in pages folder
      // Case-insensitive file lookup: check exact path first, then scan folder
      let existingFile = this.obsApp.vault.getFileByPath(filePath) as {
        path: string;
        name: string;
      } | null;
      if (!existingFile) {
        const folder = this.obsApp.vault.getAbstractFileByPath(
          notesFolder,
        ) as unknown as { children?: { path: string; name: string }[] } | null;
        const children: { path: string; name: string }[] =
          folder?.children ?? [];
        existingFile =
          children.find(
            (f: { path: string; name: string }) =>
              f.path.toLowerCase() === filePath.toLowerCase(),
          ) ?? null;
      }
      const pageExists = !!existingFile;
      // Use the actual existing filename (correct case) if found
      const actualFilename = existingFile
        ? existingFile.name.slice(0, -3)
        : filename;
      const actualFilePath = existingFile ? existingFile.path : filePath;

      // Warn user if page already exists
      if (pageExists) {
        const caseChanged = actualFilename !== filename;
        let msg: string;
        if (caseChanged && restLines.length > 0) {
          msg = `A note named <strong>"${actualFilename}"</strong> already exists — your text <strong>"${filename}"</strong> will be matched to it.<br><span class="kanban-modal-warn">The extra lines will be discarded.</span>`;
        } else if (caseChanged) {
          msg = `A note named <strong>"${actualFilename}"</strong> already exists — your text <strong>"${filename}"</strong> will be matched to it.<br>The card will link to <strong>"${actualFilename}"</strong>.`;
        } else if (restLines.length > 0) {
          msg = `<strong>"${actualFilename}"</strong> already exists.<br><span class="kanban-modal-warn">The extra lines will be discarded.</span>`;
        } else {
          msg = `<strong>"${actualFilename}"</strong> already exists. The card will link to it.`;
        }
        const confirmed = await kanbanConfirm(msg, menuBtn, "Continue", false);
        if (!confirmed) return;
      }

      // Create file only if it doesn't exist yet
      if (!pageExists) {
        const pageContent =
          restLines.length > 0
            ? `# ${filename}\n\n${restLines.join("\n")}\n`
            : `# ${filename}\n`;
        await this.obsApp.vault.create(actualFilePath, pageContent);
      }

      // Card becomes [[actualFilename]] — use correct case
      const tags = (card.text.match(/#[\w-]+/g) || []).join(" ");
      card.text = tags
        ? `[[${actualFilename}]] ${tags}`
        : `[[${actualFilename}]]`;
      card.tags = card.text.match(/#[\w-]+/g) || [];
      card.updatedAt = nowISO();
      await this.saveAndRender();
    };

    const doRename = async () => {
      closeMenu();
      const linkedFile = getLinkedFile();
      if (!linkedFile) return;
      const currentName = linkedFile.name.slice(0, -3);
      const folder = getFolderPath(linkedFile.path); // keep file in its current folder

      const newName = await kanbanPrompt(
        "Rename note:",
        menuBtn,
        currentName,
        "Rename...",
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
      card.updatedAt = nowISO();
      await this.saveAndRender();
    };

    const openPropsSubmenu = (anchor: HTMLElement) => {
      // Remove existing submenu
      document.querySelector(".kanban-props-submenu")?.remove();

      const sub = div("kanban-props-submenu");

      // Header
      const hdr = div("kanban-props-header");
      hdr.appendChild(
        el("span", { cls: "kanban-props-header-title", text: "Properties" }),
      );
      sub.appendChild(hdr);

      // Tags row
      const row = div("kanban-props-row");
      const rowIcon = el("span", { cls: "kanban-props-label-icon" });
      si(rowIcon, "hash");
      const labelEl = el("span", { cls: "kanban-props-label", text: "Tags" });
      const currentTags = (card.text.match(/#[\w-]+/g) || []).join(" ");
      const input = el("input", { cls: "kanban-props-input" });
      input.value = currentTags;
      input.placeholder = "#tag1 #tag2";
      row.appendChild(rowIcon);
      row.appendChild(labelEl);
      row.appendChild(input);
      sub.appendChild(row);

      // Action row
      const actionRow = div("kanban-props-action-row");
      const saveBtn = el("button", { cls: "kanban-save-btn", text: "Save" });
      const cancelBtn = el("button", {
        cls: "kanban-cancel-btn",
        text: "Cancel",
      });

      const closeSub = () => sub.remove();

      const doSave = () => {
        const rawInput = input.value.trim();
        const newTags = rawInput
          .split(/\s+/)
          .filter((t: string) => t.length > 0)
          .map((t: string) => (t.startsWith("#") ? t : "#" + t))
          .join(" ");
        const wikiPart = extractWikilink(card.text);
        if (wikiPart) {
          card.text = newTags
            ? "[[" + wikiPart + "]] " + newTags
            : "[[" + wikiPart + "]]";
        } else {
          const base = card.text.replace(/#[\w-]+/g, "").trim();
          card.text = newTags ? base + " " + newTags : base;
        }
        card.tags = card.text.match(/#[\w-]+/g) || [];
        card.updatedAt = nowISO();
        closeSub();
        closeMenu();
        void this.saveAndRender();
      };

      cancelBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeSub();
      });
      saveBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        doSave();
      });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          doSave();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeSub();
        }
      });

      actionRow.appendChild(cancelBtn);
      actionRow.appendChild(saveBtn);
      sub.appendChild(actionRow);

      // Position: to the right of anchor (the menu item), aligned to its top
      setCssProps(sub, { position: "fixed" });
      document.body.appendChild(sub);
      const ar = anchor.getBoundingClientRect();
      const gap = 4;
      requestAnimationFrame(() => {
        const sr = sub.getBoundingClientRect();
        let left = ar.right + gap;
        if (left + sr.width > window.innerWidth - 8)
          left = ar.left - sr.width - gap;
        let top = ar.top + ar.height / 2 - sr.height / 2;
        if (top + sr.height > window.innerHeight - 8)
          top = window.innerHeight - sr.height - 8;
        if (top < 8) top = 8;
        setCssProps(sub, { left: left + "px" });
        setCssProps(sub, { top: top + "px" });
        input.focus();
        input.select();
      });

      // Close on outside mousedown (allow clicks inside sub and menuEl)
      const onSubOut = (e: MouseEvent) => {
        const target = e.target as Node;
        if (!sub.contains(target) && !menuEl?.contains(target)) {
          closeSub();
          closeMenu();
          document.removeEventListener("mousedown", onSubOut, false);
          document.removeEventListener("keydown", onSubEsc, false);
        } else if (!sub.contains(target)) {
          // Clicked inside main menu but outside sub — just close sub
          closeSub();
          document.removeEventListener("mousedown", onSubOut, false);
          document.removeEventListener("keydown", onSubEsc, false);
        }
      };
      const onSubEsc = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closeSub();
          document.removeEventListener("mousedown", onSubOut, false);
          document.removeEventListener("keydown", onSubEsc, false);
        }
      };
      setTimeout(() => {
        document.addEventListener("mousedown", onSubOut, false);
        document.addEventListener("keydown", onSubEsc, false);
      }, 0);
    };

    const doEditProperties = (anchor: HTMLElement) => {
      openPropsSubmenu(anchor);
    };

    const doOpenLeaf = (mode: "tab" | "split" | "window") => {
      closeMenu();
      const file = getLinkedFile();
      if (!file) return;
      void this.obsApp.workspace.getLeaf(mode).openFile(file);
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
        const tabItem = mkItem("folder-open", "Open in new tab");
        tabItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("tab");
        });
        menuEl.appendChild(tabItem);

        const rightItem = mkItem("panel-right-open", "Open to the right");
        rightItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("split");
        });
        menuEl.appendChild(rightItem);

        const winItem = mkItem("picture-in-picture-2", "Open in new window");
        winItem.addEventListener("click", (e) => {
          e.stopPropagation();
          doOpenLeaf("window");
        });
        menuEl.appendChild(winItem);

        menuEl.appendChild(mkSep());

        const renameItem = mkItem("pencil", "Rename...");
        renameItem.addEventListener("click", (e) => {
          e.stopPropagation();
          void doRename();
        });
        menuEl.appendChild(renameItem);

        const propsItem = mkItem("sliders-horizontal", "Properties...");
        // Show chevron arrow to indicate submenu
        const propsChevron = el("span", { cls: "kanban-dropdown-chevron" });
        si(propsChevron, "chevron-right");
        propsItem.appendChild(propsChevron);
        propsItem.addEventListener("mousedown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          doEditProperties(propsItem);
        });
        menuEl.appendChild(propsItem);

        const delItem = mkItem("trash-2", "Delete", "kanban-dropdown-danger");
        delItem.addEventListener("click", (e) => {
          e.stopPropagation();
          void doDelete();
        });
        menuEl.appendChild(delItem);
      } else if (isWikilink && !linkedFileExists) {
        // ── Wikilink card — file DOES NOT EXIST ──
        const createItem = mkItem("file-plus", "Create note");
        createItem.addEventListener("click", (e) => {
          e.stopPropagation();
          closeMenu();
          const kf = getFolderPath(this.ctx.sourcePath);
          const sub = parseNotesFolder(this.source);
          const notesFolder = sub.startsWith("/")
            ? sub.slice(1)
            : kf
              ? `${kf}/${sub}`
              : sub;
          void (async () => {
            await this.ensureFolderPath(notesFolder);
            const filePath = `${notesFolder}/${wikilinkText}.md`;
            await this.obsApp.vault.create(filePath, `# ${wikilinkText}\n`);
            const newFile = this.obsApp.vault.getFileByPath(filePath);
            if (newFile) {
              const leaf = this.obsApp.workspace.getLeaf("split");
              void leaf.openFile(newFile);
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
          void doDelete();
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

        const pageItem = mkItem("file-plus", "Convert to note");
        pageItem.addEventListener("click", (e) => {
          e.stopPropagation();
          void doConvertToPage();
        });
        menuEl.appendChild(pageItem);

        const delItem = mkItem("trash-2", "Delete", "kanban-dropdown-danger");
        delItem.addEventListener("click", (e) => {
          e.stopPropagation();
          void doDelete();
        });
        menuEl.appendChild(delItem);
      }

      const btnRect = menuBtn.getBoundingClientRect();
      setCssProps(menuEl, { position: "fixed" });
      menuEl.classList.add("kanban-measuring");
      document.body.appendChild(menuEl);
      requestAnimationFrame(() => {
        if (!menuEl) return;
        const r = menuEl.getBoundingClientRect();
        // Vertical: open below, flip up if not enough space
        const spaceBelow = window.innerHeight - btnRect.bottom - 8;
        const spaceAbove = btnRect.top - 8;
        if (spaceBelow >= r.height || spaceBelow >= spaceAbove) {
          setCssProps(menuEl, { top: btnRect.bottom + 4 + "px" });
        } else {
          setCssProps(menuEl, { top: btnRect.top - r.height - 4 + "px" });
        }
        // Horizontal: align left, flip if overflow right
        setCssProps(menuEl, { left: btnRect.left + "px" });
        setCssProps(menuEl, { right: "auto" });
        if (btnRect.left + r.width > window.innerWidth - 8) {
          setCssProps(menuEl, { left: window.innerWidth - r.width - 8 + "px" });
        }
        menuEl.classList.remove("kanban-measuring");
      });

      const onOutside = (ev: MouseEvent) => {
        if (!menuEl?.contains(ev.target as Node)) {
          closeMenu();
          document.removeEventListener("mousedown", onOutside, false);
          document.removeEventListener("keydown", onEsc, false);
        }
      };
      const onEsc = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeMenu();
          document.removeEventListener("mousedown", onOutside, false);
          document.removeEventListener("keydown", onEsc, false);
        }
      };
      setTimeout(() => {
        document.addEventListener("mousedown", onOutside, false);
        document.addEventListener("keydown", onEsc, false);
      }, 0);
    };

    // ── Quick edit/rename button (pencil) — visible on hover like menuBtn ──────
    const isWikilinkCard = !!extractWikilink(card.text);
    const isLinkedNoteCard = isWikilinkCard && !!getLinkedFile(); // wikilink + file exists
    const quickEditBtn = el("button", { cls: "kanban-card-quick-edit-btn" });
    si(quickEditBtn, "pencil");
    setTooltip(quickEditBtn, isLinkedNoteCard ? "Rename note..." : "Edit card");
    quickEditBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isLinkedNoteCard) {
        void doRename();
      } else {
        doEdit();
      }
    });

    // Mark card as note for filter
    if (extractWikilink(card.text)) cardEl.dataset.isNote = "1";

    // ── Properties row ───────────────────────────────────────────────────────
    if (this.showProps.size > 0) {
      const propsRow = div("kanban-card-props");

      if (this.showProps.has("updatedAt") && card.updatedAt) {
        const updEl = div("kanban-card-prop-updated");
        const iconEl = el("span", { cls: "kanban-card-prop-icon" });
        si(iconEl, "clock");
        updEl.appendChild(iconEl);
        updEl.appendChild(el("span", { text: relativeTime(card.updatedAt) }));
        propsRow.appendChild(updEl);
      }

      if (propsRow.children.length > 0) cardEl.appendChild(propsRow);
    }

    // ── Checkbox for multi-select ───────────────────────────────────────────
    const checkbox = el("input", { cls: "kanban-card-checkbox" });
    checkbox.type = "checkbox";
    checkbox.checked = this.selectedCards.has(card.id);
    if (checkbox.checked) cardEl.classList.add("kanban-card-selected");

    // Custom check icon overlay
    const checkIcon = div("kanban-card-check-icon");
    si(checkIcon, "check");
    checkIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      checkbox.click();
    });

    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      const allCardEls = Array.from(
        cardsEl.querySelectorAll<HTMLElement>(".kanban-card"),
      );
      const colCards =
        ((cardsEl as unknown as Record<string, unknown>)
          .__col_cards as KanbanCard[]) ?? [];
      this.toggleCardSelection(card.id, cardEl, allCardEls, colCards, false);
    });

    // Click in selectMode → select card; Ctrl/Shift/Cmd+click on link → disable link, select card
    cardEl.addEventListener("click", (e: MouseEvent) => {
      const hasModifier = e.shiftKey || e.ctrlKey || e.metaKey;
      const onLink = !!(e.target as HTMLElement).closest("a");
      if ((e.target as HTMLElement).closest("button, input")) return;
      // On a link without modifier → let default behaviour (open note)
      if (onLink && !hasModifier) return;
      // Not in selectMode and no modifier → normal card click, do nothing
      if (!this.selectMode && !hasModifier) return;
      e.preventDefault();

      const isRange = e.shiftKey;
      // Ctrl/Cmd or plain click in selectMode = single toggle

      // Auto-enable selectMode
      if (!this.selectMode) {
        this.selectMode = true;
        if (this.selectBtn)
          this.selectBtn.classList.add("kanban-toolbar-btn-active");
        this.boardEl?.classList.add("kanban-select-mode");
        setTimeout(
          () =>
            document.dispatchEvent(
              new CustomEvent("kanban-select-activated", {
                detail: { source: this },
              }),
            ),
          0,
        );
        this.render();
        // After render find fresh elements
        const newCardEl = this.boardEl?.querySelector<HTMLElement>(
          `[data-card-id="${card.id}"]`,
        );
        if (newCardEl) {
          const newCardsEl = newCardEl.closest<HTMLElement>(".kanban-cards");
          const allCardEls = newCardsEl
            ? Array.from(
                newCardsEl.querySelectorAll<HTMLElement>(".kanban-card"),
              )
            : [];
          const colCards = newCardsEl
            ? (((newCardsEl as unknown as Record<string, unknown>)
                .__col_cards as KanbanCard[]) ?? [])
            : [];
          this.toggleCardSelection(
            card.id,
            newCardEl,
            allCardEls,
            colCards,
            false,
          );
        }
        this.updateActionBar();
        return;
      }

      const allCardEls = Array.from(
        cardsEl.querySelectorAll<HTMLElement>(".kanban-card"),
      );
      const colCards =
        ((cardsEl as unknown as Record<string, unknown>)
          .__col_cards as KanbanCard[]) ?? [];
      // Pass shiftKey so toggleCardSelection knows to range-select vs single-toggle
      this.toggleCardSelection(card.id, cardEl, allCardEls, colCards, isRange);
    });

    menuBtn.addEventListener("click", openMenu);

    // Always append checkIcon (CSS controls visibility via .kanban-select-mode)
    cardEl.appendChild(checkbox);
    cardEl.appendChild(checkIcon);
    if (!this.selectMode) {
      cardEl.appendChild(quickEditBtn);
      cardEl.appendChild(menuBtn);
    }
    cardsEl.appendChild(cardEl);
  }

  private clearSelection() {
    this.selectedCards.clear();
    this.lastSelectedCardId = null;
    this.selectMode = false;
    if (this.selectBtn)
      this.selectBtn.classList.remove("kanban-toolbar-btn-active");
    this.boardEl
      ?.querySelectorAll(".kanban-card-selected")
      .forEach((el) => el.classList.remove("kanban-card-selected"));
    this.boardEl
      ?.querySelectorAll(".kanban-card-checkbox")
      .forEach((el) => ((el as HTMLInputElement).checked = false));
    this.hideActionBar();
    this.render();
  }

  private updateFilterSortBtns() {
    const sortActive = this.sortMode !== "none";
    const filterActive = this.filterTags.size > 0 || this.filterType !== "all";
    this.sortBtn2?.classList.toggle("kanban-toolbar-btn-outline", sortActive);
    this.filterBtn?.classList.toggle(
      "kanban-toolbar-btn-outline",
      filterActive,
    );
  }

  private shakeActionBar() {
    if (!this.actionBar) return;
    this.actionBar.classList.remove("kanban-bar-shake");
    // Force reflow so animation restarts
    void this.actionBar.offsetWidth;
    this.actionBar.classList.add("kanban-bar-shake");
    this.actionBar.addEventListener(
      "animationend",
      () => {
        this.actionBar?.classList.remove("kanban-bar-shake");
      },
      { once: true },
    );
  }

  private hideActionBar() {
    if (!this.actionBar) return;
    const bar = this.actionBar;
    this.actionBar = null;
    bar.classList.add("kanban-bar-hiding");
    bar.addEventListener("animationend", () => bar.remove(), { once: true });
  }

  private updateActionBar() {
    if (!this.selectMode) {
      this.hideActionBar();
      return;
    }
    if (!this.actionBar) {
      this.actionBar = div("kanban-action-bar");
      document.body.appendChild(this.actionBar);
    }
    this.actionBar.replaceChildren();

    const count = this.selectedCards.size;
    const countEl = el("span", {
      cls: "kanban-action-bar-count",
      text: `${count} card${count !== 1 ? "s" : ""} selected`,
    });
    const deleteBtn = el("button", {
      cls: "kanban-action-bar-delete",
      text: "Delete",
    });
    if (count === 0) {
      deleteBtn.disabled = true;
      deleteBtn.classList.add("kanban-btn-disabled");
    }
    const cancelBtn = el("button", {
      cls: "kanban-action-bar-cancel",
      text: "Cancel",
    });

    deleteBtn.addEventListener("click", () => {
      void (async () => {
        if (count === 0) return;
        await this.bulkDelete();
      })();
    });
    cancelBtn.addEventListener("click", () => this.clearSelection());

    this.actionBar.appendChild(countEl);
    this.actionBar.appendChild(deleteBtn);
    this.actionBar.appendChild(cancelBtn);
  }

  private async bulkDelete() {
    const ids = Array.from(this.selectedCards);
    const toDelete: { card: KanbanCard; col: KanbanColumn }[] = [];
    for (const col of this.columns) {
      for (const card of col.cards) {
        if (ids.includes(card.id)) toDelete.push({ card, col });
      }
    }

    // Collect unique linked files in selection
    const linkedEntries = toDelete
      .map(({ card }) => ({ card, wt: extractWikilink(card.text) }))
      .filter((x): x is { card: KanbanCard; wt: string } => !!x.wt);
    // Only include files that actually exist in vault
    const uniqueFiles = [...new Set(linkedEntries.map((x) => x.wt))].filter(
      (wt) => !!this.getLinkedFileByName(wt),
    );

    // Find cross-refs: files linked by cards NOT in selection
    const selectedIds = new Set(ids);
    const crossRefs: { wt: string; colTitle: string }[] = [];
    for (const wt of uniqueFiles) {
      for (const col of this.columns) {
        for (const card of col.cards) {
          if (selectedIds.has(card.id)) continue;
          if (extractWikilink(card.text) === wt) {
            crossRefs.push({ wt, colTitle: col.displayTitle });
          }
        }
      }
    }

    // Build message
    let msg = `Delete <strong>${toDelete.length} card${toDelete.length !== 1 ? "s" : ""}</strong>?`;
    if (uniqueFiles.length > 0) {
      const fileList = uniqueFiles.map((f) => `${f}.md`).join(", ");
      msg += `<br><span class="kanban-modal-filenote">${uniqueFiles.length} linked note${uniqueFiles.length !== 1 ? "s" : ""}: ${fileList}</span>`;
    }
    if (crossRefs.length > 0) {
      const affected = [
        ...new Set(crossRefs.map((r) => `"${r.wt}.md" (in "${r.colTitle}")`)),
      ].join(", ");
      msg += `<br><span class="kanban-modal-warn">⚠️ Also linked from other cards: ${affected} — deleting files will affect those cards too.</span>`;
    }

    let deleteFiles = false;
    if (uniqueFiles.length > 0) {
      const { confirmed, checked } = await kanbanConfirmWithCheckbox(
        msg,
        `Also delete ${uniqueFiles.length} linked file${uniqueFiles.length !== 1 ? "s" : ""}`,
        "Delete",
        true,
      );
      if (!confirmed) return;
      deleteFiles = checked;
    } else {
      const confirmed = await kanbanConfirm(msg, document.body, "Delete", true);
      if (!confirmed) return;
    }

    // Snapshot source string before delete for reliable undo
    const sourceSnapshot = this.source;

    for (const { card, col } of toDelete) {
      col.cards = col.cards.filter((c) => c.id !== card.id);
    }
    this.clearSelection();
    await this.saveAndRender();

    // Soft delete: show undo toast, trash files after 5s if not undone
    let undone = false;
    const n = toDelete.length;
    const frag = document.createDocumentFragment();
    frag.createEl("span", { text: `${n} card${n !== 1 ? "s" : ""} deleted. ` });
    const undoBtn = frag.createEl("a", { text: "Undo", href: "#" });
    undoBtn.classList.add("kanban-undo-btn");

    const notice = new Notice(frag, deleteFiles ? 5000 : 4000);
    undoBtn.addEventListener("click", (e) => {
      void (async () => {
        e.preventDefault();
        undone = true;
        notice.hide();
        this.columns = parseKanban(sourceSnapshot);
        this.source = sourceSnapshot;
        await this.saveAndRender();
        new Notice("Undo successful.", 2000);
      })();
    });

    if (deleteFiles) {
      setTimeout(() => {
        void (async () => {
          if (undone) return;
          for (const wt of uniqueFiles) {
            const file = this.getLinkedFileByName(wt);
            if (file) await this.obsApp.fileManager.trashFile(file);
          }
        })();
      }, 5000);
    }
  }

  /**
   * Resolve a wikilink target to a TFile.
   * Search order:
   *   1. notesFolder/wt.md  (configured folder)
   *   2. kanban folder/wt.md (legacy)
   *   3. vault root/wt.md
   *   4. Vault-wide: any file whose name matches wt.md (first match)
   */
  /** Create a folder and all parent folders if they don't exist */
  private async ensureFolderPath(folderPath: string) {
    const parts = folderPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.obsApp.vault.getAbstractFileByPath(current)) {
        await this.obsApp.vault.createFolder(current);
      }
    }
  }

  private resolveWikiFile(wt: string, notesFolder: string) {
    // 1. notesFolder
    const inNotes = this.obsApp.vault.getFileByPath(`${notesFolder}/${wt}.md`);
    if (inNotes) return inNotes;
    // 2. Legacy: same folder as kanban file
    const kf = getFolderPath(this.ctx.sourcePath);
    if (kf) {
      const inKanban = this.obsApp.vault.getFileByPath(`${kf}/${wt}.md`);
      if (inKanban) return inKanban;
    }
    // 3. Vault root
    const atRoot = this.obsApp.vault.getFileByPath(`${wt}.md`);
    if (atRoot) return atRoot;
    // 4. Vault-wide search by filename
    const filename = wt.includes("/") ? wt.split("/").pop()! : wt;
    const allFiles = this.obsApp.vault.getMarkdownFiles();
    return (
      allFiles.find(
        (f) => f.name === `${filename}.md` || f.name === `${wt}.md`,
      ) ?? null
    );
  }

  private getLinkedFileByName(wt: string) {
    const kf = getFolderPath(this.ctx.sourcePath);
    const sub = parseNotesFolder(this.source);
    const nf = sub.startsWith("/") ? sub.slice(1) : kf ? `${kf}/${sub}` : sub;
    const inPages = this.obsApp.vault.getFileByPath(`${nf}/${wt}.md`);
    if (inPages) return inPages;
    const legacy = kf ? `${kf}/${wt}.md` : `${wt}.md`;
    return this.obsApp.vault.getFileByPath(legacy);
  }

  private toggleCardSelection(
    cardId: string,
    cardEl: HTMLElement,
    allCardEls: HTMLElement[],
    allCards: KanbanCard[],
    shiftKey: boolean,
  ) {
    const ids = allCards.map((c) => c.id);

    if (shiftKey && this.anchorCardId) {
      // Range select: select anchor→target, deselect everything outside range
      const a = ids.indexOf(this.anchorCardId);
      const b = ids.indexOf(cardId);
      const [from, to] = a < b ? [a, b] : [b, a];

      // Deselect all cards in this column first, then re-select range
      ids.forEach((id, i) => {
        const inRange = i >= from && i <= to;
        const el = allCardEls[i];
        if (inRange) {
          this.selectedCards.add(id);
          if (el) {
            el.classList.add("kanban-card-selected");
            const cb = el.querySelector<HTMLInputElement>(
              ".kanban-card-checkbox",
            );
            if (cb) cb.checked = true;
          }
        } else {
          this.selectedCards.delete(id);
          if (el) {
            el.classList.remove("kanban-card-selected");
            const cb = el.querySelector<HTMLInputElement>(
              ".kanban-card-checkbox",
            );
            if (cb) cb.checked = false;
          }
        }
      });
      // lastSelectedCardId tracks end of range, anchor stays fixed
      this.lastSelectedCardId = cardId;
    } else {
      // Single toggle (plain click or Ctrl/Cmd+click)
      if (this.selectedCards.has(cardId)) {
        this.selectedCards.delete(cardId);
        cardEl.classList.remove("kanban-card-selected");
        const cb = cardEl.querySelector<HTMLInputElement>(
          ".kanban-card-checkbox",
        );
        if (cb) cb.checked = false;
        // If deselecting current anchor, clear it
        if (this.anchorCardId === cardId) this.anchorCardId = null;
      } else {
        this.selectedCards.add(cardId);
        cardEl.classList.add("kanban-card-selected");
        const cb = cardEl.querySelector<HTMLInputElement>(
          ".kanban-card-checkbox",
        );
        if (cb) cb.checked = true;
      }
      // Set new anchor on single select/deselect
      this.anchorCardId = this.selectedCards.has(cardId)
        ? cardId
        : (this.anchorCardId ?? null);
      this.lastSelectedCardId = cardId;
    }
    this.updateActionBar();
  }

  private showAddCardInput(cardsEl: HTMLElement, col: KanbanColumn) {
    const wrapper = div("kanban-add-input-wrapper");
    const textarea = el("textarea", {
      cls: "kanban-add-card-input",
      attr: {
        placeholder:
          "Card text... gunakan #tag\n(Enter simpan, Shift+Enter baris baru)",
      },
    });
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
          updatedAt: nowISO(),
        });
        void this.saveAndRender();
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

  private applyFilters(board: HTMLElement) {
    const q = this.searchQuery.trim().toLowerCase();
    const filterTags = this.filterTags;
    const filterType = this.filterType;
    const hasFilters = q || filterTags.size > 0 || filterType !== "all";
    const columns = board.querySelectorAll(".kanban-column");

    columns.forEach((colEl) => {
      const cards = colEl.querySelectorAll<HTMLElement>(".kanban-card");
      let visibleCount = 0;

      cards.forEach((cardEl) => {
        const textEl = cardEl.querySelector(
          ".kanban-card-text",
        ) as HTMLElement | null;
        if (!textEl) return;

        if (!cardEl.dataset.plainText) {
          cardEl.dataset.plainText = textEl.textContent ?? "";
        }
        const plainText = cardEl.dataset.plainText;
        const isNote = !!cardEl.dataset.isNote;

        const cardTagEls = Array.from(cardEl.querySelectorAll(".kanban-tag"));
        const cardTagTexts = cardTagEls.map((t) =>
          (t.textContent ?? "").toLowerCase(),
        );

        // Search match
        const searchMatch =
          !q ||
          plainText.toLowerCase().includes(q) ||
          cardTagTexts.join(" ").includes(q);

        // Tag filter match — card must have ALL selected filter tags
        const tagMatch =
          filterTags.size === 0 ||
          [...filterTags].every((ft) => cardTagTexts.includes(ft));

        // Type filter
        const typeMatch =
          filterType === "all" ||
          (filterType === "notes" && isNote) ||
          (filterType === "plain" && !isNote);

        const matches = searchMatch && tagMatch && typeMatch;
        cardEl.classList.toggle("kanban-hidden", !matches);

        if (matches && q) {
          const regex = new RegExp(`(${escapeRegex(q)})`, "gi");
          const linkEl = textEl.querySelector<HTMLElement>(".kanban-card-link");
          const ghostNameEl =
            textEl.querySelector<HTMLElement>(".kanban-ghost-name");
          if (linkEl) {
            if (!linkEl.dataset.plainLinkText)
              linkEl.dataset.plainLinkText = linkEl.textContent ?? "";
            applyHighlight(linkEl, linkEl.dataset.plainLinkText, regex);
          } else if (ghostNameEl) {
            if (!ghostNameEl.dataset.plainText)
              ghostNameEl.dataset.plainText = ghostNameEl.textContent ?? "";
            applyHighlight(ghostNameEl, ghostNameEl.dataset.plainText, regex);
          } else {
            if (!textEl.dataset.plainText)
              textEl.dataset.plainText = textEl.textContent ?? "";
            applyHighlight(textEl, textEl.dataset.plainText, regex);
          }
        } else {
          // Restore
          const linkEl = textEl.querySelector<HTMLElement>(".kanban-card-link");
          const ghostNameEl =
            textEl.querySelector<HTMLElement>(".kanban-ghost-name");
          if (linkEl && linkEl.dataset.plainLinkText) {
            linkEl.textContent = linkEl.dataset.plainLinkText;
          } else if (ghostNameEl && ghostNameEl.dataset.plainText) {
            ghostNameEl.textContent = ghostNameEl.dataset.plainText;
          } else if (textEl.dataset.plainText) {
            textEl.textContent = textEl.dataset.plainText;
          }
        }

        if (matches) visibleCount++;
      });

      let emptyMsg = colEl.querySelector<HTMLElement>(".kanban-search-empty");
      if (hasFilters && visibleCount === 0) {
        if (!emptyMsg) {
          emptyMsg = div("kanban-search-empty");
          emptyMsg.textContent = "No results";
          const cardsContainer = colEl.querySelector(".kanban-cards");
          cardsContainer?.appendChild(emptyMsg);
        }
        emptyMsg.classList.remove("kanban-hidden");
      } else if (emptyMsg) {
        emptyMsg.classList.add("kanban-hidden");
      }
    });
  }

  private showSortMenu(e: MouseEvent, anchor: HTMLElement) {
    e.stopPropagation();
    const existing = document.querySelector(".kanban-toolbar-menu");
    if (existing) {
      existing.remove();
      return;
    }

    const menu = div("kanban-card-dropdown kanban-toolbar-menu");
    const options: { label: string; value: SortMode; icon: string }[] = [
      { label: "Default", value: "none", icon: "minus" },
      { label: "Title A→Z", value: "title-asc", icon: "arrow-down-a-z" },
      { label: "Title Z→A", value: "title-desc", icon: "arrow-up-a-z" },
      {
        label: "Updated newest",
        value: "updated-desc",
        icon: "arrow-down-wide-narrow",
      },
      {
        label: "Updated oldest",
        value: "updated-asc",
        icon: "arrow-up-wide-narrow",
      },
      { label: "Tag A→Z", value: "tag-asc", icon: "tag" },
    ];
    for (const opt of options) {
      const item = div(
        "kanban-dropdown-item" +
          (this.sortMode === opt.value ? " kanban-dropdown-active" : ""),
      );
      const iconEl = el("span", { cls: "kanban-dropdown-icon" });
      si(iconEl, opt.icon);
      item.appendChild(iconEl);
      item.appendChild(el("span", { text: opt.label }));
      item.addEventListener("click", () => {
        this.sortMode = opt.value;
        menu.remove();
        // Save to source
        const tag = opt.value === "none" ? null : `[s:${opt.value}]`;
        this.source = updateDirective(this.source, SORT_RE, tag);
        void this.saveAndRender();
        this.updateFilterSortBtns();
      });
      menu.appendChild(item);
    }
    this.positionToolbarMenu(menu, anchor);
  }

  private showFilterMenu(e: MouseEvent, anchor: HTMLElement) {
    e.stopPropagation();
    const existing = document.querySelector(".kanban-toolbar-menu");
    if (existing) {
      existing.remove();
      return;
    }

    // Collect all tags from all cards
    const allTags = new Set<string>();
    for (const col of this.columns) {
      for (const card of col.cards) {
        card.tags.forEach((t) => allTags.add(t.toLowerCase()));
      }
    }

    const menu = div("kanban-card-dropdown kanban-toolbar-menu");

    // Type filter section
    const typeLabel = div("kanban-dropdown-section-label");
    typeLabel.textContent = "Type";
    menu.appendChild(typeLabel);
    const typeOptions: {
      label: string;
      value: "all" | "notes" | "plain";
      icon: string;
    }[] = [
      { label: "All cards", value: "all", icon: "layout-list" },
      { label: "Notes only", value: "notes", icon: "file-text" },
      { label: "Plain only", value: "plain", icon: "type" },
    ];
    for (const opt of typeOptions) {
      const item = div(
        "kanban-dropdown-item" +
          (this.filterType === opt.value ? " kanban-dropdown-active" : ""),
      );
      const iconEl = el("span", { cls: "kanban-dropdown-icon" });
      si(iconEl, opt.icon);
      item.appendChild(iconEl);
      item.appendChild(el("span", { text: opt.label }));
      item.addEventListener("click", () => {
        this.filterType = opt.value;
        menu.remove();
        if (this.boardEl) this.applyFilters(this.boardEl);
        this.updateFilterSortBtns();
      });
      menu.appendChild(item);
    }

    if (allTags.size > 0) {
      menu.appendChild(div("kanban-dropdown-sep"));
      const tagLabel = div("kanban-dropdown-section-label");
      tagLabel.textContent = "Tags";
      menu.appendChild(tagLabel);
      for (const tag of [...allTags].sort()) {
        const active = this.filterTags.has(tag);
        const item = div(
          "kanban-dropdown-item" + (active ? " kanban-dropdown-active" : ""),
        );
        const iconEl = el("span", { cls: "kanban-dropdown-icon" });
        si(iconEl, "hash");
        item.appendChild(iconEl);
        item.appendChild(el("span", { text: tag.replace(/^#/, "") }));
        item.addEventListener("click", () => {
          if (this.filterTags.has(tag)) this.filterTags.delete(tag);
          else this.filterTags.add(tag);
          menu.remove();
          if (this.boardEl) this.applyFilters(this.boardEl);
          this.updateFilterSortBtns();
        });
        menu.appendChild(item);
      }
    }

    // Clear filters
    if (this.filterTags.size > 0 || this.filterType !== "all") {
      menu.appendChild(div("kanban-dropdown-sep"));
      const clearItem = div("kanban-dropdown-item");
      const iconEl = el("span", { cls: "kanban-dropdown-icon" });
      si(iconEl, "x");
      clearItem.appendChild(iconEl);
      clearItem.appendChild(el("span", { text: "Clear filters" }));
      clearItem.addEventListener("click", () => {
        this.filterTags.clear();
        this.filterType = "all";
        menu.remove();
        if (this.boardEl) this.applyFilters(this.boardEl);
        this.updateFilterSortBtns();
      });
      menu.appendChild(clearItem);
    }

    this.positionToolbarMenu(menu, anchor);
  }

  private showPropsMenu(e: MouseEvent, anchor: HTMLElement) {
    e.stopPropagation();
    const existing = document.querySelector(".kanban-toolbar-menu");
    if (existing) {
      existing.remove();
      return;
    }

    const menu = div("kanban-card-dropdown kanban-toolbar-menu");
    const label = div("kanban-dropdown-section-label");
    label.textContent = "Show on cards";
    menu.appendChild(label);

    const props: { key: PropKey; label: string; icon: string }[] = [
      { key: "tags", label: "Tags", icon: "hash" },
      { key: "updatedAt", label: "Updated at", icon: "clock" },
    ];
    for (const prop of props) {
      const active = this.showProps.has(prop.key);
      const item = div(
        "kanban-dropdown-item" + (active ? " kanban-dropdown-active" : ""),
      );
      const iconEl = el("span", { cls: "kanban-dropdown-icon" });
      si(iconEl, prop.icon);
      const checkEl = el("span", { cls: "kanban-dropdown-check" });
      si(checkEl, active ? "check" : "");
      item.appendChild(iconEl);
      item.appendChild(el("span", { text: prop.label }));
      item.appendChild(checkEl);
      item.addEventListener("click", () => {
        if (this.showProps.has(prop.key)) this.showProps.delete(prop.key);
        else this.showProps.add(prop.key);
        menu.remove();
        // Save to source
        const propsStr = [...this.showProps].join(",");
        const tag = propsStr ? `[showProps:${propsStr}]` : null;
        this.source = updateDirective(this.source, SHOW_PROPS_RE, tag);
        void this.saveAndRender();
      });
      menu.appendChild(item);
    }
    this.positionToolbarMenu(menu, anchor);
  }

  private positionToolbarMenu(menu: HTMLElement, anchor: HTMLElement) {
    setCssProps(menu, { position: "fixed" });
    menu.classList.add("kanban-measuring");
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    setCssProps(menu, { right: window.innerWidth - r.right + "px" });
    setCssProps(menu, { left: "auto" });
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const spaceAbove = r.top - 8;
      if (spaceBelow >= mr.height || spaceBelow >= spaceAbove) {
        setCssProps(menu, { top: r.bottom + 4 + "px" });
      } else {
        setCssProps(menu, { top: r.top - mr.height - 4 + "px" });
      }
      if (mr.left < 4) {
        setCssProps(menu, { right: "auto", left: "4px" });
      }
      menu.classList.remove("kanban-measuring");
    });
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        menu.remove();
        document.removeEventListener("keydown", onEsc, false);
      }
    };
    const onOut = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", onOut, false);
        document.removeEventListener("keydown", onEsc, false);
      }
    };
    setTimeout(() => {
      document.addEventListener("mousedown", onOut, false);
      document.addEventListener("keydown", onEsc, false);
    }, 0);
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
    movedCard.updatedAt = nowISO();
    if (targetIndex < 0 || targetIndex >= targetCol.cards.length) {
      targetCol.cards.push(movedCard);
    } else {
      targetCol.cards.splice(targetIndex, 0, movedCard);
    }
    void this.saveAndRender();
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
    const addColItem = mkItem("plus-circle", "Add column");
    addColItem.addEventListener("click", () => {
      void (async () => {
        menu.remove();
        const anchor = this.containerEl;
        const name = await kanbanPrompt(
          "Column name:",
          anchor,
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
        await this.saveAndRender();
      })();
    });
    menu.appendChild(addColItem);

    menu.appendChild(mkSep());

    // ── Edit Directives ───────────────────────────────────────────────────────
    const editDirItem = mkItem("settings", "Edit directives");
    editDirItem.addEventListener("click", () => {
      menu.remove();
      this.showDirectivesModal();
    });
    menu.appendChild(editDirItem);

    menu.appendChild(mkSep());

    // ── Copy Source ───────────────────────────────────────────────────────────
    const copyItem = mkItem("clipboard", "Copy board source");
    copyItem.addEventListener("click", () => {
      menu.remove();
      navigator.clipboard
        .writeText("```kanban\n" + this.source + "\n```")
        .catch(() => {});
    });
    menu.appendChild(copyItem);

    menu.appendChild(mkSep());

    // ── Delete Kanban Block ───────────────────────────────────────────────────
    const deleteBlockItem = mkItem(
      "trash-2",
      "Delete kanban block",
      "kanban-ctx-item-danger",
    );
    deleteBlockItem.addEventListener("click", () => {
      void (async () => {
        menu.remove();
        const confirmed = await kanbanConfirm(
          `Delete this entire Kanban block? This cannot be undone.`,
          this.containerEl,
          "Delete",
          true,
        );
        if (!confirmed) return;

        const file = this.obsApp.vault.getFileByPath(this.ctx.sourcePath);
        if (!file) return;
        const fileContent = await this.obsApp.vault.read(file);
        const sectionInfo = this.ctx.getSectionInfo(this.containerEl);
        let newContent: string;

        if (sectionInfo) {
          const lines = fileContent.split("\n");
          // Remove from opening fence to closing fence (inclusive)
          const before = lines.slice(0, sectionInfo.lineStart).join("\n");
          const after = lines.slice(sectionInfo.lineEnd + 1).join("\n");
          newContent = before + (before && after ? "\n" : "") + after;
        } else {
          newContent = fileContent.replace(
            /```kanban\r?\n[\s\S]*?\r?\n```\n?/,
            "",
          );
        }

        await this.obsApp.vault.modify(file, newContent);
      })();
    });
    menu.appendChild(deleteBlockItem);

    // Position and show
    setCssProps(menu, { position: "fixed" });
    setCssProps(menu, { left: e.clientX + "px" });
    setCssProps(menu, { top: e.clientY + "px" });
    document.body.appendChild(menu);

    // Clamp to viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth)
        setCssProps(menu, { left: e.clientX - rect.width + "px" });
      if (rect.bottom > window.innerHeight)
        setCssProps(menu, { top: e.clientY - rect.height + "px" });
    });

    // Dismiss on outside click
    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        menu.remove();
        document.removeEventListener("mousedown", dismiss, false);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", dismiss, false), 0);
  }

  private showDirectivesModal() {
    // Parse current values — split into number + unit
    const curMaxHeight = parseMaxHeight(this.source);
    const curColWidth = parseColWidth(this.source);
    const curNotesFolder = parseNotesFolder(this.source);

    const extractNum = (val: string): string => {
      const match = val.match(/^([\d.]+)/);
      return match ? match[1] : val;
    };

    const mhSplit = { num: extractNum(curMaxHeight) };
    const cwSplit = { num: extractNum(curColWidth) };

    // Build modal
    const backdrop = document.createElement("div");
    backdrop.className = "kanban-modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "kanban-modal";
    modal.classList.add("kanban-props-modal-size");

    const title = document.createElement("p");
    title.className = "kanban-modal-msg";
    title.classList.add("kanban-props-modal-title");
    title.textContent = "Board directives";
    modal.appendChild(title);

    // Number + px field builder
    const mkUnitField = (label: string, numVal: string, minVal: number) => {
      const wrap = document.createElement("div");
      wrap.classList.add("kanban-props-wrap");
      const lbl = document.createElement("label");
      lbl.textContent = label;
      lbl.classList.add("kanban-props-field-label");

      const inputWrap = document.createElement("div");
      inputWrap.classList.add("kanban-directive-input-wrap");

      const numInp = document.createElement("input");
      numInp.type = "number";
      numInp.className = "kanban-modal-input kanban-directive-num-input";
      numInp.value = numVal;
      numInp.min = String(minVal);
      numInp.step = "1";

      const pxLabel = document.createElement("span");
      pxLabel.textContent = "px";
      pxLabel.classList.add("kanban-directive-unit-label");

      inputWrap.appendChild(numInp);
      inputWrap.appendChild(pxLabel);
      wrap.appendChild(lbl);
      wrap.appendChild(inputWrap);
      return { wrap, numInp };
    };

    // Text field builder (for notes folder)
    const mkTextField = (label: string, value: string, placeholder: string) => {
      const wrap = document.createElement("div");
      wrap.classList.add("kanban-props-wrap");
      const lbl = document.createElement("label");
      lbl.textContent = label;
      lbl.classList.add("kanban-props-field-label");
      const inp = document.createElement("input");
      inp.className = "kanban-modal-input";
      inp.value = value;
      inp.placeholder = placeholder;
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      return { wrap, inp };
    };

    const { wrap: mhWrap, numInp: mhNum } = mkUnitField(
      "Max height",
      mhSplit.num,
      50,
    );
    const { wrap: cwWrap, numInp: cwNum } = mkUnitField(
      "Column width",
      cwSplit.num,
      80,
    );
    const { wrap: nfWrap, inp: nfInp } = mkTextField(
      "Notes folder",
      curNotesFolder,
      "e.g. _kanban-notes or /Database/Clients",
    );

    // Reset to defaults button
    const resetRow = document.createElement("div");
    resetRow.classList.add("kanban-directive-reset-row");
    const resetBtn = document.createElement("button");
    resetBtn.classList.add("kanban-directive-reset-btn");
    resetBtn.textContent = "Reset to defaults";
    resetBtn.addEventListener("click", () => {
      mhNum.value = "400";
      cwNum.value = "240";
      nfInp.value = "_kanban-notes";
    });
    resetRow.appendChild(resetBtn);

    modal.appendChild(mhWrap);
    modal.appendChild(cwWrap);
    modal.appendChild(nfWrap);
    modal.appendChild(resetRow);

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
      const mhVal = Math.max(50, parseFloat(mhNum.value) || 400);
      const cwVal = Math.max(80, parseFloat(cwNum.value) || 240);
      const mh = `${mhVal}px`;
      const cw = `${cwVal}px`;
      const nf = nfInp.value.trim() || DEFAULT_NOTES_FOLDER;

      let newSource = this.source
        .split("\n")
        .filter(
          (l: string) =>
            !MAX_HEIGHT_RE.test(l.trim()) &&
            !COL_WIDTH_RE.test(l.trim()) &&
            !NOTES_FOLDER_RE.test(l.trim()) &&
            !VERSION_RE.test(l.trim()),
        )
        .join("\n");

      const newHeader = `[v:${CURRENT_FORMAT_VERSION}][maxHeight:${mh}][columnWidth:${cw}][notesFolder:${nf}]`;
      newSource = newHeader + "\n" + newSource.trimStart();

      this.source = newSource;
      this.columns = parseKanban(newSource);
      void this.saveAndRender();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    modal.appendChild(btnRow);
    backdrop.appendChild(modal);

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    mhNum.focus();
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
      // lineStart = opening fence, lineEnd = closing fence (inclusive)
      const before = lines.slice(0, sectionInfo.lineStart + 1).join("\n");
      const after = lines.slice(sectionInfo.lineEnd + 1).join("\n");
      // Guard: if after already starts with ``` it means lineEnd is stale — use regex fallback
      if (after.trimStart().startsWith("```")) {
        const newContent = content.replace(
          /```kanban\r?\n[\s\S]*?\r?\n```/,
          "```kanban\n" + newSource + "\n```",
        );
        await this.obsApp.vault.modify(file, newContent);
      } else {
        const joined =
          after.length > 0
            ? before + "\n" + newSource + "\n```\n" + after
            : before + "\n" + newSource + "\n```";
        await this.obsApp.vault.modify(file, joined);
      }
    } else {
      const newContent = content.replace(
        /```kanban\r?\n[\s\S]*?\r?\n```/,
        "```kanban\n" + newSource + "\n```",
      );
      if (newContent === content) {
        console.debug("Kanban: regex replace failed, content unchanged");
        return;
      }
      await this.obsApp.vault.modify(file, newContent);
    }
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
  onload() {
    console.debug("Kanban Block plugin loaded");

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
      id: "insert-block",
      name: "Insert block",
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
            .setTitle("Insert kanban block")
            .setIcon("layout-dashboard")
            .setSection("insert")
            .onClick(() => insertKanbanBlock(editor));
        });
      }),
    );
  }

  onunload() {
    document.getElementById("kanban-plugin-styles")?.remove();
    console.debug("Kanban Block plugin unloaded");
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
