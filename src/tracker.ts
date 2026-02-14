import {
	debounce,
	Debouncer,
	FileView,
	// Note: MarkdownView is imported for type casting only.
	// Do NOT use `instanceof MarkdownView` — it fails at runtime because
	// esbuild bundles a different class reference than Obsidian's runtime.
	// Use `view.getViewType() === "markdown"` instead, then cast.
	MarkdownView,
	OpenViewState,
	Plugin,
	TAbstractFile,
	TFile,
	Workspace,
	WorkspaceLeaf,
} from "obsidian";
import { around } from "monkey-around";

import { PluginSettings, SavedPosition } from "./types";
import { PositionStore } from "./store";

/**
 * A WorkspaceLeaf with a typed FileView.
 */
interface FileLeaf extends WorkspaceLeaf {
	view: FileView;
}

/**
 * Core position tracking and restoration logic.
 *
 * Architecture:
 * - Event-driven: listens to scroll, file-open, cursor changes via Obsidian events
 * - No polling: uses debounced event handlers for minimal overhead
 * - Link-aware: monkey-patches openLinkText to detect intentional navigation
 * - Per-split tracking: same file in different splits gets independent positions
 * - LRU eviction: bounded memory via PositionStore
 *
 * Key lessons (from debugging):
 * - `instanceof MarkdownView` fails at runtime with esbuild — use getViewType()
 * - `editor.scrollIntoView()` scrolls to cursor visibility, NOT actual scroll offset
 * - `setEphemeralState({ scroll })` is the correct way to restore scroll position
 * - Saves must be blocked during file transitions to prevent overwriting with scroll=0
 */
export class PositionTracker {
	private store: PositionStore;
	private settings: PluginSettings;
	private plugin: Plugin;

	/** Tracks whether a link was used to open the current file */
	private linkUsed = false;

	/**
	 * Counter for in-progress file transitions.
	 * While > 0, position saves are blocked to prevent overwriting
	 * stored positions with scroll=0 from newly-loading files.
	 *
	 * Incremented by: active-leaf-change (with 1s safety timeout)
	 * Decremented by: restore completion (with 500ms settle delay)
	 */
	private filesOpening = 0;

	/** Whether the workspace has finished initial layout */
	private layoutReady: boolean;

	/** The last leaf we tracked, so we can save its position on switch-away */
	private lastLeaf: FileLeaf | null = null;

	/** Debounced state saver */
	private saveDebounced: Debouncer<[], void>;

	/** Debounced scroll handler */
	private onScrollDebounced: Debouncer<[Event], void>;

	constructor(plugin: Plugin, store: PositionStore, settings: PluginSettings) {
		this.plugin = plugin;
		this.store = store;
		this.settings = settings;
		this.layoutReady = plugin.app.workspace.layoutReady;

		this.saveDebounced = debounce(this.saveCurrentPosition.bind(this), 100, false);
		this.onScrollDebounced = debounce(this.handleScroll.bind(this), 100, false);
	}

	/**
	 * Register all event listeners. Call once during plugin load.
	 */
	register(): void {
		const app = this.plugin.app;

		// Monkey-patch openLinkText to detect link navigation
		if (this.settings.respectLinks) {
			this.plugin.register(
				around(Workspace.prototype, {
					openLinkText: (original: Workspace["openLinkText"]) => {
						return async (
							linktext: string,
							sourcePath: string,
							newLeaf?: boolean,
							openViewState?: OpenViewState
						): Promise<void> => {
							this.linkUsed = true;
							try {
								await original.call(
									app.workspace,
									linktext,
									sourcePath,
									newLeaf,
									openViewState
								);
							} finally {
								this.linkUsed = false;
							}
						};
					},
				})
			);
		}

		// File open — restore position
		this.plugin.registerEvent(
			app.workspace.on("file-open", (file: TFile | null) => { this.handleFileOpen(file); })
		);

		// Active leaf change — save outgoing leaf's position, then block saves
		// so the new file's initial scroll=0 doesn't overwrite anything.
		this.plugin.registerEvent(
			app.workspace.on("active-leaf-change", (newLeaf: WorkspaceLeaf | null) => {
				// Save the PREVIOUS leaf's position before it's gone
				this.saveDebounced.cancel();
				if (this.lastLeaf?.view?.file) {
					this.saveLeafPosition(this.lastLeaf);
				}

				// Track the new leaf for next switch
				if (newLeaf?.view && newLeaf.view.getViewType() === "markdown") {
					this.lastLeaf = newLeaf as FileLeaf;
				} else {
					this.lastLeaf = null;
				}

				this.filesOpening++;
				window.setTimeout(() => {
					this.filesOpening = Math.max(0, this.filesOpening - 1);
				}, 1000);
			})
		);

		// File delete — clean up stored position
		this.plugin.registerEvent(
			app.vault.on("delete", (file: TAbstractFile) => {
				this.store.delete(file.path);
			})
		);

		// File rename — update stored key
		this.plugin.registerEvent(
			app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				this.store.rename(oldPath, file.path);
			})
		);

		// Layout ready — restore all visible leaves on startup
		app.workspace.onLayoutReady(() => this.handleLayoutReady());

		// Scroll events via DOM — capture phase for all scrollable elements
		// Uses `document` (not `activeWindow.document`) for mobile compatibility
		this.plugin.registerDomEvent(
			document,
			"scroll",
			(e: Event) => this.onScrollDebounced(e),
			true
		);

		// Editor changes also trigger saves (cursor movement, typing)
		this.plugin.registerEvent(
			app.workspace.on("editor-change", () => this.saveDebounced())
		);

		// Periodic save as safety net
		this.plugin.registerInterval(
			window.setInterval(() => this.saveCurrentPosition(), 30000)
		);
	}

	/**
	 * Handle scroll events.
	 */
	private handleScroll(_event: Event): void {
		if (!this.layoutReady || this.filesOpening > 0) return;
		this.saveCurrentPosition();
	}

	/**
	 * Handle file open event. Restores saved position for the opened file.
	 */
	private handleFileOpen(_file: TFile | null): void {
		if (!this.layoutReady) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}

		// Don't override position when navigating via heading/block links
		if (this.settings.respectLinks) {
			const hasFlashing =
				this.plugin.app.workspace.containerEl.querySelector("span.is-flashing");
			if (hasFlashing || this.linkUsed) {
				this.filesOpening = Math.max(0, this.filesOpening - 1);
				return;
			}
		}

		const leaf = this.plugin.app.workspace.getMostRecentLeaf() as FileLeaf;
		if (!leaf?.view?.file) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}

		this.restorePosition(leaf);
	}

	/**
	 * Handle layout ready — restore all visible leaves on startup.
	 */
	private handleLayoutReady(): void {
		if (this.layoutReady) return;

		this.plugin.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
			if (leaf.view instanceof FileView) {
				this.restorePosition(leaf as FileLeaf);
			}
		});

		this.layoutReady = true;
	}

	/**
	 * Save position for a specific leaf (used when switching away).
	 */
	private saveLeafPosition(leaf: FileLeaf): void {
		if (!leaf?.view?.file) return;
		const key = this.getFileKey(leaf.view);
		if (!key) return;
		const position = this.capturePosition(leaf.view);
		if (position) {
			this.store.set(key, position);
		}
	}

	/**
	 * Save the current position of the active markdown view.
	 */
	private saveCurrentPosition(): void {
		if (!this.layoutReady || this.filesOpening > 0) return;

		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!leaf?.view || leaf.view.getViewType() !== "markdown") return;

		// Keep lastLeaf in sync
		this.lastLeaf = leaf as FileLeaf;

		const view = leaf.view as FileView;
		if (!view.file) return;

		const key = this.getFileKey(view);
		if (!key) return;
		const position = this.capturePosition(view);
		if (position) {
			this.store.set(key, position);
		}
	}

	/**
	 * Capture the current cursor and scroll position from a view.
	 */
	private capturePosition(view: FileView): SavedPosition | null {
		const timestamp = Date.now();

		if (view.getViewType() === "markdown") {
			const mdView = view as MarkdownView;
			if (mdView.getMode() === "source") {
				const cursor = mdView.editor.getCursor("head");
				const anchor = mdView.editor.getCursor("anchor");
				const scrollInfo = mdView.editor.getScrollInfo();
				const ephemeral = mdView.getEphemeralState() as { scroll?: number };

				return {
					timestamp,
					scroll: ephemeral?.scroll,
					scrollTop: scrollInfo?.top,
					cursor: {
						from: { line: anchor.line, ch: anchor.ch },
						to: { line: cursor.line, ch: cursor.ch },
					},
				};
			} else {
				// Reading mode
				const previewEl = view.containerEl.querySelector(".markdown-preview-view");
				if (previewEl) {
					return {
						timestamp,
						scrollTop: previewEl.scrollTop,
					};
				}
			}
		}

		return null;
	}

	/**
	 * Restore position for a leaf. Waits for the leaf to finish loading,
	 * applies the position, then re-saves it to prevent overwrite during
	 * the scroll settle period.
	 */
	private restorePosition(leaf: FileLeaf): void {
		if (!leaf?.view?.file) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}

		const key = this.getFileKey(leaf.view);
		if (!key) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}
		const saved = this.store.get(key);
		if (!saved) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}

		// Wait for the leaf to finish loading, then restore
		let attempts = 0;
		const maxAttempts = 50;
		const tryRestore = () => {
			if (leaf.working && attempts++ < maxAttempts) {
				window.requestAnimationFrame(tryRestore);
				return;
			}

			window.setTimeout(() => {
				this.applyPosition(leaf.view, saved);
				// Keep saves blocked while scroll settles (the restore triggers
				// scroll events we don't want to capture as "new" positions)
				window.setTimeout(() => {
					this.filesOpening = Math.max(0, this.filesOpening - 1);
				}, 500);
			}, this.settings.restoreDelay);
		};

		tryRestore();
	}

	/**
	 * Apply a saved position to a view.
	 *
	 * Important: uses setEphemeralState({ scroll }) for scroll restore,
	 * NOT editor.scrollIntoView() which only ensures cursor visibility.
	 */
	private applyPosition(view: FileView, saved: SavedPosition): void {
		if (view.getViewType() === "markdown") {
			const mdView = view as MarkdownView;
			if (mdView.getMode() === "source") {
				if (saved.cursor && this.settings.restoreCursor) {
					mdView.editor.setSelection(saved.cursor.from, saved.cursor.to);
				}
				if (saved.scroll !== undefined) {
					mdView.setEphemeralState({ scroll: saved.scroll });
				}
			} else {
				// Reading mode
				if (saved.scrollTop !== undefined) {
					const previewEl = view.containerEl.querySelector(
						".markdown-preview-view"
					);
					if (previewEl) {
						previewEl.scrollTop = saved.scrollTop;
					}
				}
			}
		}
	}

	/**
	 * Generate a unique key for a file view, incorporating split position
	 * so the same file in different tabs gets independent tracking.
	 */
	private getFileKey(view: FileView): string | null {
		if (!view.file) return null;
		const filePath = view.file.path;
		const splitId = this.getSplitId(view.leaf);
		return splitId ? `${filePath}#${splitId}` : filePath;
	}

	/**
	 * Get a string ID representing the split position of a leaf.
	 * Returns empty string for the primary (zero-indexed) leaf.
	 */
	private getSplitId(leaf: WorkspaceLeaf): string {
		if (!leaf?.parent?.parent) return "";

		const path: number[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let current: Record<string, unknown> = leaf.parent as unknown as Record<string, unknown>;

		while (current?.parent) {
			const parent = current.parent as Record<string, unknown>;
			const idx = (parent.children as unknown[])?.indexOf(current) ?? 0;
			path.unshift(idx);
			current = parent;
		}

		if (path.every((i) => i === 0)) return "";
		return path.join("-");
	}
}
