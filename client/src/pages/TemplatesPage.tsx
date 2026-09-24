import { useState, useEffect } from 'react';
import { FileText, Plus, Pencil, Trash2, X } from 'lucide-react';
import { templatesApi } from '../api';

interface TemplateData {
  id: string;
  name: string;
  description: string | null;
  promptTemplate: string;
  imagePrompt: string | null;
  hashtags: string[];
  category: string | null;
  variables: any;
  createdAt: string;
  _count: { posts: number };
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<TemplateData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    promptTemplate: '',
    imagePrompt: '',
    hashtags: '',
    category: '',
  });

  useEffect(() => { loadTemplates(); }, []);

  async function loadTemplates() {
    try {
      const res = await templatesApi.list();
      setTemplates(res.data);
    } catch { setTemplates([]); }
    finally { setLoading(false); }
  }

  function openCreate() {
    setEditId(null);
    setForm({ name: '', description: '', promptTemplate: '', imagePrompt: '', hashtags: '', category: '' });
    setShowModal(true);
  }

  function openEdit(t: TemplateData) {
    setEditId(t.id);
    setForm({
      name: t.name,
      description: t.description || '',
      promptTemplate: t.promptTemplate,
      imagePrompt: t.imagePrompt || '',
      hashtags: t.hashtags.join(', '),
      category: t.category || '',
    });
    setShowModal(true);
  }

  async function handleSave() {
    const body = {
      ...form,
      hashtags: form.hashtags.split(',').map(h => h.trim()).filter(Boolean),
    };
    try {
      if (editId) {
        await templatesApi.update(editId, body);
      } else {
        await templatesApi.create(body);
      }
      setShowModal(false);
      loadTemplates();
    } catch (err: any) { alert(err.message); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Xóa mẫu nội dung này?')) return;
    try {
      await templatesApi.delete(id);
      setTemplates(templates.filter(t => t.id !== id));
    } catch (err: any) { alert(err.message); }
  }

  const categoryColors: Record<string, string> = {
    product: '#6366f1',
    promo: '#f59e0b',
    tips: '#06b6d4',
    news: '#22c55e',
    event: '#ec4899',
  };

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>Mẫu Nội Dung</h1>
          <p>Tạo và quản lý các mẫu prompt AI cho bài đăng</p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus size={18} /> Tạo mẫu mới
        </button>
      </div>

      {loading ? (
        <div className="loading-page"><div className="spinner spinner-lg" /></div>
      ) : templates.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <FileText size={56} style={{ opacity: 0.3 }} />
            <h3>Chưa có mẫu nội dung</h3>
            <p>Tạo mẫu prompt để AI tự động sinh bài viết cho bạn</p>
            <button className="btn btn-primary" onClick={openCreate}>
              <Plus size={18} /> Tạo mẫu đầu tiên
            </button>
          </div>
        </div>
      ) : (
        <div className="grid-3">
          {templates.map(t => (
            <div className="card" key={t.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <h3 style={{ fontSize: '1rem', marginBottom: 4 }}>{t.name}</h3>
                  {t.category && (
                    <span className="badge" style={{
                      background: `${categoryColors[t.category] || 'var(--primary-500)'}20`,
                      color: categoryColors[t.category] || 'var(--primary-400)',
                      border: `1px solid ${categoryColors[t.category] || 'var(--primary-500)'}40`,
                    }}>
                      {t.category}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                  {t._count.posts} bài
                </span>
              </div>

              {t.description && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.5 }}>
                  {t.description}
                </p>
              )}

              <div style={{
                background: 'var(--bg-glass)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
                fontSize: '0.8rem',
                color: 'var(--text-tertiary)',
                fontFamily: 'monospace',
                marginBottom: 12,
                maxHeight: 60,
                overflow: 'hidden',
                borderLeft: '3px solid var(--primary-500)',
              }}>
                {t.promptTemplate.substring(0, 120)}...
              </div>

              {t.hashtags.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {t.hashtags.slice(0, 5).map((h, i) => (
                    <span key={i} style={{
                      fontSize: '0.7rem',
                      color: 'var(--primary-400)',
                      background: 'rgba(99, 102, 241, 0.1)',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-full)',
                    }}>
                      #{h}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
                <button className="btn btn-secondary btn-sm" style={{ flex: 1 }} onClick={() => openEdit(t)}>
                  <Pencil size={14} /> Sửa
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(t.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 200, backdropFilter: 'blur(4px)',
        }}
          onClick={() => setShowModal(false)}
        >
          <div className="card" style={{ width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2>{editId ? 'Chỉnh sửa mẫu' : 'Tạo mẫu mới'}</h2>
              <button className="btn btn-ghost btn-icon" onClick={() => setShowModal(false)}>
                <X size={20} />
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Tên mẫu *</label>
              <input className="form-input" value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="VD: Bài giới thiệu sản phẩm" />
            </div>

            <div className="form-group">
              <label className="form-label">Mô tả</label>
              <input className="form-input" value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Mô tả ngắn về mẫu này" />
            </div>

            <div className="form-group">
              <label className="form-label">Danh mục</label>
              <select className="form-select" value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}>
                <option value="">Chọn danh mục</option>
                <option value="product">Sản phẩm</option>
                <option value="promo">Khuyến mãi</option>
                <option value="tips">Tips & Mẹo</option>
                <option value="news">Tin tức</option>
                <option value="event">Sự kiện</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">
                Prompt Template * <span style={{ fontWeight: 400, color: 'var(--text-tertiary)' }}>(Dùng {'{{biến}}'} cho dữ liệu động)</span>
              </label>
              <textarea className="form-textarea" rows={5} value={form.promptTemplate}
                onChange={e => setForm({ ...form, promptTemplate: e.target.value })}
                placeholder="VD: Viết bài giới thiệu sản phẩm {{ten_san_pham}} với giá {{gia}}. Nhấn mạnh điểm nổi bật..." />
            </div>

            <div className="form-group">
              <label className="form-label">Image Prompt (tiếng Anh)</label>
              <textarea className="form-textarea" rows={2} value={form.imagePrompt}
                onChange={e => setForm({ ...form, imagePrompt: e.target.value })}
                placeholder="VD: Professional product photo of {{ten_san_pham}}, studio lighting" />
            </div>

            <div className="form-group">
              <label className="form-label">Hashtags mặc định (phân cách bằng dấu phẩy)</label>
              <input className="form-input" value={form.hashtags}
                onChange={e => setForm({ ...form, hashtags: e.target.value })}
                placeholder="VD: sanpham, khuyenmai, muasam" />
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 }}>
              <button className="btn btn-secondary" onClick={() => setShowModal(false)}>Hủy</button>
              <button className="btn btn-primary" onClick={handleSave}>{editId ? 'Lưu thay đổi' : 'Tạo mẫu'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
