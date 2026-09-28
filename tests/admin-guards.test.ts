import { describe, it, expect } from 'vitest';
import { accountChangeBlock } from '../src/lib/admin-guards';

const admin = { id: 'a1', role: 'ADMIN' as const, isActive: true };
const user = { id: 'u1', role: 'USER' as const, isActive: true };

describe('accountChangeBlock', () => {
  it('stops admins from deleting, disabling or demoting themselves', () => {
    for (const change of [{ remove: true }, { isActive: false }, { role: 'USER' as const }]) {
      expect(accountChangeBlock({ actorId: 'a1', target: admin, change, otherActiveAdmins: 3 })).toMatch(/chính mình/);
    }
  });

  it('keeps at least one active admin', () => {
    for (const change of [{ remove: true }, { isActive: false }, { role: 'USER' as const }]) {
      expect(accountChangeBlock({ actorId: 'x', target: admin, change, otherActiveAdmins: 0 })).toMatch(/ít nhất một/);
      expect(accountChangeBlock({ actorId: 'x', target: admin, change, otherActiveAdmins: 1 })).toBeNull();
    }
  });

  it('allows ordinary changes to members', () => {
    expect(accountChangeBlock({ actorId: 'a1', target: user, change: { remove: true }, otherActiveAdmins: 0 })).toBeNull();
    expect(accountChangeBlock({ actorId: 'a1', target: user, change: { isActive: false }, otherActiveAdmins: 0 })).toBeNull();
    expect(accountChangeBlock({ actorId: 'a1', target: user, change: { role: 'ADMIN' }, otherActiveAdmins: 0 })).toBeNull();
  });
});
