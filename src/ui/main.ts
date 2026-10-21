import type { ActionResult, ErrorResult, ImageKind, OtherFailureView, ShotView, StateView } from '../review/view.js';

const token = new URLSearchParams(location.search).get('token') ?? '';
const app = document.getElementById('app') as HTMLElement;

let state: StateView | null = null;
let notice: { text: string; error: boolean } | null = null;
let busy = false;
let finished = false;

async function api<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  const res = await fetch(path, { method, headers: { 'x-rebaseline-token': token } });
  const body = (await res.json()) as T | ErrorResult;
  if (!res.ok) throw new Error((body as ErrorResult).error || res.statusText);
  return body as T;
}

function imageUrl(id: string, kind: ImageKind): string {
  return `/api/image/${encodeURIComponent(id)}/${kind}?token=${encodeURIComponent(token)}`;
}

/** Creates an element. Strings become text nodes, so report data is never parsed as HTML. */
function h(tag: string, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: (Node | string | null)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key, value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false) el.setAttribute(key, value);
  }
  for (const child of children) if (child !== null) el.append(child);
  return el;
}

async function act(shot: ShotView, action: 'accept' | 'reject'): Promise<void> {
  if (busy || !state) return;
  busy = true;
  try {
    const result = await api<ActionResult>('POST', `/api/shots/${encodeURIComponent(shot.id)}/${action}`);
    state.shots = state.shots.map((s) => (s.id === result.shot.id ? result.shot : s));
    notice = result.message ? { text: result.message, error: false } : null;
  } catch (err) {
    notice = { text: (err as Error).message, error: true };
  } finally {
    busy = false;
    render();
  }
}

async function done(): Promise<void> {
  try {
    await api('POST', '/api/done');
    finished = true;
  } catch (err) {
    notice = { text: (err as Error).message, error: true };
  }
  render();
}

function shotCard(shot: ShotView): HTMLElement {
  const badges = h(
    'div',
    { class: 'row' },
    h('span', { class: `badge ${shot.decision}` }, shot.decision),
    shot.kind === 'new' ? h('span', { class: 'badge new' }, 'new') : null,
    shot.via === 'untracked' ? h('span', { class: 'badge untracked' }, 'not tracked by git') : null,
    shot.unresolved ? h('span', { class: 'badge unresolved' }, 'cannot be accepted') : null,
  );

  const images = h('div', { class: 'images' });
  const kinds: [ImageKind, string][] = [
    ['expected', 'Expected'],
    ['actual', 'Actual'],
    ['diff', 'Diff'],
  ];
  for (const [kind, label] of kinds) {
    if (shot.images[kind]) images.append(h('figure', {}, h('figcaption', {}, label), h('img', { src: imageUrl(shot.id, kind), alt: label })));
  }

  return h(
    'div',
    { class: `card ${shot.decision}` },
    h('div', { class: 'row' }, h('strong', {}, shot.titlePath.join(' › ')), h('span', { class: 'muted' }, shot.name), badges),
    h('div', { class: 'muted' }, `${shot.file}:${shot.line}`),
    shot.target ? h('div', {}, 'File: ', h('code', {}, shot.target)) : null,
    shot.unresolved
      ? h(
          'div',
          {},
          shot.unresolved.message,
          ...shot.unresolved.candidates.map((c) => h('div', {}, h('code', {}, c))),
        )
      : null,
    shot.stoppedAtScreenshot
      ? h('div', { class: 'muted' }, 'This test stopped at this screenshot and may have more. Run the tests again after accepting.')
      : null,
    images,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'primary', disabled: busy || shot.unresolved !== null || shot.decision === 'accepted', click: () => void act(shot, 'accept') }, 'Accept'),
      h('button', { disabled: busy || shot.decision === 'rejected', click: () => void act(shot, 'reject') }, 'Reject'),
    ),
  );
}

function otherCard(failure: OtherFailureView): HTMLElement {
  return h(
    'div',
    { class: 'card other' },
    h('div', { class: 'row' }, h('strong', {}, failure.titlePath.join(' › ')), h('span', { class: 'badge' }, failure.status)),
    h('div', { class: 'muted' }, `${failure.file}:${failure.line}`),
    h('pre', {}, failure.error || 'No error message.'),
  );
}

function render(): void {
  app.replaceChildren();
  if (finished) {
    app.append(h('main', {}, h('h2', {}, 'Review finished'), h('p', { class: 'muted' }, 'The summary is in your terminal. You can close this tab.')));
    return;
  }
  if (!state) return;

  const accepted = state.shots.filter((s) => s.decision === 'accepted').length;
  const rejected = state.shots.filter((s) => s.decision === 'rejected').length;
  app.append(
    h(
      'header',
      {},
      h('h1', {}, 'rebaseline'),
      h('span', { class: 'muted' }, `${state.shots.length} screenshots · ${accepted} accepted · ${rejected} rejected`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', click: () => void done() }, 'Done'),
    ),
  );

  const main = h('main', {});
  if (notice) main.append(h('p', { class: `notice${notice.error ? ' error' : ''}` }, notice.text));
  for (const project of [...new Set(state.shots.map((s) => s.project))]) {
    main.append(h('h2', {}, project || 'Screenshots'));
    for (const shot of state.shots.filter((s) => s.project === project)) main.append(shotCard(shot));
  }
  if (state.others.length > 0) {
    main.append(h('h2', { class: 'muted' }, 'Other failures (not screenshots)'));
    for (const failure of state.others) main.append(otherCard(failure));
  }
  app.append(main);
}

api<StateView>('GET', '/api/state')
  .then((s) => {
    state = s;
    render();
  })
  .catch((err: Error) => {
    app.replaceChildren(h('main', {}, h('p', { class: 'notice error' }, err.message)));
  });
