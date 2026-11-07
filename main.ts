import { App, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFile, getAllTags } from 'obsidian';
import type { Editor, FuzzyMatch, SettingDefinitionItem } from 'obsidian';

import {
  buildPool,
  folderCounts,
  parseList,
  pickRandom,
  propertyPairs,
  pushRecent,
  renameRecent,
  tagCounts,
} from './src/logic.ts';
import type { Candidate, Filter } from './src/logic.ts';

type OpenIn = 'current' | 'tab' | 'split';

interface Settings {
  openIn: OpenIn;
  /** How many of the latest draws a new draw avoids. 0 turns it off. */
  avoidRepeats: number;
  /** One folder or tag per entry, comma or line separated. */
  excludeFolders: string;
  excludeTags: string;
  ribbon: boolean;
  /** Say how many notes the draw chose from. */
  showPoolSize: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  openIn: 'current',
  avoidRepeats: 20,
  excludeFolders: '',
  excludeTags: '',
  ribbon: false,
  showPoolSize: false,
};

interface Data extends Settings {
  recent: string[];
}

/** What a command asks for: a filter plus how it reads in notices. */
interface Draw {
  filter: Filter;
  label: string;
}

/** The part of the core Search pane's view that lists its results. It is not in the public typings. */
interface SearchViewLike {
  dom?: { getFiles?: () => TFile[] };
}

export default class RandomNoteFiltersPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  recent: string[] = [];
  private lastDraw: Draw | null = null;
  private ribbonEl: HTMLElement | null = null;

  async onload() {
    const saved = ((await this.loadData()) ?? {}) as Partial<Data>;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    this.recent = Array.isArray(saved.recent) ? saved.recent.filter((p): p is string => typeof p === 'string') : [];

    const draw = (id: string, name: string, icon: string, make: () => Draw | Promise<Draw | null> | null) =>
      this.addCommand({
        id,
        name,
        icon,
        callback: async () => {
          const d = await make();
          if (d) await this.run(d);
        },
      });

    draw('open-random-note', 'Open a random note', 'dices', () => ({ filter: {}, label: 'the vault' }));
    draw('open-random-in-current-folder', 'Open a random note in the current folder', 'folder-open', () => {
      const file = this.app.workspace.getActiveFile();
      if (!file) return this.say('Open a note first: its folder is where the draw looks.');
      const folder = file.parent?.isRoot() ? '' : (file.parent?.path ?? '');
      return { filter: { folder }, label: folder ? `the folder ${folder}` : 'the vault root' };
    });
    draw('open-random-with-current-tag', 'Open a random note sharing a tag with this one', 'tag', () => {
      const file = this.app.workspace.getActiveFile();
      const cache = file ? this.app.metadataCache.getFileCache(file) : null;
      const tags = cache ? (getAllTags(cache) ?? []) : [];
      if (!tags.length) return this.say('This note has no tags to draw from.');
      const tag = tags[Math.floor(Math.random() * tags.length)];
      return { filter: { tag }, label: `the tag ${tag}` };
    });
    draw('open-random-from-search', 'Open a random note from the search results', 'search', () => this.searchDraw());
    draw('open-random-orphan', 'Open a random note that nothing links to', 'unlink', () => ({ filter: { orphansOnly: true }, label: 'notes nothing links to' }));
    draw('open-random-by-tag', 'Open a random note with a tag...', 'hash', () => this.pickTag());
    draw('open-random-by-folder', 'Open a random note in a folder...', 'folder', () => this.pickFolder());
    draw('open-random-by-property', 'Open a random note with a property value...', 'list-filter', () => this.pickProperty());
    draw('open-random-again', 'Open another random note with the same filter', 'refresh-cw', () => {
      if (!this.lastDraw) return this.say('Nothing to repeat yet. Open a random note first.');
      return this.lastDraw;
    });

    this.addCommand({
      id: 'insert-link-to-random-note',
      name: 'Insert a link to a random note',
      icon: 'link',
      editorCallback: (editor: Editor, view) => this.insertLink(editor, view.file, { filter: {}, label: 'the vault' }),
    });
    this.addCommand({
      id: 'insert-link-to-random-note-from-search',
      name: 'Insert a link to a random note from the search results',
      icon: 'link',
      editorCallback: (editor: Editor, view) => {
        const d = this.searchDraw();
        if (d) this.insertLink(editor, view.file, d);
      },
    });

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.recent.includes(oldPath)) {
          this.recent = renameRecent(this.recent, oldPath, file.path);
          void this.persist();
        }
      }),
    );

    this.addSettingTab(new RandomSettingTab(this.app, this));
    this.applyRibbon();
  }

  async persist() {
    const data: Data = { ...this.settings, recent: this.recent };
    await this.saveData(data);
  }

  async saveSettings() {
    await this.persist();
    this.applyRibbon();
  }

  applyRibbon() {
    this.ribbonEl?.remove();
    this.ribbonEl = null;
    if (this.settings.ribbon) {
      this.ribbonEl = this.addRibbonIcon('dices', 'Open a random note', () => void this.run({ filter: {}, label: 'the vault' }));
    }
  }

  /** The recent picks a new draw skips: the last `avoidRepeats` of them, none when it is 0. */
  private avoided(): string[] {
    const n = Math.max(0, Math.round(this.settings.avoidRepeats) || 0);
    return n > 0 ? this.recent.slice(-n) : [];
  }

  private say(text: string): null {
    new Notice(text);
    return null;
  }

  /** Everything the pickers and draws choose from: one entry per Markdown note. */
  candidates(): Candidate[] {
    const { vault, metadataCache } = this.app;
    const incoming = new Map<string, number>();
    for (const [src, targets] of Object.entries(metadataCache.resolvedLinks)) {
      for (const dest of Object.keys(targets)) if (dest !== src) incoming.set(dest, (incoming.get(dest) ?? 0) + 1);
    }
    return vault.getMarkdownFiles().map((f) => {
      const cache = metadataCache.getFileCache(f);
      return {
        path: f.path,
        tags: cache ? (getAllTags(cache) ?? []) : [],
        backlinks: incoming.get(f.path) ?? 0,
        props: cache?.frontmatter ?? {},
      };
    });
  }

  /** The files the Search pane lists now, as a draw. Null (with a notice) when there is none. */
  searchDraw(): Draw | null {
    const view = this.app.workspace.getLeavesOfType('search')[0]?.view as unknown as SearchViewLike | undefined;
    if (!view) return this.say('Open the Search pane and run a search first. The core Search plugin must be on.');
    let files: TFile[] = [];
    try {
      files = view.dom?.getFiles?.() ?? [];
    } catch {
      files = [];
    }
    const paths = new Set(files.filter((f) => f instanceof TFile && f.extension === 'md').map((f) => f.path));
    if (!paths.size) return this.say('The search has no note results. Run a search first.');
    return { filter: { paths }, label: 'the search results' };
  }

  async run(d: Draw) {
    this.lastDraw = d;
    const s = this.settings;
    const pool = buildPool(this.candidates(), d.filter, { folders: parseList(s.excludeFolders), tags: parseList(s.excludeTags) }, this.app.workspace.getActiveFile()?.path);
    const path = pickRandom(
      pool.map((c) => c.path),
      this.avoided(),
      Math.random,
    );
    if (!path) {
      new Notice(`No other note to pick in ${d.label}.`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    this.recent = pushRecent(this.recent, path, s.avoidRepeats);
    await this.persist();
    const leaf = this.app.workspace.getLeaf(s.openIn === 'current' ? false : s.openIn);
    await leaf.openFile(file);
    if (s.showPoolSize) new Notice(`${file.basename} (1 of ${pool.length} in ${d.label})`);
  }

  insertLink(editor: Editor, from: TFile | null, d: Draw) {
    const s = this.settings;
    const pool = buildPool(this.candidates(), d.filter, { folders: parseList(s.excludeFolders), tags: parseList(s.excludeTags) }, from?.path);
    const path = pickRandom(
      pool.map((c) => c.path),
      this.avoided(),
      Math.random,
    );
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(file instanceof TFile)) {
      new Notice(`No other note to link in ${d.label}.`);
      return;
    }
    this.recent = pushRecent(this.recent, file.path, s.avoidRepeats);
    void this.persist();
    const link = this.app.fileManager.generateMarkdownLink(file, from?.path ?? '');
    const cursor = editor.getCursor('from');
    // One range edit replaces the selection (or inserts at the cursor), so one undo takes it back.
    editor.transaction({ changes: [{ from: cursor, to: editor.getCursor('to'), text: link }] });
  }

  private pickTag(): Promise<Draw | null> {
    const tags = tagCounts(this.candidates());
    if (!tags.length) return Promise.resolve(this.say('No tags in this vault.'));
    return new Promise((resolve) => {
      new ChoiceModal(this.app, 'Draw from a tag', tags, (t) => `#${t.tag} (${t.count})`, (t) => resolve(t ? { filter: { tag: t.tag }, label: `the tag #${t.tag}` } : null)).open();
    });
  }

  private pickFolder(): Promise<Draw | null> {
    const folders = [{ folder: '', count: this.app.vault.getMarkdownFiles().length }, ...folderCounts(this.candidates())];
    return new Promise((resolve) => {
      new ChoiceModal(this.app, 'Draw from a folder', folders, (f) => `${f.folder || '/'} (${f.count})`, (f) => resolve(f ? { filter: { folder: f.folder }, label: `the folder ${f.folder || '/'}` } : null)).open();
    });
  }

  private pickProperty(): Promise<Draw | null> {
    const pairs = propertyPairs(this.candidates());
    if (!pairs.length) return Promise.resolve(this.say('No note has properties with values to draw from.'));
    return new Promise((resolve) => {
      new ChoiceModal(this.app, 'Draw from a property value', pairs, (p) => `${p.key}: ${p.value} (${p.count})`, (p) =>
        resolve(p ? { filter: { property: { key: p.key, value: p.value } }, label: `${p.key}: ${p.value}` } : null),
      ).open();
    });
  }
}

/** A fuzzy list that answers once: with the chosen item, or null when it is dismissed. */
class ChoiceModal<T> extends FuzzySuggestModal<T> {
  private done = false;

  constructor(
    app: App,
    placeholder: string,
    private items: T[],
    private text: (item: T) => string,
    private answer: (item: T | null) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.modalEl.addClass('random-note-filters-modal');
  }

  getItems(): T[] {
    return this.items;
  }

  getItemText(item: T): string {
    return this.text(item);
  }

  onChooseItem(item: T) {
    this.done = true;
    this.answer(item);
  }

  selectSuggestion(value: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent) {
    // The base class closes the modal first, then chooses; flag it so onClose does not answer null.
    this.done = true;
    super.selectSuggestion(value, evt);
  }

  onClose() {
    super.onClose();
    // Wait a tick: onChooseItem runs after close.
    window.setTimeout(() => {
      if (!this.done) this.answer(null);
    }, 0);
  }
}

const TEXT = {
  openIn: { name: 'Open the note in', desc: 'Where the drawn note opens.' },
  avoidRepeats: {
    name: 'Avoid repeats',
    desc: 'A draw skips the last notes it picked, so you see everything before anything comes back. Zero allows repeats.',
  },
  excludeFolders: { name: 'Excluded folders', desc: 'Notes in these folders are never drawn. Separate folders with commas, for example templates, archive.' },
  excludeTags: { name: 'Excluded tags', desc: 'Notes with these tags, or tags nested under them, are never drawn. For example private, template.' },
  showPoolSize: { name: 'Show how many notes were in the draw', desc: 'A short notice after each draw.' },
  ribbon: { name: 'Ribbon button', desc: 'Adds a dice button to the left ribbon that opens a random note from the whole vault.' },
  forget: { name: 'Forget the notes already picked', desc: 'Lets any note come up again right away.' },
};

const OPEN_IN: Record<OpenIn, string> = { current: 'The current tab', tab: 'A new tab', split: 'A split' };

class RandomSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: RandomNoteFiltersPlugin,
  ) {
    super(app, plugin);
  }

  /** Obsidian 1.13+ renders and indexes these for the settings search; older versions call `display()`. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const d = DEFAULT_SETTINGS;
    return [
      { ...TEXT.openIn, control: { type: 'dropdown', key: 'openIn', options: OPEN_IN, defaultValue: d.openIn } },
      { ...TEXT.avoidRepeats, control: { type: 'number', key: 'avoidRepeats', min: 0, max: 200, defaultValue: d.avoidRepeats } },
      { ...TEXT.excludeFolders, control: { type: 'text', key: 'excludeFolders', placeholder: 'templates, archive', defaultValue: d.excludeFolders } },
      { ...TEXT.excludeTags, control: { type: 'text', key: 'excludeTags', placeholder: 'private, template', defaultValue: d.excludeTags } },
      { ...TEXT.showPoolSize, control: { type: 'toggle', key: 'showPoolSize', defaultValue: d.showPoolSize } },
      { ...TEXT.ribbon, control: { type: 'toggle', key: 'ribbon', defaultValue: d.ribbon } },
      { ...TEXT.forget, action: () => this.forget() },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: key === 'avoidRepeats' ? Math.max(0, Math.round(Number(value) || 0)) : value });
    await this.plugin.saveSettings();
  }

  private forget() {
    this.plugin.recent = [];
    void this.plugin.persist();
    new Notice('Cleared the list of recent picks.');
  }

  /** The pre-1.13 rendering, from the same text. */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const set = (key: string, value: unknown) => void this.setControlValue(key, value);

    new Setting(containerEl)
      .setName(TEXT.openIn.name)
      .setDesc(TEXT.openIn.desc)
      .addDropdown((dd) => dd.addOptions(OPEN_IN).setValue(s.openIn).onChange((v) => set('openIn', v)));
    new Setting(containerEl)
      .setName(TEXT.avoidRepeats.name)
      .setDesc(TEXT.avoidRepeats.desc)
      .addText((t) => t.setValue(String(s.avoidRepeats)).onChange((v) => set('avoidRepeats', v)));
    new Setting(containerEl)
      .setName(TEXT.excludeFolders.name)
      .setDesc(TEXT.excludeFolders.desc)
      .addText((t) => t.setValue(s.excludeFolders).onChange((v) => set('excludeFolders', v)));
    new Setting(containerEl)
      .setName(TEXT.excludeTags.name)
      .setDesc(TEXT.excludeTags.desc)
      .addText((t) => t.setValue(s.excludeTags).onChange((v) => set('excludeTags', v)));
    new Setting(containerEl)
      .setName(TEXT.showPoolSize.name)
      .setDesc(TEXT.showPoolSize.desc)
      .addToggle((t) => t.setValue(s.showPoolSize).onChange((v) => set('showPoolSize', v)));
    new Setting(containerEl)
      .setName(TEXT.ribbon.name)
      .setDesc(TEXT.ribbon.desc)
      .addToggle((t) => t.setValue(s.ribbon).onChange((v) => set('ribbon', v)));
    new Setting(containerEl)
      .setName(TEXT.forget.name)
      .setDesc(TEXT.forget.desc)
      .addButton((b) => b.setButtonText('Forget').onClick(() => this.forget()));
  }
}
