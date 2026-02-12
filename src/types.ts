import { EditorRange } from "obsidian";

/**
 * Saved state for a single note/view.
 */
export interface SavedPosition {
	/** Unix timestamp of when this position was last updated */
	timestamp: number;
	/** Scroll position (Obsidian's internal scroll value for source mode) */
	scroll?: number;
	/** Raw scrollTop for reading mode / non-markdown views */
	scrollTop?: number;
	/** Cursor selection range */
	cursor?: EditorRange;
}

/**
 * Plugin settings.
 */
export interface PluginSettings {
	/** Restore cursor position (true) or just scroll position (false) */
	restoreCursor: boolean;
	/** Maximum number of positions to remember (0 = unlimited) */
	maxPositions: number;
	/** Save positions to disk for persistence across restarts */
	persistToDisk: boolean;
	/** Path to the persistence file */
	filePath: string;
	/** Delay in ms before restoring position after file open */
	restoreDelay: number;
	/** Respect heading/block link navigation (don't override) */
	respectLinks: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	restoreCursor: true,
	maxPositions: 500,
	persistToDisk: true,
	filePath: ".obsidian/plugins/remember-scroll-position/positions.json",
	restoreDelay: 50,
	respectLinks: true,
};
