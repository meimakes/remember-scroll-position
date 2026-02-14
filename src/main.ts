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

	onload(): void {
		const init = async () => {
			await this.loadSettings();

			this.store = new PositionStore(this, this.settings);
			await this.store.load();

			this.tracker = new PositionTracker(this, this.store, this.settings);
			this.tracker.register();

			this.addSettingTab(new SettingsTab(this.app, this));
		};
		init();
	}

	onunload(): void {
		this.store?.flush();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			{ filePath: this.defaultFilePath() },
			await this.loadData(),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private defaultFilePath(): string {
		return `${this.app.vault.configDir}/plugins/remember-scroll-position/positions.json`;
	}
}
