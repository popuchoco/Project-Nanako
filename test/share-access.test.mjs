import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSmbShareAccess, isShareOperationAllowed } from '../src/share-access.mjs';

const user = { id: '11111111-1111-4111-8111-111111111111', role: 'user', isActive: true };
const share = { id: '22222222-2222-4222-8222-222222222222', source_type: 'managed', storage_path: null };

test('share permissions allow read-only access but deny every write operation', () => {
  const permission = { can_read: 1, can_write: 0 };
  assert.equal(isShareOperationAllowed(user, permission, 'list'), true);
  assert.equal(isShareOperationAllowed(user, permission, 'download'), true);
  for (const operation of ['create', 'write', 'delete', 'rename', 'move', 'copy', 'restore', 'extract']) {
    assert.equal(isShareOperationAllowed(user, permission, operation), false, operation);
  }
});

test('share permissions deny access without an explicit read grant', () => {
  assert.equal(isShareOperationAllowed(user, null, 'read'), false);
  assert.equal(isShareOperationAllowed(user, { can_read: 0, can_write: 1 }, 'write'), false);
  assert.equal(isShareOperationAllowed(user, { can_read: 1, can_write: 1 }, 'write'), true);
});

test('administrators retain full share permissions but inactive users are always denied', () => {
  const admin = { ...user, role: 'admin' };
  assert.equal(isShareOperationAllowed(admin, null, 'read'), true);
  assert.equal(isShareOperationAllowed(admin, null, 'write'), true);
  assert.equal(isShareOperationAllowed({ ...admin, isActive: false }, null, 'read'), false);
  assert.equal(isShareOperationAllowed({ ...admin, is_active: 0, isActive: undefined }, null, 'read'), false);
});

test('unknown operations fail closed', () => {
  assert.equal(isShareOperationAllowed(user, { can_read: 1, can_write: 1 }, 'set-security'), false);
});

test('SMB access is limited to managed Nanako share roots', () => {
  assert.deepEqual(evaluateSmbShareAccess({ user, share, permission: { can_read: 1, can_write: 0 }, operation: 'read' }), {
    allowed: true,
    access: 'read-only',
    userId: '11111111-1111-4111-8111-111111111111',
    shareId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(evaluateSmbShareAccess({ user, share: { ...share, storage_path: 'D:\\outside' }, permission: { can_read: 1 }, operation: 'read' }).reason, 'share_out_of_scope');
  assert.equal(evaluateSmbShareAccess({ user, share: { ...share, source_type: 'external' }, permission: { can_read: 1 }, operation: 'read' }).reason, 'share_out_of_scope');
  assert.equal(evaluateSmbShareAccess({ user, share, permission: { can_read: 1 }, operation: 'write' }).reason, 'permission_denied');
});
