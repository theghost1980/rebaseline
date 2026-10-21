import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionError } from '../src/review/session.js';
import { png } from './helpers.js';
import { makeSession } from './review-helpers.js';

describe('ReviewSession', () => {
  it('describes every screenshot and the other failures', async () => {
    const { session, id } = await makeSession();
    const view = session.view();
    expect(view.shots.map((s) => [s.title, s.kind, s.decision, s.target])).toEqual([
      ['hero', 'changed', 'pending', 'shots/hero.png'],
      ['hero again, same baseline', 'changed', 'pending', 'shots/hero.png'],
      ['brand new', 'new', 'pending', 'shots/brand.png'],
      ['lost', 'changed', 'pending', null],
    ]);
    const hero = view.shots.find((s) => s.id === id('hero'));
    expect(hero?.images).toEqual({ expected: true, actual: true, diff: true });
    expect(hero?.sameTarget).toEqual([id('twin')]);
    expect(view.shots.find((s) => s.id === id('new'))?.images.expected).toBe(false);
    expect(view.shots.find((s) => s.id === id('lost'))?.unresolved?.reason).toBe('no-match');
    expect(view.others.map((o) => o.title)).toEqual(['text']);
  });

  it('writes the accepted image and restores the previous one on reject', async () => {
    const { root, session, id } = await makeSession();
    const file = path.join(root, 'shots', 'hero.png');

    const accepted = await session.accept(id('hero'));
    expect(accepted.shot.decision).toBe('accepted');
    expect(readFileSync(file)).toEqual(png('hero new'));

    const rejected = await session.reject(id('hero'));
    expect(rejected.shot.decision).toBe('rejected');
    expect(rejected.message).toContain('Restored');
    expect(readFileSync(file)).toEqual(png('hero old'));
  });

  it('refuses screenshots it cannot place', async () => {
    const { session, id } = await makeSession();
    await expect(session.accept(id('lost'))).rejects.toMatchObject({ name: 'SessionError', status: 409 });
    await expect(session.accept('nope')).rejects.toBeInstanceOf(SessionError);
  });

  it('refuses a second screenshot for a file that was already accepted', async () => {
    const { root, session, id } = await makeSession();
    await session.accept(id('hero'));
    await expect(session.accept(id('twin'))).rejects.toThrow(/"hero" was already accepted for shots\/hero.png/);
    expect(readFileSync(path.join(root, 'shots', 'hero.png'))).toEqual(png('hero new'));
  });

  it('creates new files and keeps them when rejected afterwards', async () => {
    const { root, session, id } = await makeSession();
    const file = path.join(root, 'shots', 'brand.png');
    await session.accept(id('new'));
    expect(readFileSync(file)).toEqual(png('brand'));
    const rejected = await session.reject(id('new'));
    expect(rejected.message).toContain('stays on disk');
    expect(existsSync(file)).toBe(true);
    expect(session.results().rejectedNew).toEqual([{ target: 'shots/brand.png', sha1: expect.any(String) }]);
  });

  it('applies quick successive clicks one at a time', async () => {
    const { root, session, id } = await makeSession();
    await Promise.all([session.accept(id('hero')), session.reject(id('hero')), session.accept(id('hero'))]);
    await session.idle();
    expect(session.view().shots.find((s) => s.id === id('hero'))?.decision).toBe('accepted');
    expect(readFileSync(path.join(root, 'shots', 'hero.png'))).toEqual(png('hero new'));
  });

  it('counts the results', async () => {
    const { session, id } = await makeSession();
    await session.accept(id('hero'));
    await session.accept(id('new'));
    await session.reject(id('twin'));
    expect(session.results()).toMatchObject({
      accepted: [
        { target: 'shots/hero.png', kind: 'changed', created: false, untracked: false },
        { target: 'shots/brand.png', kind: 'new', created: true, untracked: false },
      ],
      rejected: 1,
      pending: 1,
      rejectedNew: [],
    });
  });

  it('serves only images that exist', async () => {
    const { session, id } = await makeSession();
    expect(session.imagePath(id('hero'), 'diff')).toMatch(/\.png$/);
    expect(session.imagePath(id('new'), 'diff')).toBeNull();
    expect(session.imagePath('nope', 'actual')).toBeNull();
  });
});
