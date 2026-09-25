import { FacebookApiError } from './clients/facebook';
import { HttpNetworkError, HttpTimeoutError } from './http';
import { UnrecoverableJobError } from './job-queue';

export const UNCERTAIN_PUBLISH_MESSAGE =
  'Không nhận được phản hồi từ Facebook nên không rõ bài đã lên Page chưa. Hãy kiểm tra Page trước khi bấm "Đăng lại" để tránh đăng trùng.';

/**
 * Decide whether a failed attempt is worth retrying, and what to tell the user.
 * A timeout/network error while publishing is NOT retried: Facebook may have
 * created the post anyway, and retrying would publish it twice.
 */
export function classifyFailure(error: unknown, step: string): { message: string; retryable: boolean; code?: string } {
  if (error instanceof UnrecoverableJobError) return { message: error.message, retryable: false };
  if (error instanceof FacebookApiError) {
    return { message: error.message, retryable: error.retryable, code: error.errorCode };
  }
  if (step === 'publish_facebook' && (error instanceof HttpTimeoutError || error instanceof HttpNetworkError)) {
    return { message: UNCERTAIN_PUBLISH_MESSAGE, retryable: false };
  }
  return { message: (error as Error)?.message ?? String(error), retryable: true };
}
