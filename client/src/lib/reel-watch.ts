/**
 * Post whose Reel is being made. Set by the Reel page; the Posts page reads it and follows the job,
 * so the result is announced after the Reel page is left. Kept per tab.
 */
const KEY = 'reelWatch';

export const reelWatch = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (postId: string | null) => {
    try {
      if (postId) sessionStorage.setItem(KEY, postId);
      else sessionStorage.removeItem(KEY);
    } catch {
      // private window: the result is simply not announced on the Posts page
    }
  },
};
