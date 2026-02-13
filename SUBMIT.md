# I am submitting a new Community Plugin

- [x] I attest that I have done my best to deliver a high-quality plugin, am proud of the code I have written, and would recommend it to others. I commit to maintaining the plugin and being responsive to bug reports. If I am no longer able to maintain it, I will make reasonable efforts to find a successor maintainer or withdraw the plugin from the directory.

## Repo URL

Link to my plugin: https://github.com/meimakes/remember-scroll-position

## Release Checklist
- [x] I have tested the plugin on
  - [ ] Windows
  - [x] macOS
  - [ ] Linux
  - [ ] Android _(if applicable)_
  - [x] iOS _(if applicable)_
- [x] My GitHub release contains all required files (as individual files, not just in the source.zip / source.tar.gz)
  - [x] `main.js`
  - [x] `manifest.json`
  - [ ] `styles.css` _(optional)_ — not needed
- [x] GitHub release name matches the exact version number specified in my manifest.json (_**Note:** Use the exact version number, don't include a prefix `v`_)
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file.
- [x] My README.md describes the plugin's purpose and provides clear usage instructions.
- [x] I have read the developer policies at https://docs.obsidian.md/Developer+policies, and have assessed my plugin's adherence to these policies.
- [x] I have read the tips in https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines and have self-reviewed my plugin to avoid these common pitfalls.
- [x] I have added a license in the LICENSE file.
- [x] My project respects and is compatible with the original license of any code from other plugins that I'm using.
      I have given proper attribution to these other projects in my `README.md`.

---

## Before submitting (for Mei)

1. **Make repo public** (it's currently private)
2. **Fork obsidianmd/obsidian-releases** from meimakes
3. **Add this to the END of community-plugins.json:**
```json
{
  "id": "remember-scroll-position",
  "name": "Remember Scroll Position",
  "author": "Mei Park",
  "description": "Remembers your cursor and scroll position for each note. Navigate away and come back — you will be right where you left off.",
  "repo": "meimakes/remember-scroll-position"
}
```
4. Open PR — paste everything above the `---` line as the PR body
