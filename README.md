# Filesystem web app: backend stage

This stage supplies the Bun JSON API and CLI; it intentionally has no UI or executable packaging yet.

## Run

```sh
bun install
bun run typecheck
bun test
bun run start -- --config ./config.yaml
bun run start -- --config ./config.yaml --lan
```

Example `config.yaml` (paths are relative to this YAML file for `root`, and relative to the resolved root for `trash`):

```yaml
root: /srv/files
trash: .web-trash
port: 3000
limits:
  edit: 5242880
  preview: 26214400
  upload: 104857600
```

Create the root and optional trash directories before starting. Limits are positive integer **bytes**; omitted fields use defaults (5, 25 and 100 MiB). Trash must resolve strictly inside root. The root is canonicalized at startup and cannot change through the API. Listening defaults to `127.0.0.1`; `--lan` binds `0.0.0.0`. **There is no authentication:** only use `--lan` on a trusted private network or behind access controls. Do not expose the service to the public internet. It runs with its process's OS permissions.

## API contract

All paths are UTF-8 root-relative strings with `/` separators. Use `""` for root; leading slash, NUL, empty, `.` and `..` components are invalid. On Linux a backslash is an ordinary filename character and is supported (encode it in URL parameters). URL query parameters must be URL-encoded. JSON requests use `Content-Type: application/json`. All JSON responses use `Cache-Control: no-store`; errors have `{ "error": { "code": string, "message": string, "details"?: object } }`. Missing entries are 404, invalid inputs 400, out-of-root/reserved-trash paths 403, name/version conflicts 409, size limits 413, and non-text/unsupported previews 415. Damaged trash entries produce a 500 `TRASH_DAMAGED` error with their ID, rather than disappearing from the listing. The UI should present error messages and require explicit user choice before retrying conflicts. Mutations return JSON, never redirect.

| Method | Route | Input | Result |
|---|---|---|---|
| GET | `/api/config` | — | `{ limits: {edit,preview,upload}, trash: boolean }` (no filesystem root disclosure) |
| GET | `/api/list?path=…` | directory | `{ path, entries: Metadata[] }` |
| GET | `/api/metadata?path=…` | entry | `Metadata` |
| GET | `/api/text?path=…` | file | `{ path, content, version }`; UTF-8 editable files within edit limit only |
| GET | `/api/text-preview?path=…` | file | `{ path, content }`; read-only UTF-8 text within preview limit, including Markdown too large to edit |
| GET | `/api/raw?path=…` | file | attachment stream, no edit/preview size limit |
| GET | `/api/preview?path=…` | file | inline image (including SVG) or PDF, within preview limit |
| PUT | `/api/save` | `{ path, content, version, overwrite?: boolean }` | updated `{path,content,version}` |
| POST | `/api/create` | `{ path, kind: "file" \| "directory" }` | created metadata (201) |
| POST | `/api/upload?path=…&overwrite=true` | multipart `files` parts, one or more | array of metadata (201); overwrite defaults false |
| POST | `/api/move` | `{ source, destination, overwrite?: boolean }` | destination metadata; also renames |
| POST | `/api/delete` | `{ path, confirmed: true }` | `{ deleted: true, id?: string }` |
| GET | `/api/trash` | — | `[{id, original, deletedAt, kind, size}]` |
| POST | `/api/trash/:id/restore` | `{ destination?: string }` | restored metadata (original location unless destination supplied) |
| POST | `/api/trash/:id/purge` | `{ confirmed: true }` | `{ deleted: true }` |

`Metadata` is `{ path, name, kind: "file" | "directory" | "symlink" | "other", size, modified, link? }`; `modified` is ISO 8601. For links, `link` is `{ target, outside, dangling }`, where `target` is the raw symlink target. A missing internal target has `dangling: true, outside: false`; a missing external target has both true. Symlink loops are also marked unopenable with `dangling: true`, and attempting to open one returns `SYMLINK_LOOP`. Links pointing outside root or into reserved trash cannot be opened. Internal links may be browsed/read; to edit a symlink's target, use its direct path instead. Entries are sorted folders first, then modification time descending (with name tie-break). Hidden files are included by default; UI filtering and alternate sorting are client-side operations on the current listing.

`version` identifies the file bytes and filesystem identity/time at open. Normal save rejects changed versions with `VERSION_CONFLICT` and `details.version`; to deliberately overwrite, send the same request with `overwrite: true` after user confirmation. Save is explicit and creates a temporary file before replacing the original. `overwrite: true` for moves/uploads replaces only files or symlinks, **never directories**. Creation has no overwrite mode. Upload checks per-file limits and conflicts across the batch before starting writes; multipart requests have an additional aggregate cap of approximately ten times the per-file upload limit. A connection failure partway through a batch can leave earlier files uploaded; retry selectively. Render Markdown from `/api/text-preview` when read-only (or `/api/text` when editing); the binary `/api/preview` route is for images/PDFs only. Raw/preview responses have `nosniff`; preview uses a restrictive CSP and should be displayed through an `<img>` or browser PDF viewer, not injected as markup.

When trash is configured, confirmed delete moves the entry into a private UUID slot under trash. Normal paths cannot access that directory. Restore never overwrites: a name conflict responds 409 and the caller can supply a new `destination`. Restore requires the destination parent to exist. Purging requires explicit confirmation. Without trash, confirmed delete is permanent. Bulk existing-item actions are deliberately absent.

Mutations are serialized within one running server process, so simultaneous saves using one version and competing move/restore destinations cannot both succeed. This does not coordinate with other processes. Filesystem operations assume the root and its parent directories are controlled by the server operator. Path checks followed by rename cannot guarantee no-overwrite or confinement against an external process that creates a conflicting destination or replaces a directory with a symlink between validation and I/O; Bun's path-based rename API has no no-replace primitive. Do not expose a writable root to mutually untrusted local users or run multiple server instances against it.
