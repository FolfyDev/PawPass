import { api } from '../lib/api.js';
import Modal from './Modal.jsx';


export default function PrintPreviewModal({ code, busy, onCancel, onConfirm }) {
  if (!code) return null;
  return (
    <Modal title="Print preview" onClose={onCancel}
      footer={<>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={onConfirm}>{busy ? 'Sending…' : 'Print'}</button>
      </>}>
      <div style={{ display: 'grid', placeItems: 'center', padding: '10px 0' }}>
        <img
          src={`${api.base}/api/badges/registration/${code}.png`}
          alt="Badge preview"
          style={{ maxWidth: '100%', border: '1px solid var(--rule)', borderRadius: 8 }}
        />
      </div>
    </Modal>
  );
}
