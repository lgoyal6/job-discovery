import type { Category, Cycle, RawJob, SponsorshipStatus } from './types.js';
import type { SponsorshipPatterns } from './config.js';

const categories: Array<[Category, RegExp]> = [
  ['ML/AI', /\b(machine learning|ml engineer|artificial intelligence|ai engineer|computer vision|applied scientist|research engineer|deep learning|nlp)\b/i],
  ['Quant', /\b(quantitative (developer|research|trading)|quant (developer|researcher)|algorithmic trading)\b/i],
  ['GTM Eng', /\b(forward deployed|solutions? engineer|gtm engineer|sales engineer)\b/i],
  ['SWE', /\b(software|firmware|embedded|developer|frontend|front-end|backend|back-end|full[ -]?stack|mobile|ios|android|infrastructure|platform|cloud|systems?|security|devops|site reliability|sre|data engineer|developer tool)\b/i]
];

const nonTechnical = /\b(marketing|accounting|human resources|recruiter|sales intern|business development|communications|legal|finance intern|operations intern|product marketing)\b/i;
const hardwareOnly = /\b(hardware|mechanical|electrical|rf|analog|asic|semiconductor)\b/i;
const softwareSignal = /\b(software|firmware|programming|python|coding|embedded|algorithm)\b|c\+\+/i;

export function classifyCategory(title: string, description = ''): { category: Category; eligible: boolean; reason?: string } {
  const text = `${title} ${description}`;
  for (const [category, pattern] of categories) {
    if (pattern.test(text)) return { category, eligible: true };
  }
  if (nonTechnical.test(title) && !softwareSignal.test(description)) return { category: 'Other', eligible: false, reason: 'clearly_non_technical' };
  if (hardwareOnly.test(title) && !softwareSignal.test(text)) return { category: 'Other', eligible: false, reason: 'hardware_only' };
  if (hardwareOnly.test(title) && softwareSignal.test(text)) return { category: 'SWE', eligible: true };
  // Generic “engineering”, “technology”, and “all tracks” programs are not
  // enough evidence that a role belongs to one of the allowed technical tracks.
  return { category: 'Other', eligible: false, reason: 'no_technical_signal' };
}

export function classifyCycle(title: string, description = '', hint = ''): Cycle | null {
  const explicit = `${title} ${description}`;
  const classify = (text: string): Cycle | null => {
    if (/\b(fall|autumn)\s*(?:of\s*)?2026\b|\b2026\s*(fall|autumn)\b/i.test(text)) return 'Fall 2026';
    if (/\bwinter\s*(?:of\s*)?2027\b|\b2027\s*winter\b/i.test(text)) return 'Winter 2027';
    if (/\bspring\s*(?:of\s*)?2027\b|\b2027\s*spring\b/i.test(text)) return 'Spring 2027';
    if (/\b(summer|may|june|july|august)\s*(?:of\s*)?2027\b|\b2027\s*summer\b/i.test(text)) return 'Summer 2027';
    return null;
  };
  const explicitCycle = classify(explicit);
  if (explicitCycle) return explicitCycle;
  const hintedCycle = classify(hint);
  if (hintedCycle) return hintedCycle;
  const text = `${hint} ${explicit}`;
  if (/\b2027\b/i.test(text) && /\b(intern|co-?op|student)\b/i.test(text)) return 'Later compatible';
  if (/\b(2028|2029)\b/i.test(text) && /\b(intern|co-?op|student)\b/i.test(text)) return 'Later compatible';
  return null;
}

export function classifyGraduation(title: string, description = ''): { eligible: boolean; evidence: string } {
  const text = `${title} ${description}`;
  if (/\bnew grad(?:uate)?\b|university graduate/i.test(title)) {
    if (/graduat(?:e|ing|ion).{0,45}\b2027\b/i.test(text) && !/\b2028\b/i.test(text)) return { eligible: false, evidence: 'New-grad posting explicitly requires 2027 graduation.' };
    if (/graduat(?:e|ing|ion).{0,60}\b2028\b/i.test(text)) return { eligible: true, evidence: 'New-grad graduation window explicitly includes 2028.' };
    return { eligible: false, evidence: 'New-grad role lacks an explicit June 2028-compatible graduation window.' };
  }
  const exclusions = [
    /graduat(?:e|ing|ion).{0,50}(?:december\s+2026|may\s+2027|june\s+2027)(?!\s*(?:-|through|or)\s*2028)/i,
    /must graduate (?:in|by) 2027/i,
    /class of 2027 only/i
  ];
  if (exclusions.some(pattern => pattern.test(text))) return { eligible: false, evidence: 'Graduation requirement clearly excludes June 2028.' };
  return { eligible: true, evidence: 'No graduation restriction excluding June 2028 was found.' };
}

export function classifySponsorship(text: string, patterns: SponsorshipPatterns): { status: SponsorshipStatus; evidence: string } {
  for (const source of patterns.unsupported) {
    const match = text.match(new RegExp(source, 'i'));
    if (match) return { status: 'UNSUPPORTED', evidence: match[0] };
  }
  for (const source of patterns.supported) {
    const match = text.match(new RegExp(source, 'i'));
    if (match) return { status: 'SUPPORTED', evidence: match[0] };
  }
  return { status: 'UNKNOWN', evidence: 'The posting does not state a sponsorship or international-student policy.' };
}

const skillPatterns: Array<[string, RegExp]> = [
  ['Python', /\bpython\b/i], ['TypeScript', /\btypescript\b/i], ['JavaScript', /\bjavascript\b/i],
  ['Java', /\bjava\b/i], ['C++', /\bc\+\+\b/i], ['C', /\bc programming\b/i], ['SQL', /\bsql\b/i],
  ['PyTorch', /\bpytorch\b/i], ['React', /\breact(?:\.js)?\b/i], ['Next.js', /\bnext\.js\b/i],
  ['Docker', /\bdocker\b/i], ['AWS', /\baws\b|amazon web services/i], ['PostgreSQL', /\bpostgres(?:ql)?\b/i],
  ['FastAPI', /\bfastapi\b/i], ['OpenCV', /\bopencv\b/i], ['Kubernetes', /\bkubernetes\b/i]
];

export function extractSkills(text: string): string[] {
  return skillPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

const cyclePoints: Record<Cycle, number> = { 'Summer 2027': 50, 'Fall 2026': 40, 'Winter 2027': 35, 'Spring 2027': 30, 'Later compatible': 15 };
const categoryPoints: Record<Category, number> = { SWE: 30, 'ML/AI': 30, Quant: 20, 'GTM Eng': 15, Other: 10 };

export function scoreJob(job: Pick<RawJob, 'postedAt' | 'location'> & { cycle: Cycle; category: Category; sponsorshipStatus: SponsorshipStatus; skills: string[]; watchlistPriority: number }): number {
  let score = cyclePoints[job.cycle] + categoryPoints[job.category] + Math.min(15, job.skills.length * 3) + job.watchlistPriority;
  if (job.sponsorshipStatus === 'SUPPORTED') score += 15;
  if (job.sponsorshipStatus === 'UNKNOWN') score += 5;
  if (/san diego|california|remote|united states|usa/i.test(job.location ?? '')) score += 8;
  if (job.postedAt) {
    const ageDays = (Date.now() - Date.parse(job.postedAt)) / 86_400_000;
    if (ageDays <= 2) score += 10;
    else if (ageDays <= 7) score += 6;
    else if (ageDays <= 30) score += 2;
  }
  return score;
}
