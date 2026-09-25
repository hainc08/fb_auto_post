import { useState, useEffect } from 'react';
import { Plus, Trash2, ExternalLink } from 'lucide-react';
import { FacebookIcon } from '../components/Icons';
import { pagesApi } from '../api';

interface PageData {
  id: string;
  pageId: string;
  pageName: string;
  pageCategory: string | null;
  pageAvatar: string | null;
  isActive: boolean;
  createdAt: string;
  _count: { posts: number };
}

export default function PagesPage() {
  const [pages, setPages] = useState<PageData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPages();
    // Initialize FB SDK
    (window as any).fbAsyncInit = function() {
      (window as any).FB.init({
        appId      : import.meta.env.VITE_FB_APP_ID || '123456789',
        cookie     : true,
        xfbml      : true,
        version    : 'v18.0'
      });
    };
  }, []);

  async function loadPages() {
    try {
      const res = await pagesApi.list();
      setPages(res.data);
    } catch { setPages([]); }
    finally { setLoading(false); }
  }

  async function handleDisconnect(id: string) {
    if (!confirm('Bạn muốn ngắt kết nối trang này?')) return;
    try {
      await pagesApi.disconnect(id);
      setPages(pages.filter(p => p.id !== id));
    } catch (err: any) { alert(err.message); }
  }

  function handleConnectFacebook() {
    if (!(window as any).FB) {
      alert('Facebook SDK chưa được tải xong, vui lòng thử lại sau giây lát.');
      return;
    }

    (window as any).FB.login((response: any) => {
      if (response.authResponse) {
        fetchFacebookPages(response.authResponse.accessToken);
      } else {
        console.log('User cancelled login or did not fully authorize.');
      }
    }, { scope: 'pages_show_list,pages_manage_posts,pages_read_engagement' });
  }

  function fetchFacebookPages(userAccessToken: string) {
    setLoading(true);
    (window as any).FB.api('/me/accounts', { access_token: userAccessToken }, async (response: any) => {
      if (response && !response.error) {
        const pagesToConnect = response.data.map((p: any) => ({
          pageId: p.id,
          pageName: p.name,
          accessToken: p.access_token,
          category: p.category,
        }));

        if (pagesToConnect.length === 0) {
          alert('Không tìm thấy Facebook Page nào trong tài khoản của bạn.');
          setLoading(false);
          return;
        }

        try {
          await pagesApi.connect(pagesToConnect);
          alert(`Đã kết nối thành công ${pagesToConnect.length} trang!`);
          loadPages();
        } catch (err: any) {
          alert('Lỗi kết nối lưu trang: ' + err.message);
          setLoading(false);
        }
      } else {
        alert('Lỗi khi lấy danh sách Page: ' + (response.error?.message || 'Unknown error'));
        setLoading(false);
      }
    });
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Kênh Facebook</h1>
          <p>Quản lý các trang Facebook đã kết nối</p>
        </div>
        <button className="btn btn-primary" onClick={handleConnectFacebook}>
          <Plus size={18} /> Kết nối Page mới
        </button>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : pages.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <FacebookIcon size={56} style={{ color: '#1877F2', opacity: 0.5 }} />
            <h3>Chưa kết nối Facebook Page nào</h3>
            <p>Kết nối Facebook Page để bắt đầu đăng bài tự động</p>
            <button className="btn btn-primary" onClick={handleConnectFacebook}>
              <FacebookIcon size={18} /> Kết nối Facebook
            </button>
          </div>
        </div>
      ) : (
        <div className="grid-3">
          {pages.map(page => (
            <div className="card" key={page.id} style={{ position: 'relative' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                {page.pageAvatar ? (
                  <img src={page.pageAvatar} alt="" style={{ width: 48, height: 48, borderRadius: 'var(--radius-full)' }} />
                ) : (
                  <div style={{
                    width: 48, height: 48, borderRadius: 'var(--radius-full)',
                    background: 'linear-gradient(135deg, #1877F2, #42a5f5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}>
                    <FacebookIcon size={24} color="white" />
                  </div>
                )}
                <div>
                  <h3 style={{ fontSize: '1rem' }}>{page.pageName}</h3>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)' }}>
                    {page.pageCategory || 'Facebook Page'}
                  </span>
                </div>
              </div>
              <div style={{
                display: 'flex', gap: 16, padding: '12px 0',
                borderTop: '1px solid var(--border-subtle)', fontSize: '0.85rem'
              }}>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Bài đăng: </span>
                  <strong>{page._count.posts}</strong>
                </div>
                <div>
                  <span style={{ color: 'var(--text-tertiary)' }}>Trạng thái: </span>
                  <span className={`badge ${page.isActive ? 'badge-published' : 'badge-failed'}`}>
                    {page.isActive ? 'Hoạt động' : 'Đã ngắt'}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <a
                  href={`https://facebook.com/${page.pageId}`}
                  target="_blank"
                  rel="noopener"
                  className="btn btn-secondary btn-sm"
                  style={{ flex: 1 }}
                >
                  <ExternalLink size={14} /> Xem Page
                </a>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleDisconnect(page.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
