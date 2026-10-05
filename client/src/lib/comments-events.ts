/**
 * Fired on `window` whenever comment counts change (a reply, "Đã xử lý", a refresh, drafts sent):
 * the menu's "Bình luận" badge listens, wherever the change was made.
 */
export const COMMENTS_CHANGED = 'comments:changed';

export const announceCommentsChanged = () => window.dispatchEvent(new Event(COMMENTS_CHANGED));
