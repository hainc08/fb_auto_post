import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { productsApi, PLATFORM_LABEL, type AffiliateProduct, type PostProduct } from '../api';

export const MAX_POST_PRODUCTS = 3;

interface Props {
  /** The post's domain: its products are listed first */
  domainId: string | null;
  value: string[];
  onChange(ids: string[], picked: PostProduct[]): void;
  /** Products already on the post (an archived one is still shown while it stays attached) */
  attached?: PostProduct[];
  disabled?: boolean;
}

/** Up to 3 affiliate products for a post: AI mentions them, their links go at the end and in the first comment. */
export default function ProductPicker({ domainId, value, onChange, attached = [], disabled }: Props) {
  const [products, setProducts] = useState<AffiliateProduct[] | null>(null);

  useEffect(() => {
    productsApi
      .list()
      .then((r) => setProducts(r.data))
      .catch(() => setProducts([]));
  }, []);

  if (!products) return null;
  // The list comes least recently used first; the post's domain goes before the others
  const pool: PostProduct[] = [...attached.filter((a) => !products.some((p) => p.id === a.id)), ...products];
  const ordered = [...pool.filter((p) => (p as AffiliateProduct).domainId === domainId), ...pool.filter((p) => (p as AffiliateProduct).domainId !== domainId)];

  function toggle(id: string) {
    const ids = value.includes(id) ? value.filter((v) => v !== id) : [...value, id].slice(0, MAX_POST_PRODUCTS);
    onChange(ids, ids.map((i) => pool.find((p) => p.id === i)!).filter(Boolean));
  }

  return (
    <div className="product-picker">
      <div className="label-row">
        <span className="form-label" id="products-label">Sản phẩm affiliate</span>
        <span className="char-count">{value.length}/{MAX_POST_PRODUCTS}</span>
      </div>
      {ordered.length === 0 ? (
        <p className="field-hint" style={{ marginTop: 0 }}>
          Chưa có sản phẩm nào. <Link to="/products">Thêm sản phẩm</Link> để gắn link Shopee, Lazada, TikTok Shop vào bài.
        </p>
      ) : (
        <>
          <div className="row" role="group" aria-labelledby="products-label" style={{ flexWrap: 'wrap', gap: 6 }}>
            {ordered.map((p) => {
              const on = value.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className={`chip-btn ${on ? 'active' : ''}`}
                  disabled={disabled || (!on && value.length >= MAX_POST_PRODUCTS)}
                  onClick={() => toggle(p.id)}
                  title={p.url}
                >
                  {p.name}
                  <span className="muted"> · {PLATFORM_LABEL[p.platform]}{p.price ? ` · ${p.price}` : ''}</span>
                </button>
              );
            })}
          </div>
          <p className="field-hint">
            AI nhắc tên và lợi ích sản phẩm trong bài; link mua được thêm tự động vào cuối bài và bình luận đầu. <Link to="/products">Quản lý sản phẩm</Link>
          </p>
        </>
      )}
    </div>
  );
}
