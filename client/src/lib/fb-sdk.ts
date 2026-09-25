/**
 * Facebook JS SDK login with the App ID from Settings (read at runtime, so a new
 * app needs no rebuild). The SDK script is loaded by index.html.
 */

const SCOPES = 'pages_show_list,pages_manage_posts,pages_read_engagement';

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
        (response) =>
          response.authResponse?.accessToken
            ? resolve(response.authResponse.accessToken)
            : reject(new Error('Bạn đã huỷ đăng nhập hoặc chưa cấp quyền cho App.')),
        { scope: SCOPES, return_scopes: true, auth_type: 'rerequest' }
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
