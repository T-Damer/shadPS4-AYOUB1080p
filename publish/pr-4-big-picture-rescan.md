# Big Picture: rescan an empty game list every 2 s

Branch: `T-Damer:fix/big-picture-empty-list-rescan` -> `weshayoub92:main`

After closing a game, Big Picture sometimes came back with an empty game list, which stayed empty
until the emulator was restarted.
While the list is empty, Big Picture now scans again every 2 seconds. A game whose param.sfo can't
be read is now logged instead of being skipped silently.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
