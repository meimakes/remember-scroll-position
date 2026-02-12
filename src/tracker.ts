import {
	debounce,
	Debouncer,
	FileView,
	MarkdownView,
	OpenViewState,
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
 */
export class PositionTracker {
	private store: PositionStore;
	private settings: PluginSettings;
	private plugin: any; // RememberScrollPositionPlugin

	/** Tracks whether a link was used to open the current file */
	private linkUsed = false;

	/** Number of files currently in the process of opening */
	private filesOpening = 0;

	/** Set of leaf+file IDs we've already seen (to detect tab switches vs new opens) */
	private knownLeafFiles = new Set<string>();

	/** Whether the workspace has finished initial layout */
	private layoutReady: boolean;

	/** Debounced state saver */
	private saveDebounced: Debouncer<[], void>;

	/** Debounced scroll handler */
	private onScrollDebounced: Debouncer<[Event], void>;

	constructor(plugin: any, store: PositionStore, settings: PluginSettings) {
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
					openLinkText: (original: any) => {
						return async (
							linktext: string,
							sourcePath: string,
							newLeaf?: boolean,
							openViewState?: OpenViewState
						) => {
							this.linkUsed = true;
							try {
								return await original.call(
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
			app.workspace.on("file-open", (file: TFile) => this.handleFileOpen(file))
		);

		// Active leaf change — save position of the leaf we're leaving
		this.plugin.registerEvent(
			app.workspace.on("active-leaf-change", () => this.saveDebounced())
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

		// Scroll events via DOM — capture phase to catch all scrollable elements
		this.plugin.registerDomEvent(
			activeWindow.document,
			"scroll",
			(e: Event) => this.onScrollDebounced(e),
			true
		);

		// Periodic save as safety net (every 30s)
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
	 * Handle file open event.
	 */
	private handleFileOpen(_file: TFile | null): void {
		if (!this.layoutReady) return;

		// Check if a heading/block link was used
		if (this.settings.respectLinks) {
			const hasFlashing =
				this.plugin.app.workspace.containerEl.querySelector("span.is-flashing");
			if (hasFlashing || this.linkUsed) return;
		}

		const leaf = this.plugin.app.workspace.getMostRecentLeaf() as FileLeaf;
		if (!leaf?.view?.file) return;

		// Check if this is a tab switch (already opened) vs genuinely opening the file
		const leafFileId = leaf.id + ":" + leaf.view.file.path;
		const alreadyOpen = this.knownLeafFiles.has(leafFileId);
		this.refreshKnownLeaves();
		if (alreadyOpen) return;

		this.restorePosition(leaf);
	}

	/**
	 * Handle layout ready — restore all visible leaves.
	 */
	private handleLayoutReady(): void {
		if (this.layoutReady) return;

		this.plugin.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
			if (leaf.view instanceof FileView) {
				this.restorePosition(leaf as FileLeaf);
			}
		});

		this.layoutReady = true;
		this.refreshKnownLeaves();
	}

	/**
	 * Save the current position of the active view.
	 */
	private saveCurrentPosition(): void {
		if (!this.layoutReady || this.filesOpening > 0) return;

		const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
		if (!view?.file) return;

		const key = this.getFileKey(view);
		if (!key) return;
		const position = this.capturePosition(view);
		if (position) {
			this.store.set(key, position);
		}
	}

	/**
	 * Capture the current position from a view.
	 */
	private capturePosition(view: FileView): SavedPosition | null {
		const timestamp = Date.now();

		if (view instanceof MarkdownView) {
			if (view.getMode() === "source") {
				const cursor = view.editor.getCursor("head");
				const anchor = view.editor.getCursor("anchor");
				const scrollInfo = view.editor.getScrollInfo();

				// Ephemeral state gives us Obsidian's internal scroll value
				const ephemeral = view.getEphemeralState() as { scroll?: number };

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
	 * Restore position for a leaf.
	 */
	private restorePosition(leaf: FileLeaf): void {
		if (!leaf?.view?.file) return;

		const key = this.getFileKey(leaf.view);
		if (!key) return;
		const saved = this.store.get(key);
		if (!saved) return;

		this.filesOpening++;

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
				this.filesOpening--;
			}, this.settings.restoreDelay);
		};

		tryRestore();
	}

	/**
	 * Apply a saved position to a view.
	 */
	private applyPosition(view: FileView, saved: SavedPosition): void {
		if (view instanceof MarkdownView) {
			if (view.getMode() === "source") {
				if (saved.cursor && this.settings.restoreCursor) {
					view.editor.setSelection(saved.cursor.from, saved.cursor.to);
					view.editor.scrollIntoView(
						{ from: saved.cursor.from, to: saved.cursor.to },
						true
					);
				} else if (saved.scroll !== undefined) {
					view.setEphemeralState({ scroll: saved.scroll });
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
	 */
	private getSplitId(leaf: WorkspaceLeaf): string {
		if (!leaf?.parent?.parent) return "";

		const path: number[] = [];
		let current: any = leaf.parent;

		while (current?.parent) {
			const idx = current.parent.children?.indexOf(current) ?? 0;
			path.unshift(idx);
			current = current.parent;
		}

		if (path.every((i) => i === 0)) return "";
		return path.join("-");
	}

	/**
	 * Refresh the set of known leaf+file combinations.
	 */
	private refreshKnownLeaves(): void {
		this.knownLeafFiles.clear();
		this.plugin.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			if (leaf.view instanceof FileView && leaf.view.file) {
				this.knownLeafFiles.add(leaf.id + ":" + leaf.view.file.path);
			}
		});
	}
}
