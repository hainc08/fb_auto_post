/** One place for status wording and badge class, so every screen says the same thing (pure: tested from the root suite). */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Nháp', cls: 'badge-draft' },
  GENERATING: { label: 'Đang tạo…', cls: 'badge-generating' },
  READY: { label: 'Chờ duyệt', cls: 'badge-ready' },
  SCHEDULED: { label: 'Đã lên lịch', cls: 'badge-scheduled' },
  PUBLISHING: { label: 'Đang đăng…', cls: 'badge-publishing' },
  PUBLISHED: { label: 'Đã đăng', cls: 'badge-published' },
  FAILED: { label: 'Lỗi', cls: 'badge-failed' },
};

export const statusMeta = (status: string) => STATUS_META[status] ?? { label: status, cls: 'badge-draft' };
