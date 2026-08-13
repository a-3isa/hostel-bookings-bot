// Streamed while a page's queries run. Every page here is force-dynamic and
// talks to a database in another region, so the first paint is worth designing.
export default function Loading() {
  return (
    <>
      <div className="kpis">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton" style={{ height: 84 }} />
        ))}
      </div>
      <div className="skeleton" style={{ height: 320 }} />
    </>
  );
}
