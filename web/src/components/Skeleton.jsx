/// Grey placeholder shapes shown while a page's data loads, laid out like the
/// page they stand in for so nothing jumps when the real content arrives.
/// Screen readers get one "Loading…" announcement per skeleton, not the shapes.

export const Bone = ({ w = '100%', h = 14, r, style }) => (
  <span className="bone" style={{ width: w, height: h, borderRadius: r, ...style }} />
);

/// A few lines of text, the last one shorter like a real paragraph.
export const BoneLines = ({ lines = 3, h = 12 }) => (
  <span className="bone-lines">
    {Array.from({ length: lines }, (_, i) => <Bone key={i} h={h} w={i === lines - 1 && lines > 1 ? '60%' : '100%'} />)}
  </span>
);

function Loading({ children, style }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" style={style}>
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="stack">{children}</div>
    </div>
  );
}

const Header = ({ crumbs = true, sub = true }) => (
  <header className="stack" style={{ padding: '40px 0 24px', gap: 10, maxWidth: 680 }}>
    {crumbs && <Bone w={140} h={11} />}
    <Bone w={180} h={11} />
    <Bone w="70%" h={38} r={8} />
    {sub && <Bone w="45%" h={14} />}
  </header>
);

/// Event cards on the home page.
export const EventCardsSkeleton = ({ count = 3 }) => (
  <Loading>
    <div className="stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(300px,100%),1fr))' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stub">
          <div className="stub-accent" style={{ background: 'var(--rule)' }} />
          <div className="stub-head stack" style={{ gap: 10 }}>
            <Bone w={150} h={11} />
            <Bone w="75%" h={22} r={6} />
            <Bone w="55%" h={12} />
          </div>
          <div className="stub-tear" />
          <div className="stub-foot spread">
            <Bone w={90} h={12} />
            <Bone w={80} h={30} r={10} />
          </div>
        </div>
      ))}
    </div>
  </Loading>
);

export const EventPageSkeleton = () => (
  <Loading>
    <Header />
    <div className="grid-2" style={{ alignItems: 'start', gap: 28 }}>
      <div className="card stack">
        <BoneLines lines={5} />
        <BoneLines lines={2} h={11} />
      </div>
      <div className="card stack">
        <Bone w={120} h={22} r={6} />
        {[0, 1].map((i) => (
          <div key={i} className="spread" style={{ flexWrap: 'nowrap' }}>
            <Bone w="45%" h={14} />
            <Bone w={70} h={14} />
          </div>
        ))}
        <Bone w={110} h={38} r={10} />
      </div>
    </div>
  </Loading>
);

export const ScheduleSkeleton = () => (
  <Loading>
    <Header sub={false} />
    <Bone w={320} h={36} r={10} style={{ maxWidth: '100%' }} />
    {[0, 1, 2].map((i) => (
      <div key={i} className="schedule-slot">
        <div className="schedule-time"><Bone w={60} h={16} /></div>
        <div className="card stack" style={{ gap: 8 }}>
          <Bone w="50%" h={16} />
          <Bone w="70%" h={12} />
          <Bone w={70} h={20} r={999} />
        </div>
      </div>
    ))}
  </Loading>
);

/// Ticket stubs on "My tickets".
export const TicketsSkeleton = () => (
  <Loading>
    <header className="stack" style={{ padding: '40px 0 24px', gap: 10 }}>
      <Bone w={100} h={11} />
      <Bone w={160} h={38} r={8} />
    </header>
    <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill,minmax(min(320px,100%),1fr))' }}>
      {[0, 1].map((i) => (
        <div key={i} className="stub">
          <div className="stub-accent" style={{ background: 'var(--rule)' }} />
          <div className="stub-head stack" style={{ gap: 10, justifyItems: 'center' }}>
            <Bone w="100%" h={11} style={{ maxWidth: 150, justifySelf: 'start' }} />
            <Bone w="70%" h={22} r={6} style={{ justifySelf: 'start' }} />
            <Bone w={190} h={190} r={8} style={{ marginTop: 10 }} />
            <Bone w={150} h={24} r={6} />
          </div>
        </div>
      ))}
    </div>
  </Loading>
);

/// Any other page: a heading and a couple of cards of content. Staff pages
/// vary too much to mirror one by one, and this keeps the frame steady.
export const PageSkeleton = ({ crumbs = false }) => (
  <Loading>
    <Header crumbs={crumbs} />
    <div className="card stack"><BoneLines lines={4} /></div>
    <div className="card stack"><BoneLines lines={3} /></div>
  </Loading>
);

/// Rows of a list or table that loads below an already-drawn header.
export const RowsSkeleton = ({ rows = 5 }) => (
  <Loading>
    <div className="card stack" style={{ gap: 14 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="spread" style={{ flexWrap: 'nowrap' }}>
          <Bone w={`${55 - (i % 3) * 10}%`} h={13} />
          <Bone w={80} h={13} />
        </div>
      ))}
    </div>
  </Loading>
);
