import { describe, expect, it } from 'vitest';
import { FakeStorage } from './fakeStorage.js';

describe('FakeStorage', () => {
  it('stores and retrieves an object', async () => {
    const s = new FakeStorage();
    await s.put('a/b.txt', Buffer.from('hello'), 'text/plain');
    expect((await s.get('a/b.txt')).toString()).toBe('hello');
  });

  it('throws on a missing object', async () => {
    await expect(new FakeStorage().get('nope')).rejects.toThrow(/not found/);
  });

  it('deletes an object', async () => {
    const s = new FakeStorage();
    await s.put('k', Buffer.from('x'));
    await s.delete('k');
    await expect(s.get('k')).rejects.toThrow();
  });

  it('returns a signed url only for existing objects', async () => {
    const s = new FakeStorage();
    await s.put('k', Buffer.from('x'));
    expect(await s.getSignedUrl('k', 60)).toContain('k');
    await expect(s.getSignedUrl('missing')).rejects.toThrow();
  });
});
