import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Empty, PaymentButtons } from '../../components/Bits.jsx';
import EventTabs from '../../components/EventTabs.jsx';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

export default function Merch() {
  const { id } = useParams();
  const [event, setEvent] = useState(null);
  const [items, setItems] = useState(null);
  const [sales, setSales] = useState([]);
  const [revenueTotal, setRevenueTotal] = useState(0);
  const [newItem, setNewItem] = useState({ name: '', price: '', maxCount: '' });
  const [sellDrafts, setSellDrafts] = useState({}); // itemId -> { quantity, paymentMethod, paymentNote }
  const [msg, setMsg] = useState('');

  const load = () => api.get(`/api/admin/events/${id}/merch`).then((r) => {
    setItems(r.items);
    setSales(r.sales);
    setRevenueTotal(r.revenueTotal);
  });
  useEffect(() => { api.get(`/api/admin/events/${id}`).then(setEvent); load(); /* eslint-disable-next-line */ }, [id]);

  const draft = (itemId) => sellDrafts[itemId] || { quantity: 1, paymentMethod: '', paymentNote: '' };
  const setDraft = (itemId, patch) => setSellDrafts((d) => ({ ...d, [itemId]: { ...draft(itemId), ...patch } }));

  const addItem = async () => {
    setMsg('');
    if (!newItem.name.trim()) return setMsg('Give the item a name.');
    try {
      await api.post(`/api/admin/events/${id}/merch`, {
        name: newItem.name, price: newItem.price || null, maxCount: Number(newItem.maxCount) || 0,
      });
      setNewItem({ name: '', price: '', maxCount: '' });
      load();
    } catch (e) { setMsg(e.message); }
  };

  const editItem = async (item, patch) => {
    setMsg('');
    try { await api.patch(`/api/admin/merch/${item.id}`, patch); load(); }
    catch (e) { setMsg(e.message); }
  };

  const removeItem = async (item) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/merch/${item.id}`); load(); }
    catch (e) { setMsg(e.message); }
  };

  const sell = async (item) => {
    const d = draft(item.id);
    setMsg('');
    if (!d.paymentMethod) return setMsg('Choose a payment method before recording the sale.');
    try {
      await api.post(`/api/admin/merch/${item.id}/sale`, d);
      setSellDrafts((s) => ({ ...s, [item.id]: { quantity: 1, paymentMethod: '', paymentNote: '' } }));
      load();
    } catch (e) { setMsg(e.message); }
  };

  const undo = async (sale) => {
    if (!confirm(`Undo the sale of ${sale.quantity} × ${sale.itemName}?`)) return;
    setMsg('');
    try { await api.del(`/api/admin/merch/sales/${sale.id}`); load(); }
    catch (e) { setMsg(e.message); }
  };

  if (!event || !items) return <p className="muted" style={{ paddingTop: 40 }}>Loading…</p>;

  return (
    <>
      <div className="spread" style={{ marginBottom: 16 }}>
        <div>
          <p className="eyebrow">{event.title}</p>
          <h1 style={{ margin: 0 }}>Merch</h1>
        </div>
        <span className="small muted">Revenue: {money(revenueTotal)}</span>
      </div>
      <EventTabs id={id} />

      {msg && <p className="note bad" style={{ marginBottom: 14 }}>{msg}</p>}

      <div className="card stack" style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0 }}>Items</h2>
        {items.length === 0 && <Empty title="No items yet">Add what you're selling at the table below.</Empty>}
        {items.length > 0 && (
          <div style={{ overflow: 'auto' }}>
            <table>
              <thead><tr><th>Name</th><th>Price</th><th>Max</th><th>Sold</th><th>Remaining</th><th /></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input defaultValue={item.name} onBlur={(e) => e.target.value !== item.name && editItem(item, { name: e.target.value })} style={{ minWidth: 120 }} />
                    </td>
                    <td>
                      <input type="number" step="0.01" defaultValue={item.price ?? ''} placeholder="—"
                        onBlur={(e) => Number(e.target.value || 0) !== (item.price || 0) && editItem(item, { price: e.target.value })}
                        style={{ width: 80 }} />
                    </td>
                    <td>
                      <input type="number" defaultValue={item.maxCount}
                        onBlur={(e) => Number(e.target.value) !== item.maxCount && editItem(item, { maxCount: e.target.value })}
                        style={{ width: 70 }} />
                    </td>
                    <td className="mono">{item.soldCount}</td>
                    <td className="mono">{item.remaining}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm danger" onClick={() => removeItem(item)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <input placeholder="Item name" value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} style={{ flex: 1 }} />
          <input type="number" step="0.01" placeholder="Price" value={newItem.price} onChange={(e) => setNewItem({ ...newItem, price: e.target.value })} style={{ width: 90 }} />
          <input type="number" placeholder="Max count" value={newItem.maxCount} onChange={(e) => setNewItem({ ...newItem, maxCount: e.target.value })} style={{ width: 100 }} />
          <button className="btn primary" onClick={addItem}>Add item</button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="card stack" style={{ marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Record a sale</h2>
          {items.map((item) => (
            <div key={item.id} className="row" style={{ alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid var(--rule)', paddingBottom: 12 }}>
              <strong style={{ minWidth: 140 }}>{item.name}</strong>
              <span className="small muted">{item.remaining} left</span>
              <input type="number" min="1" max={item.remaining} value={draft(item.id).quantity}
                onChange={(e) => setDraft(item.id, { quantity: Number(e.target.value) || 1 })}
                style={{ width: 64 }} disabled={item.remaining === 0} />
              <PaymentButtons value={draft(item.id).paymentMethod} onChange={(v) => setDraft(item.id, { paymentMethod: v })} />
              <input placeholder="Note (optional)" value={draft(item.id).paymentNote}
                onChange={(e) => setDraft(item.id, { paymentNote: e.target.value })} style={{ width: 160 }} />
              <button className="btn sm signal" onClick={() => sell(item)} disabled={item.remaining === 0}>
                {item.remaining === 0 ? 'Sold out' : 'Record sale'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <p className="eyebrow" style={{ padding: '14px 16px 0' }}>Recent sales</p>
        {sales.length === 0
          ? <p className="small muted" style={{ padding: 16 }}>Nothing sold yet.</p>
          : (
            <table>
              <thead><tr><th>When</th><th>Item</th><th>Qty</th><th>Method</th><th>Note</th><th>Staff</th><th /></tr></thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td className="small muted">{new Date(s.createdAt).toLocaleString()}</td>
                    <td>{s.itemName}</td>
                    <td className="mono">{s.quantity}</td>
                    <td>{s.paymentMethod}</td>
                    <td className="small muted">{s.paymentNote || '—'}</td>
                    <td className="small muted">{s.processedByName}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm danger" onClick={() => undo(s)}>Undo</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  );
}
