type Role = 'ADMIN' | 'USER';

/**
 * Why an account change must be refused (null = allowed): nobody deletes,
 * disables or demotes themselves, and at least one active ADMIN always remains.
 */
export function accountChangeBlock(input: {
  actorId: string;
  target: { id: string; role: Role; isActive: boolean };
  change: { isActive?: boolean; role?: Role; remove?: boolean };
  otherActiveAdmins: number;
}): string | null {
  const { actorId, target, change, otherActiveAdmins } = input;
  const takesAway = change.remove === true || change.isActive === false || change.role === 'USER';
  if (target.id === actorId && takesAway) return 'Không thể tự xoá, tự vô hiệu hoá hoặc tự bỏ quyền quản trị của chính mình.';
  if (target.role === 'ADMIN' && target.isActive && takesAway && otherActiveAdmins === 0) {
    return 'Phải còn ít nhất một quản trị viên đang hoạt động.';
  }
  return null;
}
