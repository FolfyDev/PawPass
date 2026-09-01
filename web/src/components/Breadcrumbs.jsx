import { Link } from 'react-router-dom';

/// `items` is an array of `{ label, to }` — the last item is rendered as
/// plain text (the current page) even if it has a `to`.
export default function Breadcrumbs({ items }) {
  return (
    <nav aria-label="Breadcrumb" className="small muted" style={{ marginBottom: 14 }}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i}>
            {i > 0 && <span aria-hidden="true" style={{ margin: '0 6px' }}>/</span>}
            {last || !item.to
              ? <span aria-current={last ? 'page' : undefined}>{item.label}</span>
              : <Link to={item.to}>{item.label}</Link>}
          </span>
        );
      })}
    </nav>
  );
}
