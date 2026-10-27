import type { ActionResult, ErrorResult, ImageKind, OtherFailureView, ShotView, StateView } from '../review/view.js';

type Mode = 'side' | 'slider' | 'diff';
type Item = { type: 'shot'; id: string; shot: ShotView } | { type: 'other'; id: string; failure: OtherFailureView };

const token = new URLSearchParams(location.search).get('token') ?? '';
const app = document.getElementById('app') as HTMLElement;

let state: StateView | null = null;
let selectedId: string | null = null;
let scrolledTo: string | null = null;
let mode: Mode = 'side';
let actualSize = false;
let sliderPos = 50;
let busy = false;
let helpOpen = false;
let ended: 'done' | 'gone' | null = null;
let notice: { text: string; error: boolean } | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** Sizes the images of the current view; set by the viewer, called after loads and resizes. */
let relayout: (() => void) | null = null;

function layoutNow(): void {
  relayout?.();
}

const imageCache = new Map<string, HTMLImageElement>();

const header = h('header');
const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'Failures' });
const content = h('main', { class: 'content' });
const overlay = h('div');

// ---------------------------------------------------------------- helpers

type Attr = string | boolean | ((event: Event) => void);

/** Creates an element. Strings become text nodes, so report data is never parsed as HTML. */
function h(tag: string, attrs: Record<string, Attr> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key, value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false) el.setAttribute(key, value);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child);
  return el;
}

/** A copy of the logo kept in the page template; null shows the name alone. */
function logo(): Node | null {
  return (document.getElementById('logo') as HTMLTemplateElement | null)?.content.firstElementChild?.cloneNode(true) ?? null;
}

const LINKS: [string, string][] = [
  ['Beta feedback', 'https://github.com/theghost1980/rebaseline/discussions/13'],
  ['rebaseline on npm', 'https://www.npmjs.com/package/rebaseline'],
  ['@theghost1980 on GitHub', 'https://github.com/theghost1980/'],
];

/** Where rebaseline comes from, under the help and the end message. Links open in a new tab and never send this page's address. */
function about(): HTMLElement {
  return h(
    'p',
    { class: 'links' },
    ...LINKS.flatMap(([label, href], i) => [i > 0 ? ' · ' : '', h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label)]),
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

class ServerGone extends Error {}

async function api<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { 'x-rebaseline-token': token } });
  } catch {
    throw new ServerGone('The review has ended in the terminal.');
  }
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as T | ErrorResult;
  if (!res.ok) throw new Error((body as ErrorResult).error || res.statusText);
  return body as T;
}

function imageUrl(id: string, kind: ImageKind): string {
  return `/api/image/${encodeURIComponent(id)}/${kind}?token=${encodeURIComponent(token)}`;
}

/** One element per image, reused across views so switching never reloads it. */
function image(id: string, kind: ImageKind): HTMLImageElement {
  const key = `${id}/${kind}`;
  let el = imageCache.get(key);
  if (!el) {
    el = new Image();
    el.alt = kind;
    el.addEventListener('load', () => relayout?.());
    el.src = imageUrl(id, kind);
    imageCache.set(key, el);
  }
  el.removeAttribute('style');
  el.className = 'checker';
  return el;
}

function scaleFor(available: number, width: number): number {
  return actualSize || width <= 0 ? 1 : Math.min(1, available / width);
}

function showNotice(text: string, error: boolean): void {
  notice = { text, error };
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    renderOverlay();
  }, 6000);
}

function handleError(err: unknown): void {
  if (err instanceof ServerGone) ended = 'gone';
  else showNotice(err instanceof Error ? err.message : String(err), true);
}

// ---------------------------------------------------------------- selection

function items(): Item[] {
  if (!state) return [];
  return [
    ...state.shots.map((shot): Item => ({ type: 'shot', id: shot.id, shot })),
    ...state.others.map((failure): Item => ({ type: 'other', id: `other:${failure.id}`, failure })),
  ];
}

function current(): Item | null {
  return items().find((i) => i.id === selectedId) ?? null;
}

function select(id: string): void {
  selectedId = id;
  render();
}

function move(step: number): void {
  const list = items();
  if (list.length === 0) return;
  const index = list.findIndex((i) => i.id === selectedId);
  const next = list[Math.min(list.length - 1, Math.max(0, index + step))];
  if (next) select(next.id);
}

/** After a decision, go to the next screenshot nobody has looked at yet. */
function advanceToPending(): void {
  const shots = state?.shots ?? [];
  const index = shots.findIndex((s) => s.id === selectedId);
  for (let k = 1; k <= shots.length; k++) {
    const shot = shots[(index + k) % shots.length];
    if (shot && shot.decision === 'pending') {
      selectedId = shot.id;
      return;
    }
  }
}

// ---------------------------------------------------------------- actions

async function decide(action: 'accept' | 'reject'): Promise<void> {
  const item = current();
  if (!state || !item || item.type !== 'shot' || busy || ended) return;
  const { shot } = item;
  if (action === 'accept' && (shot.unresolved || shot.decision === 'accepted')) return;
  if (action === 'reject' && shot.decision === 'rejected') return;

  busy = true;
  render();
  try {
    const result = await api<ActionResult>('POST', `/api/shots/${encodeURIComponent(shot.id)}/${action}`);
    state.shots = state.shots.map((s) => (s.id === result.shot.id ? result.shot : s));
    if (result.message) showNotice(result.message, false);
    advanceToPending();
  } catch (err) {
    handleError(err);
  } finally {
    busy = false;
    render();
  }
}

async function finish(): Promise<void> {
  if (!state || ended) return;
  const pending = state.shots.filter((s) => s.decision === 'pending').length;
  if (pending > 0 && !window.confirm(`${plural(pending, 'screenshot')} not reviewed yet. Finish anyway?`)) return;
  try {
    await api('POST', '/api/done');
    ended = 'done';
  } catch (err) {
    handleError(err);
  }
  render();
}

function setMode(next: Mode): void {
  mode = next;
  render();
}

function toggleSize(): void {
  actualSize = !actualSize;
  render();
}

function toggleHelp(open = !helpOpen): void {
  helpOpen = open;
  renderOverlay();
}

// ---------------------------------------------------------------- rendering

function statusOf(shot: ShotView): { symbol: string; cls: string; label: string } {
  if (shot.decision === 'accepted') return { symbol: '✓', cls: 'accepted', label: 'Accepted' };
  if (shot.decision === 'rejected') return { symbol: '✗', cls: 'rejected', label: 'Rejected' };
  if (shot.unresolved) return { symbol: '!', cls: 'unresolved', label: 'Cannot be accepted' };
  return { symbol: '○', cls: '', label: 'Not reviewed' };
}

function renderHeader(s: StateView): void {
  const accepted = s.shots.filter((x) => x.decision === 'accepted').length;
  const rejected = s.shots.filter((x) => x.decision === 'rejected').length;
  const modeButton = (value: Mode, label: string, key: string) =>
    h('button', { class: mode === value ? 'active' : '', title: `${label} (${key})`, click: () => setMode(value) }, label);

  header.replaceChildren(
    h('h1', {}, logo(), 'rebaseline'),
    h('span', { class: 'muted' }, `${accepted + rejected} of ${s.shots.length} reviewed · ${accepted} accepted · ${rejected} rejected`),
    h('span', { class: 'spacer' }),
    h('span', { class: 'segmented', role: 'group', 'aria-label': 'View' }, modeButton('side', 'Side by side', '1'), modeButton('slider', 'Slider', '2'), modeButton('diff', 'Diff', '3')),
    h('button', { title: 'Fit to the window or show actual size (Z)', click: toggleSize }, actualSize ? 'Actual size' : 'Fit'),
    h('button', { title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', click: () => toggleHelp() }, '?'),
    h('button', { class: 'primary', title: 'Finish and print the summary in the terminal', click: () => void finish() }, 'Done'),
  );
}

function renderSidebar(s: StateView): void {
  const top = sidebar.scrollTop;
  const children: HTMLElement[] = [];
  const projects = [...new Set(s.shots.map((shot) => shot.project))];
  for (const project of projects) {
    const shots = s.shots.filter((shot) => shot.project === project);
    children.push(h('h3', {}, `${project || 'Screenshots'} (${shots.length})`));
    for (const shot of shots) {
      const status = statusOf(shot);
      children.push(
        h(
          'button',
          { class: `item${shot.id === selectedId ? ' selected' : ''}`, title: status.label, click: () => select(shot.id) },
          h('span', { class: `status ${status.cls}` }, status.symbol),
          h('span', { class: 'text' }, h('span', { class: 'title' }, shot.title), h('span', { class: 'name' }, shot.kind === 'new' ? `${shot.name} · new` : shot.name)),
        ),
      );
    }
  }
  if (s.others.length > 0) {
    children.push(h('h3', {}, `Other failures (${s.others.length})`));
    for (const failure of s.others) {
      const id = `other:${failure.id}`;
      children.push(
        h(
          'button',
          { class: `item other${id === selectedId ? ' selected' : ''}`, title: 'Not a screenshot failure', click: () => select(id) },
          h('span', { class: 'status' }, '–'),
          h('span', { class: 'text' }, h('span', { class: 'title' }, failure.title), h('span', { class: 'name' }, failure.project || failure.status)),
        ),
      );
    }
  }
  sidebar.replaceChildren(...children);
  sidebar.scrollTop = top;
  if (scrolledTo !== selectedId) {
    sidebar.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    scrolledTo = selectedId;
  }
}

function meta(project: string, file: string, line: number, retries: number): HTMLElement {
  const parts = [project ? `[${project}]` : '', `${file}:${line}`, retries > 0 ? `retried ${plural(retries, 'time')}` : ''];
  return h('div', { class: 'muted' }, parts.filter(Boolean).join(' · '));
}

function navButtons(): HTMLElement {
  return h(
    'span',
    { class: 'row' },
    h('button', { title: 'Previous (←)', click: () => move(-1) }, '← Previous'),
    h('button', { title: 'Next (→)', click: () => move(1) }, 'Next →'),
  );
}

function renderShot(s: StateView, shot: ShotView): HTMLElement[] {
  const status = statusOf(shot);
  const sameTarget = shot.sameTarget.map((id) => s.shots.find((x) => x.id === id)?.title ?? id);
  return [
    h('h2', {}, shot.titlePath.join(' › ')),
    meta(shot.project, shot.file, shot.line, shot.retries),
    h(
      'div',
      { class: 'row', style: 'margin-top:6px' },
      h('span', { class: `badge ${status.cls}` }, status.label),
      h('span', { class: 'badge' }, shot.name),
      shot.kind === 'new' && h('span', { class: 'badge new' }, 'new screenshot'),
      shot.via === 'untracked' && h('span', { class: 'badge untracked' }, 'baseline not tracked by git'),
      shot.via === 'lfs' && h('span', { class: 'badge untracked' }, 'Git LFS pointer'),
    ),
    shot.target ? h('p', {}, shot.kind === 'new' ? 'Accepting creates ' : 'Accepting replaces ', h('code', {}, shot.target)) : null,
    shot.unresolved
      ? h(
          'div',
          { class: 'note error' },
          `This screenshot cannot be accepted. ${shot.unresolved.message}`,
          shot.unresolved.candidates.length > 0 ? h('ul', {}, ...shot.unresolved.candidates.map((c) => h('li', {}, h('code', {}, c)))) : null,
        )
      : null,
    shot.via === 'untracked' ? h('div', { class: 'note' }, 'The baseline file exists but git does not track it yet. Remember to commit it.') : null,
    shot.via === 'lfs'
      ? h(
          'div',
          { class: 'note' },
          'The baseline is stored with Git LFS and only its pointer is in this folder. Accepting writes the image there; commit it with git-lfs installed so it stays in LFS.',
        )
      : null,
    sameTarget.length > 0 ? h('div', { class: 'note' }, `Other screenshots in this report write the same file: ${sameTarget.join(', ')}. Only one of them can be accepted.`) : null,
    shot.stoppedAtScreenshot
      ? h('div', { class: 'note' }, 'The test stopped at this screenshot, so later screenshots in it were not compared. Run the tests again after accepting.')
      : null,
    h(
      'div',
      { class: 'toolbar' },
      h(
        'button',
        { class: 'primary', title: 'Accept (A)', disabled: busy || shot.unresolved !== null || shot.decision === 'accepted', click: () => void decide('accept') },
        'Accept',
      ),
      h('button', { class: 'danger', title: 'Reject (R)', disabled: busy || shot.decision === 'rejected', click: () => void decide('reject') }, 'Reject'),
      h('span', { class: 'spacer' }),
      navButtons(),
    ),
    viewer(shot),
    shot.error ? h('details', {}, h('summary', {}, 'Error message'), h('pre', {}, shot.error)) : null,
  ].filter((x): x is HTMLElement => x !== null);
}

function renderOther(failure: OtherFailureView): HTMLElement[] {
  return [
    h('h2', {}, failure.titlePath.join(' › ')),
    meta(failure.project, failure.file, failure.line, 0),
    h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'badge' }, failure.status)),
    h('div', { class: 'note' }, 'This failure is not a screenshot comparison, so there is nothing to accept here.'),
    failure.unsavedSnapshots.length > 0
      ? h(
          'div',
          { class: 'note error' },
          'Playwright reported new screenshots but did not save them (update mode "none"), so they cannot be reviewed. Run the tests again without --update-snapshots=none.',
          h('ul', {}, ...failure.unsavedSnapshots.map((p) => h('li', {}, h('code', {}, p)))),
        )
      : null,
    h('div', { class: 'toolbar' }, h('span', { class: 'spacer' }), navButtons()),
    h('pre', {}, failure.error || 'No error message.'),
  ].filter((x): x is HTMLElement => x !== null);
}

function viewer(shot: ShotView): HTMLElement {
  const box = h('div', { class: `viewer${actualSize ? ' actual-size' : ''}` });
  const available = () => box.clientWidth - 26;

  const single = (kind: ImageKind, label: string) => {
    const img = image(shot.id, kind);
    box.append(h('figure', {}, h('figcaption', {}, label), img));
    relayout = () => {
      img.style.width = `${img.naturalWidth * scaleFor(available(), img.naturalWidth)}px`;
    };
  };

  if (shot.kind === 'new' || !shot.images.expected) {
    if (shot.images.actual) single('actual', shot.kind === 'new' ? 'New screenshot' : 'Actual');
    else box.append(h('p', { class: 'muted' }, 'The report has no image for this screenshot.'));
    return box;
  }

  if (mode === 'diff') {
    if (shot.images.diff) single('diff', 'Diff (changed pixels are highlighted)');
    else box.append(h('p', { class: 'muted' }, 'The report has no diff image for this screenshot.'));
    return box;
  }

  const expected = image(shot.id, 'expected');
  const actual = image(shot.id, 'actual');

  if (mode === 'side') {
    box.append(h('div', { class: 'side' }, h('figure', {}, h('figcaption', {}, 'Expected'), expected), h('figure', {}, h('figcaption', {}, 'Actual'), actual)));
    relayout = () => {
      const widest = Math.max(expected.naturalWidth, actual.naturalWidth);
      const scale = scaleFor(window.innerWidth <= 800 ? available() : (available() - 16) / 2, widest);
      expected.style.width = `${expected.naturalWidth * scale}px`;
      actual.style.width = `${actual.naturalWidth * scale}px`;
    };
    return box;
  }

  // Slider: expected on the left of the handle, actual on the right.
  const top = h('div', { class: 'slider-top' }, actual);
  const handle = h('div', { class: 'slider-handle' });
  const wrap = h('div', { class: 'slider checker' }, expected, top, handle);
  const range = h('input', { type: 'range', min: '0', max: '100', class: 'slider-range', 'aria-label': 'Compare position' }) as HTMLInputElement;
  const apply = () => {
    top.style.clipPath = `inset(0 0 0 ${sliderPos}%)`;
    handle.style.left = `${sliderPos}%`;
    range.value = String(sliderPos);
  };
  const follow = (clientX: number) => {
    const rect = wrap.getBoundingClientRect();
    if (rect.width > 0) sliderPos = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    apply();
  };
  wrap.addEventListener('pointerdown', (e) => {
    wrap.setPointerCapture(e.pointerId);
    follow(e.clientX);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (wrap.hasPointerCapture(e.pointerId)) follow(e.clientX);
  });
  range.addEventListener('input', () => {
    sliderPos = Number(range.value);
    apply();
  });
  // Labels and range follow the image width, with a minimum so they stay usable on tiny images.
  const stage = h('div', { class: 'slider-stage' }, h('div', { class: 'slider-labels' }, h('span', {}, '◀ Expected'), h('span', {}, 'Actual ▶')), wrap, range);
  box.append(stage);
  relayout = () => {
    const width = Math.max(expected.naturalWidth, actual.naturalWidth);
    const height = Math.max(expected.naturalHeight, actual.naturalHeight);
    const scale = scaleFor(available(), width);
    stage.style.width = `${Math.max(width * scale, 240)}px`;
    wrap.style.width = `${width * scale}px`;
    wrap.style.height = `${height * scale}px`;
    expected.style.width = `${expected.naturalWidth * scale}px`;
    actual.style.width = `${actual.naturalWidth * scale}px`;
    apply();
  };
  apply();
  return box;
}

function renderContent(s: StateView): void {
  relayout = null;
  const item = current();
  const children = !item ? [h('p', { class: 'muted' }, 'Nothing selected.')] : item.type === 'shot' ? renderShot(s, item.shot) : renderOther(item.failure);
  content.replaceChildren(...children);
  layoutNow();
}

function renderOverlay(): void {
  const parts: HTMLElement[] = [];
  if (notice) parts.push(h('div', { class: `notice${notice.error ? ' error' : ''}`, role: 'status' }, notice.text));
  if (helpOpen) {
    const rows: [string, string][] = [
      ['A', 'Accept the screenshot'],
      ['R', 'Reject the screenshot'],
      ['← →  ↑ ↓  K J', 'Previous / next'],
      ['1  2  3', 'Side by side / slider / diff'],
      ['Z', 'Fit to the window / actual size'],
      ['?', 'Show or hide this help'],
      ['Esc', 'Close'],
    ];
    parts.push(
      h(
        'div',
        { class: 'overlay', click: (e: Event) => e.target === e.currentTarget && toggleHelp(false) },
        h(
          'div',
          { class: 'dialog', role: 'dialog', 'aria-label': 'Keyboard shortcuts' },
          h('div', { class: 'logo-large' }, logo()),
          h('h2', {}, 'Keyboard shortcuts'),
          h('table', {}, ...rows.map(([keys, what]) => h('tr', {}, h('td', {}, h('kbd', {}, keys)), h('td', {}, what)))),
          h('p', { class: 'muted' }, 'Accepting writes the image to its baseline file right away. Rejecting an accepted screenshot puts the previous file back.'),
          about(),
        ),
      ),
    );
  }
  overlay.replaceChildren(...parts);
}

function render(): void {
  if (ended) {
    relayout = null;
    document.title = 'rebaseline';
    app.replaceChildren(
      h(
        'div',
        { class: 'center' },
        h('div', { class: 'logo-large' }, logo()),
        h('h2', {}, ended === 'done' ? 'Review finished' : 'The review has ended'),
        h('p', { class: 'muted' }, 'The summary is in your terminal. You can close this tab.'),
        about(),
      ),
    );
    return;
  }
  if (!state) return;
  const pending = state.shots.filter((s) => s.decision === 'pending').length;
  document.title = pending > 0 ? `rebaseline (${pending} to review)` : 'rebaseline';
  renderHeader(state);
  renderSidebar(state);
  renderContent(state);
  renderOverlay();
}

// ---------------------------------------------------------------- start

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || ended || !state) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  if (helpOpen) {
    if (e.key === 'Escape' || e.key === '?') toggleHelp(false);
    return;
  }
  const actions: Record<string, () => void> = {
    a: () => void decide('accept'),
    r: () => void decide('reject'),
    ArrowRight: () => move(1),
    ArrowDown: () => move(1),
    j: () => move(1),
    ArrowLeft: () => move(-1),
    ArrowUp: () => move(-1),
    k: () => move(-1),
    '1': () => setMode('side'),
    '2': () => setMode('slider'),
    '3': () => setMode('diff'),
    z: toggleSize,
    '?': () => toggleHelp(true),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (action) {
    e.preventDefault();
    action();
  }
});

window.addEventListener('resize', () => relayout?.());

api<StateView>('GET', '/api/state')
  .then((s) => {
    state = s;
    selectedId = (s.shots.find((x) => x.decision === 'pending') ?? s.shots[0])?.id ?? (s.others[0] ? `other:${s.others[0].id}` : null);
    app.replaceChildren(header, h('div', { class: 'layout' }, sidebar, content), overlay);
    render();
  })
  .catch((err: unknown) => {
    app.replaceChildren(h('div', { class: 'center' }, h('h2', {}, 'Cannot load the review'), h('p', { class: 'muted' }, err instanceof Error ? err.message : String(err))));
  });
