import { Plugin } from "obsidian";
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
		await this.loadSettings();

		this.store = new PositionStore(this, this.settings);
		await this.store.load();

		this.tracker = new PositionTracker(this, this.store, this.settings);
		this.tracker.register();

		this.addSettingTab(new SettingsTab(this.app, this));
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
