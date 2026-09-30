import { Search } from 'lucide-react';
import type { ContentDomain } from '../api';
import { TIME_RANGES, type TimeRange } from '../lib/post-display';

export type FilterKey = 'q' | 'page' | 'domain' | 'time';

interface Props {
  q: string;
  pageId: string;
  domainId: string;
  time: TimeRange;
  /** Pages seen in the loaded posts (the filter shows when there is more than one) */
  pages: Array<{ id: string; pageName: string }>;
  domains: ContentDomain[];
  onChange: (key: FilterKey, value: string) => void;
}

export default function PostFilters({ q, pageId, domainId, time, pages, domains, onChange }: Props) {
  return (
    <div className="post-filters">
      <label className="topbar-search post-search">
        <Search size={15} aria-hidden="true" />
        <input type="search" placeholder="Tìm bài đăng..." aria-label="Tìm trong danh sách bài đăng" value={q} onChange={(e) => onChange('q', e.target.value)} />
      </label>
      {pages.length > 1 && (
        <select className="form-select select-sm post-filter" aria-label="Lọc theo Page" value={pageId} onChange={(e) => onChange('page', e.target.value)}>
          <option value="">Mọi Page</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>{p.pageName}</option>
          ))}
        </select>
      )}
      {domains.length > 1 && (
        <select className="form-select select-sm post-filter" aria-label="Lọc theo lĩnh vực" value={domainId} onChange={(e) => onChange('domain', e.target.value)}>
          <option value="">Mọi lĩnh vực</option>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
              {d.isArchived ? ' (lưu trữ)' : ''}
            </option>
          ))}
        </select>
      )}
      <select className="form-select select-sm post-filter" aria-label="Lọc theo thời gian" value={time} onChange={(e) => onChange('time', e.target.value)}>
        {TIME_RANGES.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
    </div>
  );
}
