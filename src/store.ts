import { Plugin, normalizePath } from "obsidian";
import { SavedPosition, PluginSettings } from "./types";

/**
 * Get or create a stable device ID stored in localStorage.
 * localStorage is device-local and never synced by Obsidian Sync,
 * making it ideal for distinguishing devices.
 */
function getDeviceId(): string {
	const key = "remember-scroll-position-device-id";
	let id = window.localStorage.getItem(key);
	if (!id) {
		// Generate a short random ID (8 hex chars)
		const arr = new Uint8Array(4);
		crypto.getRandomValues(arr);
		id = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
		window.localStorage.setItem(key, id);
	}
	return id;
}

/**
 * Manages the position state store with LRU eviction and optional disk persistence.
 *
 * Each device gets its own positions file (e.g., positions-a1b2c3d4.json)
 * to avoid sync conflicts when the vault is synced across multiple devices.
 */
export class PositionStore {
	private positions: Record<string, SavedPosition> = {};
	private plugin: Plugin;
	private settings: PluginSettings;
	private dirty = false;
	private writeTimer: number | null = null;
	private deviceId: string;

	/** Debounce interval for writing to disk (ms) */
	private static readonly WRITE_DEBOUNCE = 2000;

	constructor(plugin: Plugin, settings: PluginSettings) {
		this.plugin = plugin;
		this.settings = settings;
		this.deviceId = getDeviceId();
	}

	/**
	 * Get the device-specific file path for positions storage.
	 * Replaces "positions.json" with "positions-{deviceId}.json" in the configured path.
	 */
	getFilePath(): string {
		const base = this.settings.filePath;
		return base.replace(/positions\.json$/, `positions-${this.deviceId}.json`);
	}

	/**
	 * Load positions from disk if persistence is enabled.
	 */
	async load(): Promise<void> {
		if (!this.settings.persistToDisk) return;

		const filePath = normalizePath(this.getFilePath());
		try {
			if (await this.plugin.app.vault.adapter.exists(filePath)) {
				const data = await this.plugin.app.vault.adapter.read(filePath);
				if (data) {
					this.positions = JSON.parse(data);
				}
			} else {
				// Migration: try loading from the old shared positions.json
				const oldPath = normalizePath(this.settings.filePath);
				if (await this.plugin.app.vault.adapter.exists(oldPath)) {
					const data = await this.plugin.app.vault.adapter.read(oldPath);
					if (data) {
						this.positions = JSON.parse(data);
						this.dirty = true;
						// Write to the new device-specific file
						await this.writeToDisk();
					}
				}
			}
		} catch (e) {
			console.error("Remember Scroll Position: failed to load positions file:", e);
			this.positions = {};
		}
	}

	/**
	 * Get the saved position for a file key.
	 */
	get(key: string): SavedPosition | undefined {
		return this.positions[key];
	}

	/**
	 * Save a position for a file key.
	 */
	set(key: string, position: SavedPosition): void {
		this.positions[key] = position;
		this.dirty = true;
		this.evict();
		this.scheduleDiskWrite();
	}

	/**
	 * Remove a position by key.
	 */
	delete(key: string): void {
		if (key in this.positions) {
			delete this.positions[key];
			this.dirty = true;
			this.scheduleDiskWrite();
		}
	}

	/**
	 * Rename a key (for file renames).
	 */
	rename(oldKey: string, newKey: string): void {
		if (oldKey in this.positions) {
			this.positions[newKey] = this.positions[oldKey];
			delete this.positions[oldKey];
			this.dirty = true;
			this.scheduleDiskWrite();
		}
	}

	/**
	 * Get the number of stored positions.
	 */
	get size(): number {
		return Object.keys(this.positions).length;
	}

	/**
	 * Flush any pending writes to disk. Call on plugin unload.
	 */
	async flush(): Promise<void> {
		if (this.writeTimer !== null) {
			window.clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		if (this.dirty) {
			await this.writeToDisk();
		}
	}

	/**
	 * Evict oldest entries if over the limit.
	 */
	private evict(): void {
		if (this.settings.maxPositions <= 0) return;

		const keys = Object.keys(this.positions);
		if (keys.length <= this.settings.maxPositions) return;

		// Sort by timestamp ascending (oldest first)
		const sorted = keys.sort(
			(a, b) => (this.positions[a].timestamp ?? 0) - (this.positions[b].timestamp ?? 0)
		);

		// Remove oldest until within limit
		const toRemove = sorted.length - this.settings.maxPositions;
		for (let i = 0; i < toRemove; i++) {
			delete this.positions[sorted[i]];
		}
	}

	/**
	 * Schedule a debounced write to disk.
	 */
	private scheduleDiskWrite(): void {
		if (!this.settings.persistToDisk || this.writeTimer !== null) return;

		this.writeTimer = window.setTimeout(async () => {
			this.writeTimer = null;
			if (this.dirty) {
				await this.writeToDisk();
			}
		}, PositionStore.WRITE_DEBOUNCE);
	}

	/**
	 * Write positions to disk.
	 */
	private async writeToDisk(): Promise<void> {
		if (!this.settings.persistToDisk) return;

		const filePath = normalizePath(this.getFilePath());
		try {
			// Ensure directory exists
			const dir = filePath.substring(0, filePath.lastIndexOf("/"));
			if (dir && !(await this.plugin.app.vault.adapter.exists(dir))) {
				await this.plugin.app.vault.adapter.mkdir(dir);
			}

			const data = JSON.stringify(this.positions);
			await this.plugin.app.vault.adapter.write(filePath, data);
			this.dirty = false;
		} catch (e) {
			console.error("Remember Scroll Position: failed to write positions file:", e);
		}
	}
}
