import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, search } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { vim } from '@replit/codemirror-vim';
import { marked } from 'marked';
import './style.css';

type Entry = { path: string; name: string; kind: 'file' | 'directory' | 'symlink' | 'other'; size: number; modified: string; link?: { target: string; outside: boolean; dangling: boolean } };
type TrashEntry = { id: string; original: string; deletedAt: string; kind: string; size: number };
type Config = { limits: { edit: number; preview: number; upload: number }; trash: boolean };
type ApiProblem = Error & { code?: string; details?: { version?: string; path?: string } };
const url = (route: string, path: string) => `${route}?path=${encodeURIComponent(path)}`;
const raw = (path: string) => url('/api/raw', path);
const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').at(-1) || 'Root';
const readable = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024 ** Math.floor(Math.log(bytes) / Math.log(1024))).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][Math.floor(Math.log(bytes) / Math.log(1024))] ?? 'TB'}`;
async function api<T>(route: string, method = 'GET', data?: object | FormData): Promise<T> {
  let response: Response;
  try { response = await fetch(route, { method, body: data instanceof FormData ? data : data === undefined ? undefined : JSON.stringify(data), headers: data && !(data instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined, cache: 'no-store' }); }
  catch { throw Object.assign(new Error('Cannot connect to the server. This app requires a live connection; reconnect and refresh.'), { code: 'OFFLINE' }); }
  if (!response.ok) {
    let problem: { error?: { code?: string; message?: string; details?: object } } = {};
    try { problem = await response.json(); } catch { /* non-JSON server error */ }
    throw Object.assign(new Error(problem.error?.message || `Server returned HTTP ${response.status}`), { code: problem.error?.code, details: problem.error?.details });
  }
  return response.json() as Promise<T>;
}
function preference<T>(key: string, fallback: T): T { try { const value = localStorage.getItem(key); return value === null ? fallback : JSON.parse(value) as T; } catch { return fallback; } }
function Editor({ value, onChange, name, vimMode }: { value: string; onChange: (value: string) => void; name: string; vimMode: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange); callback.current = onChange;
  const vimSlot = useRef(new Compartment());
  useEffect(() => {
    const language = /\.md(?:own)?$/i.test(name) ? markdown() : /\.[jt]sx?$/i.test(name) ? javascript({ jsx: true, typescript: /tsx?$/.test(name) }) : /\.json$/i.test(name) ? json() : /\.css$/i.test(name) ? css() : /\.html?$/i.test(name) ? html() : [];
    const editor = new EditorView({ parent: container.current!, state: EditorState.create({ doc: value, extensions: [lineNumbers(), history(), search(), syntaxHighlighting(defaultHighlightStyle), language, EditorView.contentAttributes.of({ 'aria-label': `Text editor for ${name}` }), vimSlot.current.of(vimMode ? vim() : []), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]), EditorView.lineWrapping, EditorView.updateListener.of(update => { if (update.docChanged) callback.current(update.state.doc.toString()); })] }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [name]);
  useEffect(() => { view.current?.dispatch({ effects: vimSlot.current.reconfigure(vimMode ? vim() : []) }); }, [vimMode]);
  return <div className="editor" ref={container} aria-label={`Text editor for ${name}`} />;
}

function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [trash, setTrash] = useState<TrashEntry[] | null>(null);
  const [hidden, setHidden] = useState(() => preference('files.hidden', true));
  const [sort, setSort] = useState(() => preference('files.sort', 'recent'));
  const [vimMode, setVimMode] = useState(() => preference('files.vim', !matchMedia('(max-width: 700px)').matches));
  const [filter, setFilter] = useState('');
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [version, setVersion] = useState('');
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [serverCopy, setServerCopy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<'create' | 'rename' | 'move' | 'delete' | 'restore' | 'purge' | 'shortcuts' | 'conflict' | null>(null);
  const [draft, setDraft] = useState('');
  const [createKind, setCreateKind] = useState<'file' | 'directory'>('file');
  const [moving, setMoving] = useState<Entry | null>(null);
  const [trashed, setTrashed] = useState<TrashEntry | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [pickerEntries, setPickerEntries] = useState<Entry[]>([]);
  const uploadInput = useRef<HTMLInputElement>(null);
  const dirty = !!selected && editing && content !== saved;
  const error = useCallback((problem: unknown) => setMessage((problem as Error).message || 'Something went wrong'), []);
  const list = useCallback(async (path: string) => { const result = await api<{ entries: Entry[] }> (url('/api/list', path)); setEntries(result.entries); setDirectory(path); }, []);
  const refresh = useCallback(async () => { try { if (trash) setTrash(await api<TrashEntry[]>('/api/trash')); else await list(directory); setMessage(''); } catch (problem) { error(problem); } }, [directory, trash, list, error]);
  useEffect(() => { api<Config>('/api/config').then(setConfig).catch(error); list('').catch(error); }, []);
  useEffect(() => { localStorage.setItem('files.hidden', JSON.stringify(hidden)); }, [hidden]);
  useEffect(() => { localStorage.setItem('files.sort', JSON.stringify(sort)); }, [sort]);
  useEffect(() => { localStorage.setItem('files.vim', JSON.stringify(vimMode)); }, [vimMode]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  const mayLeave = () => !dirty || window.confirm('Discard unsaved changes?');
  const navigate = async (path: string) => { if (!mayLeave()) return; try { await list(path); setSelected(null); setTrash(null); setFilter(''); setEditing(false); setMessage(''); } catch (problem) { error(problem); } };
  const showTrash = async () => { if (!mayLeave()) return; try { setTrash(await api<TrashEntry[]>('/api/trash')); setSelected(null); setMessage(''); } catch (problem) { error(problem); } };
  const open = async (entry: Entry) => {
    if (entry.link?.outside || entry.link?.dangling) { setMessage(`Cannot open link → ${entry.link.target} (${entry.link.outside ? 'outside root' : 'unavailable'}).`); return; }
    if (entry.kind === 'directory' || entry.kind === 'symlink') {
      if (!mayLeave()) return;
      try { await list(entry.path); setSelected(null); setTrash(null); setFilter(''); setEditing(false); return; }
      catch (problem) { if (entry.kind === 'directory') { error(problem); return; } }
    }
    if (!mayLeave()) return;
    setSelected(entry); setEditing(false); setPreview(false); setServerCopy(null); setMessage('');
    if (/\.md(?:own)?$/i.test(entry.name)) {
      try { const text = await api<{ content: string; version: string }>(url('/api/text', entry.path)); setContent(text.content); setSaved(text.content); setVersion(text.version); setEditing(true); return; }
      catch (problem) { if ((problem as ApiProblem).code !== 'SIZE_LIMIT') { error(problem); return; } }
      try { const text = await api<{ content: string }>(url('/api/text-preview', entry.path)); setContent(text.content); setSaved(text.content); setPreview(true); setMessage('This file exceeds the editing limit; preview is read-only.'); } catch (problem) { error(problem); }
    } else if (/\.(pdf|png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i.test(entry.name)) {
      if (entry.size > (config?.limits.preview ?? 0)) setMessage('This file exceeds the preview limit. Download remains available.');
      else setPreview(true);
    } else {
      try { const text = await api<{ content: string; version: string }>(url('/api/text', entry.path)); setContent(text.content); setSaved(text.content); setVersion(text.version); setEditing(true); }
      catch (problem) { setMessage(`${(problem as Error).message}. Download remains available.`); }
    }
  };
  const save = async (overwrite = false) => {
    if (!selected) return;
    try { const updated = await api<{ content: string; version: string }>('/api/save', 'PUT', { path: selected.path, content, version, overwrite }); setSaved(updated.content); setVersion(updated.version); setServerCopy(null); setDialog(null); setMessage('Saved.'); }
    catch (problem) { if ((problem as ApiProblem).code === 'VERSION_CONFLICT') { setDialog('conflict'); setMessage('File changed on the server. Review the server version or deliberately overwrite.'); } else error(problem); }
  };
  const review = async () => { if (!selected) return; try { const text = await api<{ content: string }>(url('/api/text', selected.path)); setServerCopy(text.content); } catch (problem) { error(problem); } };
  const mutate = async (route: string, data: object, method = 'POST') => { await api(route, method, data); setDialog(null); await refresh(); };
  const begin = (type: typeof dialog, item?: Entry) => { setMoving(item || null); setDraft(type === 'rename' ? item?.name || '' : ''); setDialog(type); };
  const submitName = async () => {
    if (!draft || draft.includes('\0') || draft.startsWith('/') || draft.split('/').some(part => !part || part === '.' || part === '..') || (dialog !== 'restore' && draft.includes('/'))) { setMessage(dialog === 'restore' ? 'Enter a valid root-relative path (no empty, dot or parent components).' : 'Enter a single valid name (no slash, dot components or NUL).'); return; }
    try {
      if (dialog === 'create') await mutate('/api/create', { path: join(directory, draft), kind: createKind });
      if (dialog === 'rename' && moving) await mutate('/api/move', { source: moving.path, destination: join(directory, draft) });
      if (dialog === 'restore' && trashed) { await mutate(`/api/trash/${encodeURIComponent(trashed.id)}/restore`, { destination: draft }); setTrash(await api('/api/trash')); }
      setMessage('Done.');
    } catch (problem) { error(problem); }
  };
  const move = async (overwrite = false) => {
    if (!moving || picker === null) return;
    const destination = join(picker, moving.name);
    if (destination === moving.path) { setMessage('Choose a different destination.'); return; }
    try { await mutate('/api/move', { source: moving.path, destination, overwrite }); setPicker(null); setMessage('Moved.'); }
    catch (problem) { if ((problem as ApiProblem).code === 'NAME_CONFLICT' && window.confirm(`“${destination}” already exists. Replace it? Only files or links can be replaced.`)) await move(true); else error(problem); }
  };
  const upload = async (files: FileList | null, overwrite = false) => {
    if (!files?.length) return;
    const oversized = Array.from(files).filter(file => file.size > (config?.limits.upload ?? 0));
    if (oversized.length) { setMessage(`Upload limit ${readable(config!.limits.upload)} per file exceeded: ${oversized.map(file => file.name).join(', ')}`); return; }
    const form = new FormData(); for (const file of files) form.append('files', file);
    try { await api(`${url('/api/upload', directory)}${overwrite ? '&overwrite=true' : ''}`, 'POST', form); await refresh(); setMessage(`${files.length} file(s) uploaded.`); }
    catch (problem) { if ((problem as ApiProblem).code === 'NAME_CONFLICT' && !overwrite && window.confirm('A filename already exists. Replace conflicting files or links in this upload?')) await upload(files, true); else error(problem); }
    finally { if (uploadInput.current) uploadInput.current.value = ''; }
  };
  const pick = async (path: string) => { try { const listing = await api<{ entries: Entry[] }>(url('/api/list', path)); setPicker(path); setPickerEntries(listing.entries.filter(entry => entry.kind === 'directory' || entry.kind === 'symlink' && !entry.link?.outside && !entry.link?.dangling)); setMessage(''); } catch (problem) { error(problem); } };
  const visible = useMemo(() => entries.filter(entry => (hidden || !entry.name.startsWith('.')) && entry.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => {
    const folder = (item: Entry) => item.kind === 'directory' ? 0 : 1;
    return folder(a) - folder(b) || (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size || a.name.localeCompare(b.name) : Date.parse(b.modified) - Date.parse(a.modified) || a.name.localeCompare(b.name));
  }), [entries, hidden, filter, sort]);
  const crumb = directory.split('/');
  return <div className="shell"><header><div className="brand">▣ <strong>Files</strong><span className="tag">YOUR SERVER</span></div><nav aria-label="Main"><Button onPress={() => navigate('')}>Browse</Button>{config?.trash && <Button onPress={showTrash}>Trash</Button>}<Button onPress={() => setDialog('shortcuts')}>Keyboard help</Button></nav></header>
    <main><div className="topline"><div><p className="eyebrow">{trash ? 'RECOVERY' : selected ? 'FILE VIEW' : 'EXPLORER'}</p><h1>{trash ? 'Trash' : selected ? selected.name : directory ? nameOf(directory) : 'Your files'}</h1></div><span className="connection" role="status">{message.includes('connect') || message.includes('connection') ? '● Offline' : '● Online only'}</span></div>
    {message && <div className="notice" role="alert">{message} <Button aria-label="Dismiss message" onPress={() => setMessage('')}>×</Button></div>}
    {!trash && <nav className="breadcrumbs" aria-label="Breadcrumb"><Button onPress={() => navigate('')}>Root</Button>{crumb.filter(Boolean).map((part, index) => <React.Fragment key={index}><span aria-hidden="true">/</span><Button onPress={() => navigate(crumb.slice(0, index + 1).join('/'))}>{part}</Button></React.Fragment>)}</nav>}
    {trash ? <section className="panel"><div className="toolbar"><h2>Deleted items</h2><Button onPress={refresh}>Refresh</Button></div>{!trash.length ? <p className="empty">Trash is empty.</p> : <ul className="items">{trash.map(item => <li key={item.id}><div className="item-main"><span className="glyph">♻</span><div><strong>{item.original}</strong><small>{item.kind} · {readable(item.size)} · deleted {new Date(item.deletedAt).toLocaleString()}</small></div></div><div className="actions"><Button onPress={() => { setTrashed(item); setDraft(item.original); setDialog('restore'); }}>Restore</Button><Button onPress={() => { setTrashed(item); setDialog('purge'); }}>Permanently delete</Button></div></li>)}</ul>}</section> : selected ? <section className="panel"><div className="toolbar"><Button onPress={() => navigate(directory)}>← Back to folder</Button><a className="button" href={raw(selected.path)} download>Download</a></div><div className="file-heading"><span className="glyph">▤</span><div><h2>{selected.name}{dirty ? ' • Unsaved' : ''}</h2><p>{readable(selected.size)} · {new Date(selected.modified).toLocaleString()}</p></div></div>
      {editing && <><div className="toolbar"><Button onPress={() => save()} isDisabled={!dirty}>Save changes</Button><label className="toggle"><input type="checkbox" checked={vimMode} onChange={event => setVimMode(event.target.checked)} /> Vim mode</label>{/\.md(?:own)?$/i.test(selected.name) && <Button onPress={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview Markdown'}</Button>}</div>{preview ? <article className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(content, { async: false }) as string }} /> : <Editor value={saved} onChange={setContent} name={selected.name} vimMode={vimMode} />}</>}
      {!editing && preview && (/\.md(?:own)?$/i.test(selected.name) ? <article className="markdown" dangerouslySetInnerHTML={{ __html: marked.parse(content, { async: false }) as string }} /> : /\.pdf$/i.test(selected.name) ? <iframe title={`PDF preview: ${selected.name}`} src={url('/api/preview', selected.path)} className="pdf" /> : <img className="image-preview" alt={`Preview of ${selected.name}`} src={url('/api/preview', selected.path)} />)}
      </section> : <section className="panel"><div className="toolbar wrap"><div className="toolbar"><Button onPress={() => { setCreateKind('file'); begin('create'); }}>+ File</Button><Button onPress={() => { setCreateKind('directory'); begin('create'); }}>+ Folder</Button><Button onPress={() => uploadInput.current?.click()}>↑ Upload files</Button><input ref={uploadInput} type="file" multiple aria-label="Choose files to upload" onChange={event => upload(event.target.files)} /></div><Button onPress={refresh}>↻ Refresh</Button></div><div className="controls"><label>Filter names <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="This folder only" /></label><label>Sort by <select value={sort} onChange={event => setSort(event.target.value)}><option value="recent">Recently modified</option><option value="name">Name A–Z</option><option value="size">Largest first</option></select></label><label className="toggle"><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} /> Show hidden files</label></div><div className="list-title"><h2>Contents</h2><span>{visible.length} item{visible.length === 1 ? '' : 's'}</span></div>{!visible.length ? <p className="empty">No files to show in this folder.</p> : <ul className="items">{visible.map(entry => <li key={entry.path}><div className="item-main"><span className="glyph" aria-hidden="true">{entry.kind === 'directory' ? '▰' : entry.kind === 'symlink' ? '↗' : '▤'}</span><div><Button className="entry-name" onPress={() => open(entry)}>{entry.name}</Button><small>{entry.kind === 'symlink' ? `Link → ${entry.link?.target} · ${entry.link?.outside ? 'OUTSIDE ROOT · cannot open' : entry.link?.dangling ? 'unavailable · cannot open' : 'inside root'}` : `${entry.kind} · ${readable(entry.size)} · ${new Date(entry.modified).toLocaleString()}`}</small></div></div><div className="actions"><Button aria-label={`Rename ${entry.name}`} onPress={() => begin('rename', entry)}>Rename</Button><Button aria-label={`Move ${entry.name}`} onPress={() => { setMoving(entry); pick(directory); setDialog('move'); }}>Move</Button><Button aria-label={`Delete ${entry.name}`} onPress={() => begin('delete', entry)}>Delete</Button>{entry.kind !== 'directory' && !entry.link?.outside && !entry.link?.dangling && <a className="button" href={raw(entry.path)} download aria-label={`Download ${entry.name}`}>↓</a>}</div></li>)}</ul>}</section>}
    <footer>Files stay on your server · No offline storage · <Button onPress={() => setDialog('shortcuts')}>Keyboard shortcuts</Button></footer></main>
    <ModalOverlay isOpen={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }} isDismissable><Modal><Dialog className="dialog" aria-label={dialog || 'Dialog'}><Heading slot="title">{({ create: `Create ${createKind}`, rename: 'Rename', move: 'Move to folder', delete: 'Delete item?', restore: 'Restore from trash', purge: 'Delete permanently?', shortcuts: 'Keyboard reference', conflict: 'Server version changed' } as Record<string, string>)[dialog || '']}</Heading>
      {message && <p role="alert" className="dialog-notice">{message}</p>}
      {(dialog === 'create' || dialog === 'rename' || dialog === 'restore') && <form onSubmit={event => { event.preventDefault(); submitName(); }}><label>{dialog === 'restore' ? 'Restore destination (root-relative path)' : 'Name'}<input aria-label={dialog === 'restore' ? 'Restore destination' : 'Name'} autoFocus required value={draft} onChange={event => setDraft(event.target.value)} /></label>{dialog === 'restore' && <p>Change the destination to a different name if the original name is occupied. Parent folder must exist.</p>}<div className="dialog-actions"><Button onPress={() => setDialog(null)}>Cancel</Button><button type="submit">{dialog === 'restore' ? 'Restore' : dialog === 'rename' ? 'Rename' : 'Create'}</button></div></form>}
      {dialog === 'move' && <><p>Choose a destination folder for <strong>{moving?.name}</strong>.</p><div className="picker"><p>Root{picker ? ` / ${picker}` : ''}</p>{picker !== null && picker !== '' && <Button onPress={() => pick(parentOf(picker))}>↑ Parent folder</Button>}<ul>{pickerEntries.map(entry => <li key={entry.path}><Button onPress={() => pick(entry.path)}>▰ {entry.name}</Button></li>)}</ul></div><div className="dialog-actions"><Button onPress={() => setDialog(null)}>Cancel</Button><Button onPress={() => move()}>Move here</Button></div></>}
      {dialog === 'delete' && <><p>Delete <strong>{moving?.name}</strong>? {config?.trash ? 'You can restore it from Trash.' : 'This is permanent; trash is not configured.'}</p><div className="dialog-actions"><Button onPress={() => setDialog(null)}>Cancel</Button><Button onPress={async () => { try { await mutate('/api/delete', { path: moving!.path, confirmed: true }); } catch (problem) { error(problem); } }}>Delete</Button></div></>}
      {dialog === 'purge' && <><p>Permanently delete <strong>{trashed?.original}</strong>? This cannot be undone.</p><div className="dialog-actions"><Button onPress={() => setDialog(null)}>Cancel</Button><Button onPress={async () => { try { await api(`/api/trash/${encodeURIComponent(trashed!.id)}/purge`, 'POST', { confirmed: true }); setTrash(await api('/api/trash')); setDialog(null); } catch (problem) { error(problem); } }}>Permanently delete</Button></div></>}
      {dialog === 'conflict' && <><p>The server file changed since you opened it. Your unsaved changes remain in the editor.</p><Button onPress={review}>Load server version for review</Button>{serverCopy !== null && <><h3>Current server version (read-only)</h3><pre className="server-copy">{serverCopy}</pre></>}<div className="dialog-actions"><Button onPress={() => setDialog(null)}>Keep editing</Button><Button onPress={() => save(true)}>Overwrite server version</Button></div></>}
      {dialog === 'shortcuts' && <><p>All actions work with Tab, Shift+Tab, Enter, and Space. Escape closes dialogs; Enter submits forms. Browser upload chooser works from the Upload files button. In the editor, Ctrl/Cmd+F opens find; Ctrl/Cmd+H opens replace; Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z redoes. Toggle Vim mode in the editor toolbar to use Vim keys. Save with the Save changes button; changes are never saved automatically.</p><div className="dialog-actions"><Button onPress={() => setDialog(null)}>Close</Button></div></>}
    </Dialog></Modal></ModalOverlay>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { /* The online site still works when registration is unavailable. */ });
