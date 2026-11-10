const READ_OPERATIONS = new Set(['list', 'read', 'download', 'preview']);
const WRITE_OPERATIONS = new Set(['create', 'write', 'delete', 'rename', 'move', 'copy', 'restore', 'extract']);
const SMB_OPERATION_CLASS = new Map([
  ['query-directory', 'list'], ['read-data', 'read'], ['read-attributes', 'read'],
  ['create-file', 'create'], ['create-directory', 'create'], ['write-data', 'write'],
  ['set-length', 'write'], ['set-attributes', 'write'], ['delete-file', 'delete'],
  ['delete-directory', 'delete'], ['rename', 'rename'], ['move', 'move'],
  ['copy', 'copy'],
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isActive(user) {
  if (!user) return false;
  const value = user.isActive ?? user.is_active;
  return value === true || value === 1;
}

/**
 * Resolve Nanako's existing per-share permission model for a concrete file operation.
 * Unknown operations fail closed so a future protocol adapter cannot accidentally
 * inherit write access merely because it forgot to classify a command.
 */
export function isShareOperationAllowed(user, permission, operation) {
  if (!isActive(user)) return false;
  if (!READ_OPERATIONS.has(operation) && !WRITE_OPERATIONS.has(operation)) return false;
  if (user.role === 'admin') return true;
  if (!permission || !permission.can_read) return false;
  if (READ_OPERATIONS.has(operation)) return true;
  return Boolean(permission.can_write);
}

/**
 * SMB-facing authorization decision. Only Nanako-managed share roots can be
 * exported; callers must still resolve paths below the returned share ID with
 * a traversal/reparse-point-safe VFS implementation.
 */
export function evaluateSmbShareAccess({ user, share, permission, operation }) {
  if (!isActive(user)) {
    return { allowed: false, reason: 'inactive_user' };
  }
  if (!share || !UUID_PATTERN.test(share.id || '') || share.source_type !== 'managed' || share.storage_path != null) {
    return { allowed: false, reason: 'share_out_of_scope' };
  }
  const normalizedOperation = SMB_OPERATION_CLASS.get(operation) || operation;
  if (!isShareOperationAllowed(user, permission, normalizedOperation)) {
    return { allowed: false, reason: 'permission_denied' };
  }
  return {
    allowed: true,
    access: user.role === 'admin' || permission?.can_write ? 'read-write' : 'read-only',
    userId: user.id,
    shareId: share.id,
  };
}
