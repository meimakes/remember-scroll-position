# Remember Scroll Position

An Obsidian plugin that remembers your cursor and scroll position for each note. Navigate away and come back — you'll be right where you left off.

## Features

- **Remembers cursor position** — line and column restored when you return to a note
- **Remembers scroll position** — no more scrolling back to find your place in long notes
- **Respects link navigation** — clicking `[[note#heading]]` links works normally (won't override with saved position)
- **Per-tab awareness** — same file in different splits/tabs tracks independently
- **Reading mode support** — works in both editing and reading modes
- **Bounded storage** — configurable limit on remembered positions (LRU eviction)
- **Mobile support** — works on iOS and Android
- **Lightweight** — event-driven, no polling, minimal performance impact

## How It Works

When you switch away from a note, the plugin saves your cursor and scroll position. When you open the note again, it restores you to exactly where you were.

The plugin uses Obsidian's native events (not polling) to track position changes, keeping CPU and memory usage minimal.

## Settings

- **Restore mode** — Choose between restoring cursor position (and centering it) or just scroll position
- **Max stored positions** — Limit how many note positions are remembered (default: 500)
- **Persist to disk** — Optionally save positions to a file so they survive app restarts
- **Restore delay** — Adjustable delay for compatibility with other plugins (default: 50ms)

## Installation

### From Obsidian Community Plugins
> **Status:** Submitted for review — pending addition to the community plugin directory. In the meantime, install manually (see below).

### Manual Installation
1. Download the latest release from GitHub
2. Extract to `.obsidian/plugins/remember-scroll-position/`
3. Enable in Settings → Community Plugins

## Author

**Mei Park** — [@meimakes](https://github.com/meimakes)

## License

MIT
