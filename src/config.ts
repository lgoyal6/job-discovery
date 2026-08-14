import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..');

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://job_pipeline:job_pipeline@localhost:5432/job_discovery'),
  // No defaults: these identify a specific mailbox and Notion workspace, so a
  // baked-in fallback is both a leak and a silent-wrong-value hazard, the stale
  // default here pointed at a different database than production for weeks.
  // Missing values must fail loudly at startup instead.
  EMAIL_TO: z.string().email(),
  NOTION_TOKEN: z.string().optional(),
  NOTION_DATABASE_ID: z.string().min(1),
  NOTION_DATA_SOURCE_ID: z.string().min(1),
  APIFY_TOKEN: z.string().optional(),
  APIFY_LINKEDIN_ACTOR: z.string().default('curious_coder/linkedin-jobs-scraper'),
  APIFY_INDEED_ACTOR: z.string().default('schnellscrapers/indeed-jobs-scraper'),
  APIFY_MONSTER_ACTOR: z.string().default('axlymxp/monster-scraper'),
  APIFY_MAX_RESULTS_PER_SOURCE: z.coerce.number().int().positive().max(1000).default(100),
  APIFY_LINKEDIN_MAX_RESULTS: z.coerce.number().int().min(10).max(1000).default(35),
  APIFY_INDEED_MAX_RESULTS: z.coerce.number().int().min(1).max(1000).default(15),
  APIFY_MONSTER_MAX_RESULTS: z.coerce.number().int().min(1).max(500).default(35),
  APIFY_MIN_INTERVAL_HOURS: z.coerce.number().int().min(2).max(168).default(24),
  APIFY_MAX_ACTOR_RUNS_PER_PIPELINE: z.coerce.number().int().min(0).max(3).default(3),
  APIFY_MAX_COMPUTE_UNITS_PER_RUN: z.coerce.number().min(0).max(10).default(1),
  APIFY_MAX_TOTAL_CHARGE_USD: z.coerce.number().min(0).max(10).default(0.5),
  COMMUNITY_MAX_RESULTS_PER_SOURCE: z.coerce.number().int().positive().max(2000).default(300),
  // Applies to boards fetched page by page (Lever, SmartRecruiters, Workday),
  // where it genuinely limits how many requests are made.
  ATS_MAX_RESULTS_PER_SOURCE: z.coerce.number().int().positive().max(1000).default(250),
  // Applies to boards returned whole in one response (Greenhouse, Ashby), where
  // a low cap only discards postings that were already downloaded.
  ATS_MAX_RESULTS_PER_BOARD: z.coerce.number().int().positive().max(20000).default(5000),
  // OpenAI's Ashby board answers with 12 MB and takes 11 to 15 seconds on its
  // own, so a 20 second budget expired under the concurrency of a full run and
  // the board was reported as degraded on every pass.
  SOURCE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  SOURCE_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  WATCHLIST_COMPANIES_PER_RUN: z.coerce.number().int().positive().max(500).default(30),
  // A batch claimed but never confirmed sent blocks its digest forever, because
  // only ABANDONED rows are re-claimable. Treat a claim older than this as dead
  // so a failed send self-heals instead of silencing the digest indefinitely.
  EMAIL_BATCH_STALE_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  // Gmail clips messages over ~102 KB and a role renders at roughly 640 bytes,
  // so anything past ~158 roles is invisible in an email whose jobs are all
  // marked sent regardless. Cap well under that; the remainder is not dropped,
  // it simply arrives on the following ticks.
  DIGEST_MAX_ROLES: z.coerce.number().int().min(1).max(150).default(60),
  // LinkedIn's public guest endpoint. Twice a day by default: coverage against
  // a 24-hour window is nearly identical to running every tick, and a fixed
  // egress address makes restraint the difference between working and being
  // blocked for every source.
  LINKEDIN_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  LINKEDIN_MIN_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  // Relevance decays sharply with depth (measured 5, 4, 2, 1, 1 intern-titled
  // per page), so deep paging buys noise and request budget, not coverage.
  LINKEDIN_PAGES_PER_QUERY: z.coerce.number().int().min(1).max(40).default(3),
  LINKEDIN_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(30000).default(1500),
  LINKEDIN_RECENCY_SECONDS: z.coerce.number().int().min(3600).max(2592000).default(86400),
  // Fetch each candidate posting to recover sponsorship wording the source
  // listings omit. Verdicts persist, so this costs requests only while a
  // backlog drains; in steady state it touches the few roles that are new.
  ENRICHMENT_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  ENRICHMENT_MAX_JOBS: z.coerce.number().int().min(0).max(400).default(90),
  ENRICHMENT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(6),
  ENRICHMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  // Watch program and early-careers pages for change. Daily by default: these
  // announce a cycle weeks ahead, so the signal is measured in days, and a
  // marketing page does not need polling every two hours.
  PAGEWATCH_ENABLED: z.enum(['true', 'false']).default('true').transform(v => v === 'true'),
  PAGEWATCH_MIN_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PAGEWATCH_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  PAGEWATCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  // Board discovery probes public ATS endpoints; keep it polite since it runs
  // against a few hundred companies at once.
  DISCOVERY_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(10),
  SEND_EMAIL_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  APIFY_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  PAID_SOURCES_ENABLED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  REZZY_API_KEY: z.string().optional(),
  REZZY_PROFILE_ID: z.string().optional(),
  REZZY_WEBHOOK_SECRET: z.string().optional(),
  REZZY_API_BASE_URL: z.string().url().default('https://api.rezzy.dev/v1')
});

export type AppConfig = z.infer<typeof envSchema>;
export const config: AppConfig = envSchema.parse(process.env);

export interface SponsorshipPatterns { supported: string[]; unsupported: string[]; ambiguous: string[] }

export async function loadSponsorshipPatterns(): Promise<SponsorshipPatterns> {
  const raw = await readFile(resolve(projectRoot, 'config/sponsorship-patterns.yaml'), 'utf8');
  return z.object({ supported: z.array(z.string()), unsupported: z.array(z.string()), ambiguous: z.array(z.string()) }).parse(YAML.parse(raw));
}

export async function loadCompanyAliases(): Promise<Record<string, string[]>> {
  return JSON.parse(await readFile(resolve(projectRoot, 'config/company-aliases.json'), 'utf8')) as Record<string, string[]>;
}
