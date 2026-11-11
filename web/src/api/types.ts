// Mirrors server/src responses. Keep in sync when the API changes.

export type MediaType = "movie" | "tv";
export type TitleStatus = "owned" | "downloading" | "requested" | "upcoming" | "available";
export type SeasonStatus = "owned" | "partial" | "downloading" | "requested" | "upcoming" | "available";

export interface DownloadInfo {
  percent: number;
  timeLeft: string | null;
  state: string;
  items: number;
  seasons?: number[];
  speedBps?: number;
}

export interface Title {
  id: string;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  rating: number | null;
  status: TitleStatus;
  plexKey?: string;
  download?: DownloadInfo;
  availableFrom?: string | null;
  /** In the library and recent: just added, or a show with new episodes. */
  fresh?: "new" | "new-episodes";
}

export interface ResumeInfo {
  plexKey: string;
  label: string | null;
  percent: number;
}

export type RowItem = Title & {
  resume?: ResumeInfo;
  /** My Library only: "YYYY-MM-DD" release / premiere date. */
  released?: string | null;
};

export interface Row {
  id: string;
  title: string;
  /** The order is a ranking: cards are numbered. */
  ranked?: boolean;
  items: RowItem[];
}

export interface Home {
  rows: Row[];
  warnings: string[];
}

export interface SeasonInfo {
  number: number;
  tmdbNumber: number | null;
  name: string;
  episodeCount: number;
  airDate: string | null;
  aired: boolean | null;
  inPlex: number;
  watched: number;
  status: SeasonStatus;
}

export interface TitleDetail extends Title {
  tagline: string | null;
  genres: string[];
  runtime: number | null;
  trailerYoutubeKey: string | null;
  /** Title logo artwork, shown in place of the plain-text title. */
  logo: string | null;
  /** Age rating in the configured region, e.g. "PG-13". */
  certification: string | null;
  cast: string[];
  seasons?: SeasonInfo[];
  seasonNumbering?: "identity" | "offset" | "sonarr-only" | "tmdb";
}

export type EpisodeStatus = "owned" | "downloading" | "requested" | "upcoming" | "available";

export interface EpisodeInfo {
  number: number;
  title: string;
  airDate: string | null;
  overview: string;
  still: string | null;
  /** Minutes. */
  runtime: number | null;
  status: EpisodeStatus;
  plexKey?: string;
  watched?: boolean;
  progress?: { percent: number; remainingMs: number };
}

export interface SeasonEpisodes {
  season: number;
  numbering: "sonarr" | "tmdb";
  episodes: EpisodeInfo[];
}

export interface Profile {
  uuid: string;
  title: string;
  thumb: string | null;
  isAdmin: boolean;
  isProtected: boolean;
}

export interface Session {
  signedIn: true;
  account: { username: string; thumb: string | null };
  profile: Profile | null;
}

export interface Pin {
  code: string;
  linkUrl: string;
  qrUrl: string | null;
  expiresAt: string;
}

export type PinPoll =
  | { status: "waiting" }
  | { status: "signed_in" }
  | { status: "expired" }
  | { status: "denied"; reason: string }
  | { status: "no_pending_login" };

export interface PlayCapabilities {
  nativeHls: boolean;
  hevc: boolean;
  hevcMain10: boolean;
  eac3: boolean;
  ac3: boolean;
}

export interface PlaySession {
  id: string;
  src: string;
  ratingKey: string;
  title: string;
  subtitle: string | null;
  /** Synopsis of what's playing. */
  summary: string | null;
  durationMs: number;
  startMs: number;
  decision: { video: string; audio: string };
  tracks: {
    partId: number | null;
    audio: Array<{ id: number; label: string; language: string | null; selected: boolean }>;
    subtitles: Array<{ id: number; label: string; language: string | null; selected: boolean; forced: boolean; kind: "text" | "image" }>;
  };
  next: { plexKey: string; title: string; subtitle: string | null; thumb: string | null } | null;
}

export interface RequestResult {
  result: "added" | "searching" | "already_have";
  title?: TitleDetail;
}
