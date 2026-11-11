/** Placeholders in the shape of what's loading, so screens don't jump when data arrives. */

const delay = (n: number) => ({ animationDelay: `${n * 90}ms` });

function SkeletonCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, n) => (
        <div key={n} className="card skel" style={delay(n)} />
      ))}
    </>
  );
}

function SkeletonText({ lines }: { lines: number }) {
  return (
    <>
      {Array.from({ length: lines }, (_, n) => (
        <div key={n} className={`skel skel-line${n === lines - 1 ? " is-short" : ""}`} style={delay(n)} />
      ))}
    </>
  );
}

export function HeroSkeleton() {
  return (
    <section className="hero" aria-hidden>
      <div className="hero-body">
        <div className="hero-title">
          <div className="skel skel-logo" />
        </div>
        <div className="hero-meta">
          <div className="skel skel-meta" />
        </div>
        <div className="hero-overview">
          <SkeletonText lines={3} />
        </div>
      </div>
    </section>
  );
}

export function RowsSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1].map((r) => (
        <section key={r} className="row">
          <div className="row-title">
            <div className="skel skel-heading" />
          </div>
          <div className="row-track">
            <SkeletonCards count={7} />
          </div>
        </section>
      ))}
    </div>
  );
}

export function GridSkeleton({ className, count = 12, heading }: { className: string; count?: number; heading?: boolean }) {
  return (
    <div aria-hidden>
      {heading && (
        <div className="row-title skel-grid-heading">
          <div className="skel skel-heading" />
        </div>
      )}
      <div className={className}>
        <SkeletonCards count={count} />
      </div>
    </div>
  );
}

export function TitleSkeleton() {
  return (
    <main className="title-page" aria-busy="true" aria-label="Loading">
      <div className="title-body" aria-hidden>
        <div className="skel skel-logo" />
        <div className="hero-meta">
          <div className="skel skel-meta" />
        </div>
        <div className="title-overview">
          <SkeletonText lines={4} />
        </div>
        <div className="actions">
          <div className="skel skel-button" />
          <div className="skel skel-button" />
        </div>
      </div>
    </main>
  );
}
