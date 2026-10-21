# Filesystem Web App — v1 Requirements

## Purpose

A self-hosted website for an individual developer to browse and manage files on a server they control. The app runs **on the server containing the files** and accesses its local filesystem; it does not connect over SFTP.

V1 is a responsive, installable PWA for desktop and mobile. Native apps and offline functionality are out of scope.

## Deployment and boundaries

- Start the app from the CLI with a path to a YAML configuration file. Use Commander.js for CLI parsing.
- Configure one filesystem root at startup. It remains fixed while the app runs and cannot be changed through the website.
- Confine browsing and file operations to that root. The app uses only the operating-system permissions of its process; it has no privilege escalation.
- Bind to localhost by default. A startup option permits direct LAN binding.
- Private-network access is a deployment requirement. App-level authentication and permissions are **out of scope for v1**.
- Package the Bun backend and React frontend as a standalone, single-file executable for Linux x64 and Linux ARM64, using Bun’s bundler rather than Vite. Runtime configuration remains in the supplied YAML file.

## Browsing and file management

- Browse directories and create files and folders.
- Upload one or multiple files, but not whole folders. Download files.
- Rename, move, and delete files and folders. Moving uses a keyboard-accessible destination picker. Bulk actions on existing items are out of scope.
- Show hidden files by default, with a toggle. Provide a filename filter for the **current directory only**.
- Sort folders first, then show the most recently modified entries first within each group by default. Offer common alternatives, including sorting by name and size.
- Refresh listings on navigation and after app actions; provide a manual Refresh control. Continuous filesystem watching is out of scope.
- Show symlinks as links and clearly display where they point. Targets outside the configured root must be clearly identified and cannot be opened. A symlink itself—including one pointing outside the root—may be renamed, moved, or deleted without changing its target.
- Never silently overwrite an existing name during upload, creation, rename, move, or restoration. Show the conflict and require an explicit choice.

### Deletion and trash

- Confirm deletion.
- A trash directory may be configured at startup, but must be inside the root. When configured, deletion moves items there; provide ways to view, restore, and permanently delete trashed items. Handle restoration name conflicts explicitly.
- If no trash directory is configured, confirmed deletion is permanent.

## Viewing and editing

- Determine whether a file is editable text from its contents, not just its extension. Support valid UTF-8 text; reject binary-looking or non-UTF-8 content from the editor.
- Use CodeMirror 6 for editing, with syntax highlighting, line numbers, find/replace, and undo/redo.
- Include Vim bindings in v1. Vim mode defaults **on for desktop** and **off for mobile**, can be toggled, and is remembered in that browser.
- Save only on explicit action. Warn before leaving with unsaved changes.
- If a file changes on the server after it is opened, block a normal save and offer a way to review the server version or deliberately overwrite it.
- Preview PDFs and common browser-supported images, including SVG. Render SVG as an image rather than inline page markup. Offer other file types for download.
- Provide an edit/preview mode for Markdown using Marked.js. Render embedded raw HTML **without sanitization or sandboxing**, as explicitly chosen. This lets file content execute code in the app’s page and is an accepted v1 security risk.

Default limits, all configurable at startup:

| Operation | Default limit | Above the limit |
|---|---:|---|
| Text editing | 5 MB | Download remains available |
| Preview | 25 MB | Download remains available |
| Upload | 100 MB per file | Reject with a clear error |

## Interaction and preferences

- Every v1 action must be possible without a mouse, including uploads, dialogs, conflicts, moving items, and trash recovery. Provide an in-app keyboard shortcut reference.
- Store Vim mode, hidden-file visibility, and sort preference in the browser, independently per browser. No account or server-side preference storage is required.
- The PWA requires a live connection. Do not provide offline browsing, editing, or file caching in v1; show a clear connection error when the server is unavailable.

## Preferred implementation choices

| Need | Preferred choice |
|---|---|
| CLI | Commander.js |
| YAML parsing and config validation | Bun’s built-in YAML parser and Zod |
| Server, frontend bundling, executable | Bun |
| Frontend | React |
| Accessible lists, controls, and dialogs | React Aria Components |
| Editor and Vim bindings | CodeMirror 6 and `@replit/codemirror-vim` |
| Markdown rendering | Marked.js |
| MIME type lookup | `mime` |
| Unit and integration tests | Bun test |
| Real-browser and keyboard/mobile tests | Playwright |

React Router, TanStack Query, and `react-dropzone` are optional if implementation reveals a need for them. Use browser-native image and PDF display unless testing shows a gap. Implement and test root confinement, symlink handling, save conflicts, and trash semantics specifically for this app rather than relying on a generic file-manager package.

## V1 acceptance criteria

V1 is complete when a developer can launch the packaged executable with a YAML config, reach it through the configured private-network setup, and perform every specified browse, preview, edit, upload, download, move, rename, delete, and restore flow using only a keyboard. Tests must also verify root confinement—including symlinks pointing outside it—explicit name and save conflicts, the configured size limits, and usable desktop and mobile layouts.
