import { useEffect } from 'react';

export default function Modal({ title, children, onClose, footer, wide }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(920px,100%)' } : undefined}>
        <div className="sheet-body">
          <h2 style={{ marginTop: 0 }}>{title}</h2>
          {children}
        </div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
