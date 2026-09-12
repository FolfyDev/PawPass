import { Link } from 'react-router-dom';
import { Empty } from '../components/Bits.jsx';
import { usePageMeta } from '../lib/meta.js';

export default function NotFound() {
  usePageMeta({ title: 'Page not found', noindex: true });

  return (
    <div style={{ paddingTop: 40 }}>
      <Empty title="404: That page does not exist">
        <p style={{ margin: '0 0 14px' }}>The link may be old, or the page may have moved.</p>
        <Link className="btn sm" to="/">Back to events</Link>
      </Empty>
    </div>
  );
}
