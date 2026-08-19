export type SponsorshipStatus = 'SUPPORTED' | 'UNKNOWN' | 'UNSUPPORTED';
export type Category = 'SWE' | 'ML/AI' | 'Quant' | 'GTM Eng' | 'Other' | 'IB' | 'PE/VC' | 'AM/WM' | 'Corp Fin';
export type Cycle = 'Summer 2027' | 'Fall 2026' | 'Winter 2027' | 'Spring 2027' | 'Later compatible';
export type SourceStatus = 'SUCCESS' | 'DEGRADED' | 'FAILED' | 'SKIPPED';

export interface RawJob {
  sourceName: string;
  sourceJobId?: string;
  title: string;
  company: string;
  location?: string;
  postedAt?: string;
  description?: string;
  employmentType?: string;
  sourceUrl: string;
  directApplyUrl?: string;
  scrapedAt: string;
  cycleHint?: string;
  status?: 'OPEN' | 'CLOSED';
  raw?: unknown;
}

export interface ClassifiedJob extends RawJob {
  canonicalKey: string;
  canonicalUrl: string;
  normalizedCompany: string;
  normalizedTitle: string;
  normalizedLocation: string;
  category: Category;
  cycle: Cycle;
  sponsorshipStatus: SponsorshipStatus;
  sponsorshipEvidence: string;
  graduationEligible: boolean;
  graduationEvidence: string;
  requiredSkills: string[];
  score: number;
  rejectionReason?: string;
  summary: string;
}

export interface SourceResult {
  sourceName: string;
  status: SourceStatus;
  jobs: RawJob[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
  costUnits: number;
  metrics?: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly name: string;
  fetch(): Promise<SourceResult>;
}

export interface DigestJob extends ClassifiedJob {
  id?: string;
  firstSeenAt?: string;
  meaningfulStateChange?: boolean;
}

export interface PipelineReport {
  runId: string;
  dryRun: boolean;
  batchKey: string | null;
  shouldSend: boolean;
  emailTo: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  jobs: DigestJob[];
  sourceRuns: SourceResult[];
  counts: {
    raw: number;
    accepted: number;
    rejected: number;
    deduplicated: number;
    appliedExcluded: number;
  };
  rejectionReasons: Record<string, number>;
  degradedSources: string[];
  // True only when the run mirrored postings into the ledger, which requires
  // NOTION_MIRROR_ENABLED. Discovery itself still only reads Notion.
  notionModified: boolean;
}
