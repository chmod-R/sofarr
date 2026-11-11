import type { DownloadInfo, Title } from "../api/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-17" → "Nov 17" (adds the year when it isn't this year). */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const base = `${MONTHS[m - 1]} ${d}`;
  return y === new Date().getFullYear() ? base : `${base}, ${y}`;
}

/** *arr "[d.]hh:mm:ss" → "2h 5m" / "12m" / "<1m". */
export function timeLeft(t: string | null): string | null {
  if (!t) return null;
  const [days, rest] = t.includes(".") ? t.split(".", 2) : ["0", t];
  const [h = 0, m = 0, s = 0] = (rest ?? "").split(":").map(Number);
  const total = Number(days) * 24 * 60 + h * 60 + m;
  if (total <= 0) return s > 0 ? "<1m" : null;
  const hh = Math.floor(total / 60);
  return hh ? `${hh}h ${total % 60}m` : `${total}m`;
}

function speed(bps: number | undefined): string | null {
  if (!bps || bps < 1024) return null;
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} MB/s` : `${Math.round(bps / 1000)} KB/s`;
}

export function downloadLabel(d: DownloadInfo): string {
  switch (d.state) {
    case "importPending":
    case "importing":
      return "Importing…";
    case "waitingForPlex":
      return "Almost ready";
    case "downloading": {
      const left = timeLeft(d.timeLeft);
      return [`${Math.round(d.percent)}%`, left && `${left} left`, speed(d.speedBps)].filter(Boolean).join(" · ");
    }
    case "stalled":
      return `${Math.round(d.percent)}% · waiting for peers`;
    case "queued":
      return `${Math.round(d.percent)}% · queued`;
    case "paused":
      return `${Math.round(d.percent)}% · paused`;
    default:
      return d.percent > 0 ? `${Math.round(d.percent)}%` : "Queued";
  }
}

export function statusLabel(t: Pick<Title, "status" | "availableFrom" | "download">): string {
  switch (t.status) {
    case "owned":
      return "Ready to watch";
    case "downloading":
      return t.download ? downloadLabel(t.download) : "Downloading";
    case "requested":
      return t.availableFrom ? `Requested · coming ${shortDate(t.availableFrom)}` : "Requested · searching";
    case "upcoming":
      return t.availableFrom ? `Coming ${shortDate(t.availableFrom)}` : "Not out yet";
    case "available":
      return "Get it";
  }
}

export function runtime(min: number | null): string | null {
  if (!min) return null;
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}
