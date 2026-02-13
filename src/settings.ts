import { App, PluginSettingTab, Setting } from "obsidian";
import type RememberScrollPositionPlugin from "./main";

export class SettingsTab extends PluginSettingTab {
	plugin: RememberScrollPositionPlugin;

	constructor(app: App, plugin: RememberScrollPositionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Remember scroll position")
			.setHeading();

		new Setting(containerEl)
			.setName("Restore cursor position")
			.setDesc(
				"When enabled, restores your cursor position and scrolls to it. " +
				"When disabled, only restores scroll position."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.restoreCursor)
					.onChange(async (value) => {
						this.plugin.settings.restoreCursor = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Respect link navigation")
			.setDesc(
				"Don't override position when navigating via heading or block links " +
				"(e.g., [[note#heading]])."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.respectLinks)
					.onChange(async (value) => {
						this.plugin.settings.respectLinks = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum stored positions")
			.setDesc(
				"Limit how many note positions are remembered. Oldest are discarded first. " +
				"Set to 0 for unlimited."
			)
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(String(this.plugin.settings.maxPositions))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.maxPositions = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Persist across restarts")
			.setDesc(
				"Save positions to a file so they survive when Obsidian is closed and reopened."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.persistToDisk)
					.onChange(async (value) => {
						this.plugin.settings.persistToDisk = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Restore delay")
			.setDesc(
				"Delay in milliseconds before restoring position after opening a note. " +
				"Increase if position isn't restoring correctly (e.g., with slow-loading plugins)."
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 500, 10)
					.setValue(this.plugin.settings.restoreDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.restoreDelay = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
