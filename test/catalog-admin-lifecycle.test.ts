import { describe, expect, it } from 'vitest';
import { CatalogAdminLoadLifecycle } from '../src/client/lib/catalog-admin-lifecycle';

describe('catalog administrator load lifecycle', () => {
  it('re-activates after the StrictMode effect cleanup and ignores the aborted replay predecessor', () => {
    const lifecycle = new CatalogAdminLoadLifecycle();

    lifecycle.activate();
    const first = lifecycle.begin();
    lifecycle.cleanup();
    lifecycle.activate();
    const replay = lifecycle.begin();

    expect(first.controller.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.isCurrent(replay)).toBe(true);
  });

  it('aborts the active request and rejects late results after unmount', () => {
    const lifecycle = new CatalogAdminLoadLifecycle();
    lifecycle.activate();
    const request = lifecycle.begin();

    lifecycle.cleanup();

    expect(request.controller.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(request)).toBe(false);
  });
});
