/**
 * Facebook JS SDK login with the App ID from Settings (read at runtime, so a new
 * app needs no rebuild). The SDK script is loaded by index.html.
 */

/** Posting needs these; nothing else may ever block connecting a Page */
const POSTING_SCOPES = 'pages_show_list,pages_manage_posts,pages_read_engagement';
/** Optional: read + reply to comments. An App without them may refuse the whole login */
const COMMENT_SCOPES = 'pages_read_user_content,pages_manage_engagement';
/** After a failed login with the comment scopes, the next click asks only for the posting scopes */
let withoutCommentScopes = false;

type FBLoginResponse = { authResponse?: { accessToken: string } | null };
type FBGlobal = {
  init(options: Record<string, unknown>): void;
  login(cb: (response: FBLoginResponse) => void, options: Record<string, unknown>): void;
};

declare global {
  interface Window {
    FB?: FBGlobal;
    fbAsyncInit?: () => void;
  }
}

/** Opens the Facebook login popup and resolves with a short-lived User Access Token. */
export function loginWithFacebook(appId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!appId) return reject(new Error('Chưa cấu hình Facebook App ID trong Cài đặt.'));

    const run = () => {
      const FB = window.FB!;
      FB.init({ appId, cookie: false, xfbml: false, version: 'v23.0' });
      FB.login(
        (response) => {
          if (response.authResponse?.accessToken) return resolve(response.authResponse.accessToken);
          if (!withoutCommentScopes) {
            withoutCommentScopes = true;
            return reject(new Error('Chưa đăng nhập được với quyền bình luận (App có thể chưa thêm quyền này, hoặc bạn đã huỷ). Bấm lại để kết nối chỉ với quyền đăng bài.'));
          }
          reject(new Error('Bạn đã huỷ đăng nhập hoặc chưa cấp quyền cho App.'));
        },
        { scope: withoutCommentScopes ? POSTING_SCOPES : `${POSTING_SCOPES},${COMMENT_SCOPES}`, return_scopes: true, auth_type: 'rerequest' }
      );
    };

    // Called straight from the click when the SDK is ready, so the popup is not blocked
    if (window.FB) return run();
    window.fbAsyncInit = run;
    setTimeout(() => {
      if (!window.FB) reject(new Error('Không tải được Facebook SDK (trình chặn quảng cáo?). Hãy dùng cách dán token.'));
    }, 8000);
  });
}
