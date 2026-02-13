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

	/** The file path we're currently navigating away from (to save its position before overwrite) */
	private lastActiveFilePath: string | null = null;
	/** Cached position of the last active file, captured before the switch */
	private lastActivePosition: SavedPosition | null = null;

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
		// Note: active-leaf-change fires first (saves old position), then file-open fires (restores new)
		this.plugin.registerEvent(
			app.workspace.on("file-open", (file: TFile) => {
				// Small delay to ensure active-leaf-change save completed
				window.setTimeout(() => this.handleFileOpen(file), 50);
			})
		);

		// Active leaf change — block saves temporarily so the new file's
		// initial scroll=0 doesn't overwrite the previously saved position.
		// Uses a short timeout instead of a counter to avoid stuck states.
		this.plugin.registerEvent(
			app.workspace.on("active-leaf-change", () => {
				this.filesOpening++;
				// Safety timeout: always unblock saves after 1s even if restore doesn't fire
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

		// Scroll events via DOM — capture phase to catch all scrollable elements
		// Use document (not activeWindow.document) for mobile compatibility
		this.plugin.registerDomEvent(
			document,
			"scroll",
			(e: Event) => this.onScrollDebounced(e),
			true
		);

		// Also listen to editor changes as a save trigger
		this.plugin.registerEvent(
			app.workspace.on("editor-change", () => this.saveDebounced())
		);

		// Periodic save as safety net (every 5s)
		this.plugin.registerInterval(
			window.setInterval(() => this.saveCurrentPosition(), 5000)
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
		if (!this.layoutReady) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}

		// Check if a heading/block link was used
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

		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		if (!leaf?.view || leaf.view.getViewType() !== "markdown") return;
		const view = leaf.view as FileView;
		if (!view.file) return;

		const key = this.getFileKey(view);
		if (!key) return;
		const position = this.capturePosition(view);
		if (position) {
			console.log(`[RSP] Saving position for ${key}:`, position.scroll ?? position.scrollTop, position.cursor?.from);
			this.store.set(key, position);
		}
	}

	/**
	 * Capture the current position from a view.
	 * Uses getViewType() instead of instanceof because bundled class references
	 * don't match Obsidian's runtime classes.
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
	 * Restore position for a leaf.
	 */
	private restorePosition(leaf: FileLeaf): void {
		if (!leaf?.view?.file) return;

		const key = this.getFileKey(leaf.view);
		if (!key) {
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}
		const saved = this.store.get(key);
		if (!saved) {
			console.log(`[RSP] No saved position for ${key}`);
			this.filesOpening = Math.max(0, this.filesOpening - 1);
			return;
		}

		console.log(`[RSP] Restoring position for ${key}:`, saved.scroll ?? saved.scrollTop, saved.cursor?.from);

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
				// Re-save the restored position so subsequent saves don't overwrite
				// with scroll=0 before the scroll animation completes
				const rKey = this.getFileKey(leaf.view);
				if (rKey) {
					this.store.set(rKey, saved);
				}
				// Keep saves blocked a bit longer for scroll to settle
				window.setTimeout(() => {
					this.filesOpening = Math.max(0, this.filesOpening - 1);
				}, 500);
			}, this.settings.restoreDelay);
		};

		tryRestore();
	}

	/**
	 * Apply a saved position to a view.
	 * Uses getViewType() instead of instanceof for runtime compatibility.
	 */
	private applyPosition(view: FileView, saved: SavedPosition): void {
		if (view.getViewType() === "markdown") {
			const mdView = view as MarkdownView;
			if (mdView.getMode() === "source") {
				// Restore cursor selection if enabled
				if (saved.cursor && this.settings.restoreCursor) {
					mdView.editor.setSelection(saved.cursor.from, saved.cursor.to);
				}
				// Always restore scroll position (don't use scrollIntoView which
				// just ensures cursor visibility and ignores actual scroll offset)
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
