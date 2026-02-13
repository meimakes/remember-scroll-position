import { MarkdownView, Plugin } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS } from "./types";
import { PositionStore } from "./store";
import { PositionTracker } from "./tracker";
import { SettingsTab } from "./settings";

/**
 * Remember Scroll Position — an Obsidian plugin that remembers your cursor
 * and scroll position for each note.
 *
 * Navigate away and come back — you'll be right where you left off.
 */
export default class RememberScrollPositionPlugin extends Plugin {
	settings: PluginSettings;
	private store: PositionStore;
	private tracker: PositionTracker;

	async onload(): Promise<void> {
		console.log("[RSP] Remember Scroll Position v1.0.3 loading...");
		await this.loadSettings();

		this.store = new PositionStore(this, this.settings);
		await this.store.load();

		this.tracker = new PositionTracker(this, this.store, this.settings);
		this.tracker.register();

		this.addSettingTab(new SettingsTab(this.app, this));

		// Write a breadcrumb to confirm plugin loaded
		try {
			await this.app.vault.adapter.write(
				".obsidian/plugins/remember-scroll-position/loaded.txt",
				"Plugin loaded at " + new Date().toISOString()
			);
		} catch (e) {
			// ignore
		}

		// Debug: periodically write state to disk to diagnose issues
		this.registerInterval(
			window.setInterval(() => {
				const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
				const leaf = this.app.workspace.getMostRecentLeaf();
				const file = this.app.workspace.getActiveFile();
				const debugInfo = {
					time: new Date().toISOString(),
					activeFile: file?.path ?? "none",
					hasMarkdownView: !!mdView,
					leafViewType: leaf?.view?.getViewType?.() ?? "none",
					leafViewConstructor: leaf?.view?.constructor?.name ?? "none",
					viewMode: mdView?.getMode?.() ?? "n/a",
					storeSize: this.store.size,
				};
				this.app.vault.adapter.write(
					".obsidian/plugins/remember-scroll-position/debug.json",
					JSON.stringify(debugInfo, null, 2)
				);
			}, 3000)
		);

		console.log("[RSP] Plugin loaded successfully");
	}

	async onunload(): Promise<void> {
		await this.store.flush();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
