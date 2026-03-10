declare module "obsidian" {
  interface App {
    vault: Vault;
    workspace: Workspace;
  }

  interface Vault {
    read(file: TFile): Promise<string>;
    modify(file: TFile, data: string): Promise<void>;
    getFileByPath(path: string): TFile | null;
    create(path: string, data: string): Promise<TFile>;
    createFolder(path: string): Promise<void>;
    getAbstractFileByPath(path: string): { path: string } | null;
    trash(file: TFile, system: boolean): Promise<void>;
    rename(file: TFile, newPath: string): Promise<void>;
  }

  interface WorkspaceLeaf {
    openFile(file: TFile): Promise<void>;
  }

  interface Workspace {
    getLeaf(newLeaf?: boolean | "tab" | "split" | "window"): WorkspaceLeaf;
    getLeafBySplit(direction: "vertical" | "horizontal"): WorkspaceLeaf;
    on(
      event: "editor-menu",
      callback: (menu: Menu, editor: Editor) => void,
    ): EventRef;
  }

  interface EventRef {}

  interface Menu {
    addItem(cb: (item: MenuItem) => void): this;
    addSeparator(): this;
  }

  interface MenuItem {
    setTitle(title: string): this;
    setIcon(icon: string): this;
    setSection(section: string): this;
    onClick(cb: () => void): this;
  }

  interface Editor {
    getCursor(): { line: number; ch: number };
    replaceRange(
      replacement: string,
      from: { line: number; ch: number },
      to?: { line: number; ch: number },
    ): void;
    getLine(n: number): string;
    setCursor(pos: { line: number; ch: number }): void;
  }

  class TFile {
    path: string;
    name: string;
  }

  interface SectionInfo {
    lineStart: number;
    lineEnd: number;
  }

  interface MarkdownPostProcessorContext {
    sourcePath: string;
    addChild(child: MarkdownRenderChild): void;
    getSectionInfo(el: HTMLElement): SectionInfo | null;
  }

  class MarkdownRenderChild {
    containerEl: HTMLElement;
    constructor(containerEl: HTMLElement);
    onload(): void;
    onunload(): void;
  }

  class Plugin {
    app: App;
    addCommand(cmd: {
      id: string;
      name: string;
      editorCallback: (editor: Editor) => void;
    }): void;
    registerEvent(ref: EventRef): void;
    registerMarkdownCodeBlockProcessor(
      language: string,
      handler: (
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext,
      ) => void | Promise<void>,
    ): void;
    onload(): Promise<void> | void;
    onunload(): void;
  }

  function setIcon(el: HTMLElement, iconId: string): void;
  function setTooltip(
    el: HTMLElement,
    tooltip: string,
    options?: { placement?: string },
  ): void;
}
