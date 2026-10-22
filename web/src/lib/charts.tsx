/** Small dependency-free inline-SVG charts. Colours come from the app's CSS variables only. */
const PALETTE = ["var(--accent)", "var(--ok)", "var(--warn)", "var(--danger)", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#9ca3af"];
const fmtDefault = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

export function BarChart({ data, format = fmtDefault, height }: { data: { label: string; value: number; color?: string }[]; format?: (n: number) => string; height?: number }) {
  const rowH = 26, labelW = 110, W = 420, h = height ?? data.length * rowH + 8;
  const max = Math.max(1, ...data.map(d => d.value));
  const summary = data.map(d => `${d.label} ${format(d.value)}`).join(", ");
  if (!data.length) return <div className="muted small">No data yet.</div>;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={summary} style={{ width: "100%", height: "auto", display: "block" }}>
      {data.map((d, i) => {
        const y = i * rowH + 4, w = Math.max(2, (d.value / max) * (W - labelW - 56));
        return (
          <g key={d.label}>
            <text x={labelW - 8} y={y + 15} textAnchor="end" fontSize="11.5" fill="var(--text)">{d.label.length > 16 ? d.label.slice(0, 15) + "…" : d.label}</text>
            <rect x={labelW} y={y + 3} width={w} height={rowH - 10} rx="4" fill={d.color ?? "var(--accent)"} />
            <text x={labelW + w + 6} y={y + 15} fontSize="11.5" fill="var(--muted)">{format(d.value)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function ColumnChart({ series, categories, format = fmtDefault }: { series: { label: string; values: number[]; color?: string }[]; categories: string[]; format?: (n: number) => string }) {
  const W = 480, H = 190, top = 14, bottom = 28, left = 8;
  const max = Math.max(1, ...series.flatMap(s => s.values));
  const n = categories.length, groupW = (W - left * 2) / Math.max(1, n), barW = Math.max(4, (groupW - 10) / Math.max(1, series.length));
  const plotH = H - top - bottom;
  const summary = series.map(s => `${s.label}: ${s.values.map((v, i) => `${categories[i]} ${format(v)}`).join(", ")}`).join("; ");
  if (!n) return <div className="muted small">No data yet.</div>;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} style={{ width: "100%", height: "auto", display: "block" }}>
        <line x1={left} x2={W - left} y1={top + plotH} y2={top + plotH} stroke="var(--line)" />
        {categories.map((c, i) => (
          <g key={c}>
            {series.map((s, j) => {
              const v = s.values[i] ?? 0, bh = (v / max) * plotH, x = left + i * groupW + 5 + j * barW, y = top + plotH - bh;
              return (
                <g key={s.label}>
                  <rect x={x} y={y} width={barW - 2} height={bh} rx="3" fill={s.color ?? PALETTE[j % PALETTE.length]} />
                  {v > 0 && <text x={x + (barW - 2) / 2} y={y - 3} textAnchor="middle" fontSize="11" fill="var(--muted)">{format(v)}</text>}
                </g>
              );
            })}
            <text x={left + i * groupW + groupW / 2} y={H - 8} textAnchor="middle" fontSize="11.5" fill="var(--muted)">{c}</text>
          </g>
        ))}
      </svg>
      {series.length > 1 && (
        <div className="row small" style={{ gap: 12, marginTop: 4 }}>
          {series.map((s, j) => <span key={s.label} className="row" style={{ gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: s.color ?? PALETTE[j % PALETTE.length], display: "inline-block" }} />{s.label}</span>)}
        </div>
      )}
    </div>
  );
}

export function Funnel({ stages }: { stages: { label: string; count: number }[] }) {
  const W = 420, rowH = 34, h = stages.length * rowH + 4, labelW = 96;
  const first = Math.max(1, stages[0]?.count ?? 0);
  const summary = stages.map(s => `${s.label} ${s.count}`).join(" → ");
  if (!stages.length) return <div className="muted small">No data yet.</div>;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Funnel: ${summary}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {stages.map((s, i) => {
        const full = W - labelW - 60, w = Math.max(3, (s.count / first) * full), x = labelW + (full - w) / 2, y = i * rowH + 2;
        const prev = stages[i - 1]?.count ?? 0, pct = i > 0 && prev > 0 ? Math.round((s.count / prev) * 100) : null;
        return (
          <g key={s.label}>
            <text x={labelW - 8} y={y + 19} textAnchor="end" fontSize="11.5" fill="var(--text)">{s.label}</text>
            <rect x={x} y={y + 4} width={w} height={rowH - 12} rx="4" fill="var(--accent)" fillOpacity={1 - i * 0.1} />
            <text x={x + w / 2} y={y + 19} textAnchor="middle" fontSize="11.5" fontWeight="600" fill={w > 40 ? "#fff" : "var(--text)"}>{w > 40 ? s.count : ""}</text>
            {w <= 40 && <text x={x + w + 6} y={y + 19} fontSize="11.5" fill="var(--text)">{s.count}</text>}
            {pct != null && <text x={W - 4} y={y + 19} textAnchor="end" fontSize="11" fill="var(--muted)">{pct}%</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function Sparkline({ values, color = "var(--accent)" }: { values: number[]; color?: string }) {
  const W = 100, H = 28;
  if (!values.length) return null;
  const max = Math.max(1, ...values), step = values.length > 1 ? W / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${i * step},${H - 2 - (v / max) * (H - 4)}`).join(" ");
  return <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={values.join(", ")} width={W} height={H}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" /></svg>;
}

export function Donut({ parts, format = fmtDefault }: { parts: { label: string; value: number; color?: string }[]; format?: (n: number) => string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const R = 44, C = 2 * Math.PI * R;
  let acc = 0;
  const summary = parts.map(p => `${p.label} ${format(p.value)}`).join(", ");
  if (!total) return <div className="muted small">No data yet.</div>;
  return (
    <div className="row" style={{ gap: 14, alignItems: "center" }}>
      <svg viewBox="0 0 120 120" role="img" aria-label={summary} width={110} height={110}>
        {parts.filter(p => p.value > 0).map((p, i) => {
          const frac = p.value / total, dash = frac * C, offset = C - acc * C; acc += frac;
          return <circle key={p.label} cx="60" cy="60" r={R} fill="none" stroke={p.color ?? PALETTE[i % PALETTE.length]} strokeWidth="16" strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={offset} transform="rotate(-90 60 60)" />;
        })}
        <text x="60" y="65" textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--text)">{format(total)}</text>
      </svg>
      <ul className="list small" style={{ flex: 1, minWidth: 120 }}>
        {parts.filter(p => p.value > 0).map((p, i) => <li key={p.label} style={{ padding: "4px 0" }}><span className="row" style={{ gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: p.color ?? PALETTE[i % PALETTE.length], display: "inline-block" }} />{p.label}</span><span className="b">{format(p.value)}</span></li>)}
      </ul>
    </div>
  );
}
