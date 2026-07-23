import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { Field, Empty } from '../../components/Bits.jsx';

const NEW_ELEMENT = {
  text: { type: 'text', x: 4, y: 4, w: 26, h: 7, text: 'New text', font: 'DejaVu Sans', size: 4, weight: 600, color: '#000000', align: 'left', fit: true },
  qr:   { type: 'qr', x: 2.2, y: 4.4, w: 23, h: 23, value: '{{code}}', dark: '#000000', light: '#FFFFFF' },
  rect: { type: 'rect', x: 2, y: 2, w: 20, h: 4, fill: '#000000', radius: 0 },
  line: { type: 'line', x: 2, y: 16, w: 30, h: 0.3, fill: '#000000' },
  image:{ type: 'image', x: 2, y: 2, w: 14, h: 14, href: 'https://example.com/logo.png' },
};

/// Direct-manipulation badge designer. The canvas is a scaled millimetre grid;
/// the server renders the same JSON to PNG and to ZPL, so what you drag here is
/// what the ZD500 prints.
export default function Badges() {
  const [templates, setTemplates] = useState([]);
  const [t, setT] = useState(null);
  const [sel, setSel] = useState(null);
  const [tokens, setTokens] = useState({});
  const [preview, setPreview] = useState('');
  const [printer, setPrinter] = useState(null);
  const [presets, setPresets] = useState([]);
  const [msg, setMsg] = useState('');
  const canvas = useRef(null);
  const drag = useRef(null);

  // Fit the die to a comfortable on-screen width whatever the stock.
  const SCALE = t ? Math.min(9, 420 / t.widthMm) : 7;

  const load = async () => {
    const list = await api.get('/api/badges/templates');
    setTemplates(list);
    setT((cur) => list.find((x) => x.id === cur?.id) || list[0] || null);
  };
  useEffect(() => {
    load();
    api.get('/api/badges/tokens').then(setTokens);
    api.get('/api/badges/printer').then(setPrinter);
    api.get('/api/badges/presets').then(setPresets);
  }, []);

  // Re-render the server preview whenever the template settles.
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(async () => {
      const res = await fetch(`${api.base}/api/badges/preview.svg`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: t }),
      });
      setPreview(await res.text());
    }, 250);
    return () => clearTimeout(id);
  }, [t]);

  const elements = t?.elements || [];
  const selected = useMemo(() => elements.find((e) => e.id === sel), [elements, sel]);

  const patch = (id, p) => setT({ ...t, elements: elements.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const setT_ = (p) => setT({ ...t, ...p });

  const add = (kind) => {
    const el = { ...NEW_ELEMENT[kind], id: `${kind}_${Math.random().toString(36).slice(2, 7)}` };
    setT({ ...t, elements: [...elements, el] });
    setSel(el.id);
  };

  const onPointerDown = (e, el) => {
    e.preventDefault();
    setSel(el.id);
    const rect = canvas.current.getBoundingClientRect();
    drag.current = { id: el.id, dx: e.clientX - rect.left - el.x * SCALE, dy: e.clientY - rect.top - el.y * SCALE };
    canvas.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const rect = canvas.current.getBoundingClientRect();
    const x = Math.max(0, Math.round(((e.clientX - rect.left - drag.current.dx) / SCALE) * 10) / 10);
    const y = Math.max(0, Math.round(((e.clientY - rect.top - drag.current.dy) / SCALE) * 10) / 10);
    patch(drag.current.id, { x, y });
  };
  const onPointerUp = () => { drag.current = null; };

  const save = async () => {
    await api.patch(`/api/badges/templates/${t.id}`, t);
    setMsg('Template saved.'); setTimeout(() => setMsg(''), 2000);
    load();
  };
  const create = async () => { const n = await api.post('/api/badges/templates', { name: 'New badge' }); await load(); setT(n); };
  const duplicate = async () => { await api.post(`/api/badges/templates/${t.id}/duplicate`); load(); };
  const remove = async () => { if (confirm(`Delete "${t.name}"?`)) { await api.del(`/api/badges/templates/${t.id}`); setT(null); load(); } };

  if (!t) return (
    <>
      <h1>Badge designer</h1>
      <Empty title="No templates">
        <button className="btn primary" style={{ marginTop: 12 }} onClick={create}>Create the first template</button>
      </Empty>
    </>
  );

  return (
    <>
      <div className="spread" style={{ marginBottom: 14 }}>
        <div>
          <p className="eyebrow">Badge designer</p>
          <h1 style={{ margin: 0 }}>{t.name}</h1>
        </div>
        <div className="row">
          <select value={t.id} onChange={(e) => { setT(templates.find((x) => x.id === e.target.value)); setSel(null); }}>
            {templates.map((x) => <option key={x.id} value={x.id}>{x.name}{x.isDefault ? ' (default)' : ''}</option>)}
          </select>
          <button className="btn sm" onClick={create}>New</button>
          <button className="btn sm" onClick={duplicate}>Duplicate</button>
          <button className="btn primary" onClick={save}>Save template</button>
        </div>
      </div>
      {msg && <p className="note good" style={{ marginBottom: 12 }}>{msg}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 24, alignItems: 'start' }}>
        {/* ---- canvas ---- */}
        <div className="stack">
          <div
            ref={canvas}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              position: 'relative',
              width: t.widthMm * SCALE, height: t.heightMm * SCALE,
              background: t.background, borderRadius: 8, boxShadow: 'var(--shadow)',
              touchAction: 'none', overflow: 'hidden',
            }}
          >
            {elements.map((el) => (
              <div
                key={el.id}
                onPointerDown={(e) => onPointerDown(e, el)}
                title={el.id}
                style={{
                  position: 'absolute',
                  left: el.x * SCALE, top: el.y * SCALE,
                  width: el.w * SCALE, height: Math.max(el.h, 0.5) * SCALE,
                  outline: sel === el.id ? '2px solid var(--signal)' : '1px dashed rgba(255,255,255,.25)',
                  cursor: 'grab', borderRadius: 3,
                  transform: el.rotate ? `rotate(${el.rotate}deg)` : undefined,
                }}
              />
            ))}
          </div>
          <p className="small muted" style={{ maxWidth: t.widthMm * SCALE }}>
            Drag the outlines to position. The rendered preview on the right is produced by the same code that drives the printer.
          </p>
          <div className="row">
            {Object.keys(NEW_ELEMENT).map((k) => <button key={k} className="btn sm" onClick={() => add(k)}>+ {k}</button>)}
          </div>
        </div>

        {/* ---- inspector ---- */}
        <div className="stack">
          <section className="card stack">
            <h2 style={{ margin: 0 }}>Card</h2>
            <div className="grid-2">
              <Field label="Name"><input value={t.name} onChange={(e) => setT_({ name: e.target.value })} /></Field>
              <Field label="Background"><input type="color" value={t.background} onChange={(e) => setT_({ background: e.target.value })} style={{ width: 70, padding: 4 }} /></Field>
              <Field label="Label stock" help="Match the roll in the printer">
                <select
                  value={presets.findIndex((p) => p.widthMm === t.widthMm && p.heightMm === t.heightMm)}
                  onChange={(e) => {
                    const p = presets[Number(e.target.value)];
                    if (p) setT_({ widthMm: p.widthMm, heightMm: p.heightMm });
                  }}
                >
                  <option value={-1}>Custom</option>
                  {presets.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Width (mm)"><input type="number" step="0.1" value={t.widthMm} onChange={(e) => setT_({ widthMm: Number(e.target.value) })} /></Field>
              <Field label="Height (mm)"><input type="number" step="0.1" value={t.heightMm} onChange={(e) => setT_({ heightMm: Number(e.target.value) })} /></Field>
              <Field label="Render DPI" help={printer ? `Printer reports ${printer.dpi} dpi` : ''}>
                <input type="number" value={t.dpi} onChange={(e) => setT_({ dpi: Number(e.target.value) })} />
              </Field>
              <Field label="Default template">
                <label className="row small"><input type="checkbox" checked={!!t.isDefault} onChange={(e) => setT_({ isDefault: e.target.checked })} /> Use when an event has none</label>
              </Field>
            </div>
          </section>

          <section className="card stack">
            <div className="spread">
              <h2 style={{ margin: 0 }}>{selected ? `Element · ${selected.type}` : 'Element'}</h2>
              {selected && <button className="btn sm danger" onClick={() => { setT({ ...t, elements: elements.filter((e) => e.id !== sel) }); setSel(null); }}>Remove</button>}
            </div>
            {!selected && <p className="small muted" style={{ margin: 0 }}>Select something on the card to edit it.</p>}
            {selected && (
              <>
                <div className="grid-2">
                  {['x', 'y', 'w', 'h'].map((k) => (
                    <Field key={k} label={`${k.toUpperCase()} (mm)`}>
                      <input type="number" step="0.1" value={selected[k]} onChange={(e) => patch(sel, { [k]: Number(e.target.value) })} />
                    </Field>
                  ))}
                </div>

                {selected.type === 'text' && (
                  <>
                    <Field label="Text" help="Use the tokens listed below">
                      <input value={selected.text} onChange={(e) => patch(sel, { text: e.target.value })} />
                    </Field>
                    <div className="grid-2">
                      <Field label="Font"><input value={selected.font} onChange={(e) => patch(sel, { font: e.target.value })} /></Field>
                      <Field label="Size (mm)"><input type="number" step="0.1" value={selected.size} onChange={(e) => patch(sel, { size: Number(e.target.value) })} /></Field>
                      <Field label="Weight">
                        <select value={selected.weight} onChange={(e) => patch(sel, { weight: Number(e.target.value) })}>
                          {[300, 400, 500, 600, 700, 800].map((w) => <option key={w}>{w}</option>)}
                        </select>
                      </Field>
                      <Field label="Align">
                        <select value={selected.align} onChange={(e) => patch(sel, { align: e.target.value })}>
                          {['left', 'center', 'right'].map((a) => <option key={a}>{a}</option>)}
                        </select>
                      </Field>
                      <Field label="Colour"><input type="color" value={selected.color?.startsWith('#') ? selected.color : '#ffffff'} onChange={(e) => patch(sel, { color: e.target.value })} style={{ width: 70, padding: 4 }} /></Field>
                      <Field label="Letter spacing (mm)"><input type="number" step="0.05" value={selected.letterSpacing || 0} onChange={(e) => patch(sel, { letterSpacing: Number(e.target.value) })} /></Field>
                      <Field label="Rotate (deg)" help="e.g. 90 for text reading top-to-bottom">
                        <input type="number" step="1" value={selected.rotate || 0} onChange={(e) => patch(sel, { rotate: Number(e.target.value) })} />
                      </Field>
                    </div>
                    <div className="row">
                      <label className="row small"><input type="checkbox" checked={!!selected.fit} onChange={(e) => patch(sel, { fit: e.target.checked })} /> Shrink long names to fit</label>
                      <label className="row small"><input type="checkbox" checked={!!selected.uppercase} onChange={(e) => patch(sel, { uppercase: e.target.checked })} /> Uppercase</label>
                    </div>
                  </>
                )}

                {selected.type === 'qr' && (
                  <div className="grid-2">
                    <Field label="Encodes"><input value={selected.value} onChange={(e) => patch(sel, { value: e.target.value })} /></Field>
                    <Field label="Error correction">
                      <select value={selected.ecc || 'M'} onChange={(e) => patch(sel, { ecc: e.target.value })}>
                        {['L', 'M', 'Q', 'H'].map((x) => <option key={x}>{x}</option>)}
                      </select>
                    </Field>
                    <Field label="Dark"><input type="color" value={selected.dark} onChange={(e) => patch(sel, { dark: e.target.value })} style={{ width: 70, padding: 4 }} /></Field>
                    <Field label="Light"><input type="color" value={selected.light} onChange={(e) => patch(sel, { light: e.target.value })} style={{ width: 70, padding: 4 }} /></Field>
                  </div>
                )}

                {(selected.type === 'rect' || selected.type === 'line') && (
                  <div className="grid-2">
                    <Field label="Fill"><input value={selected.fill} onChange={(e) => patch(sel, { fill: e.target.value })} /></Field>
                    <Field label="Corner radius (mm)"><input type="number" step="0.5" value={selected.radius || 0} onChange={(e) => patch(sel, { radius: Number(e.target.value) })} /></Field>
                  </div>
                )}

                {selected.type === 'image' && (
                  <Field label="Image URL" help="Must be reachable from the server"><input value={selected.href} onChange={(e) => patch(sel, { href: e.target.value })} /></Field>
                )}
              </>
            )}
          </section>

          <section className="card">
            <p className="eyebrow" style={{ marginBottom: 8 }}>Rendered preview</p>
            <div style={{ display: 'grid', placeItems: 'center', background: 'var(--paper)', borderRadius: 10, padding: 16 }}
                 dangerouslySetInnerHTML={{ __html: preview.replace(/width="\d+"/, 'width="220"').replace(/height="\d+"/, '') }} />
            <p className="eyebrow" style={{ margin: '16px 0 6px' }}>Available tokens</p>
            <div className="row small mono" style={{ gap: 6 }}>
              {Object.keys(tokens).map((k) => <span key={k} className="pill">{k}</span>)}
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Any extra question key on an event is also available as <code className="mono">{'{{your_key}}'}</code>.
            </p>
          </section>

          <div className="spread">
            <button className="btn danger" onClick={remove}>Delete template</button>
            <button className="btn primary" onClick={save}>Save template</button>
          </div>
        </div>
      </div>
    </>
  );
}
