import type { Category, Cycle, RawJob, SponsorshipStatus } from './types.js';
import type { SponsorshipPatterns } from './config.js';

// A category pattern is tested before nonTechnical, so anything matched here
// bypasses that filter. That is why the additions below name a discipline or a
// role noun and never a bare "AI" or "ML": "AI Safety Governance Product
// Manager Intern" and "Global Merchant & Network Services" are the titles a
// looser pattern lets through, and neither is an engineering role.
const categories: Array<[Category, RegExp]> = [
  ['ML/AI', /\b(machine learning|ml engineer|artificial intelligence|ai engineer|computer vision|applied scientist|research engineer|deep learning|nlp|llms?|large language models?|generative a\.?i|gen ?ai|ml ?ops|foundation models?|reinforcement learning|rlhf|diffusion models?|prompt engineer|ai infrastructure|ai platform|ai research|applied ai|ai ?\/ ?ml|ml ?\/ ?ai|data scien(?:ces?|tists?))\b/i],
  // Quant titles rarely say "developer": "Quantitative Risk Intern" and
  // "Quantitative Trader" are the roles worth catching here.
  ['Quant', /\b(quantitative|quant)\s+(developer|research(?:er)?|trading|trader|analyst|risk|strategist|engineer)\b|\balgorithmic trading\b|\btrading intern(?:ship)?\b/i],
  ['GTM Eng', /\b(forward deployed|solutions? engineer|gtm engineer|sales engineer)\b/i],
  // cyber ?security, not security: \bsecurity\b cannot match inside
  // "Cybersecurity", so that title read as non-technical and was dropped.
  ['SWE', /\b(software|firmware|embedded|developer|frontend|front-end|backend|back-end|full[ -]?stack|mobile|ios|android|infrastructure|platform|cloud|systems?|security|cyber ?security|infosec|devops|site reliability|sre|data engineer|developer tool|distributed systems?|compilers?|kernel|databases?|observability|reliability engineer(?:ing)?|analytics engineer|data analytics|data analyst|(?:qa|test|quality|automation|release|build) engineer|network(?:ing)? (?:engineer|operations|infrastructure|systems?)|computer networks?|information technology|it (?:support|infrastructure|operations|systems?|services|security|help ?desk))\b/i]
];

const nonTechnical = /\b(marketing|accounting|human resources|recruiter|sales intern|business development|communications|legal|finance intern|operations intern|product marketing|governance,? risk,? and compliance|\bgrc\b|compliance|paralegal|talent acquisition|people operations)\b/i;

// Titles that carry no track information on their own, where reading the
// description is the only way to categorise. Everything else is judged on its
// title alone.
const genericTechTitle = /\b(technical|technology|engineering|engineer|developer|intern(?:ship)?|university|early career|new grad)\b/i;
const hardwareOnly = /\b(hardware|mechanical|electrical|rf|analog|asic|semiconductor)\b/i;
const softwareSignal = /\b(software|firmware|programming|python|coding|embedded|algorithm)\b|c\+\+/i;

export function classifyCategory(title: string, description = ''): { category: Category; eligible: boolean; reason?: string } {
  const text = `${title} ${description}`;
  // Title first. Matching the description put a "Governance, Risk, and
  // Compliance Intern" in SWE, because every job description at a software
  // company says software, security and systems somewhere in the body.
  for (const [category, pattern] of categories) {
    if (pattern.test(title)) return { category, eligible: true };
  }
  if (nonTechnical.test(title)) return { category: 'Other', eligible: false, reason: 'clearly_non_technical' };
  if (hardwareOnly.test(title) && !softwareSignal.test(text)) return { category: 'Other', eligible: false, reason: 'hardware_only' };
  if (hardwareOnly.test(title) && softwareSignal.test(text)) return { category: 'SWE', eligible: true };
  // Only a title with no track of its own ("Engineering Intern", "Technical
  // Intern") earns a look at the description.
  if (genericTechTitle.test(title)) {
    for (const [category, pattern] of categories) {
      if (pattern.test(description)) return { category, eligible: true };
    }
  }
  // Generic “engineering”, “technology”, and “all tracks” programs are not
  // enough evidence that a role belongs to one of the allowed technical tracks.
  return { category: 'Other', eligible: false, reason: 'no_technical_signal' };
}

// Employers name the same cycle as "Winter 2027", "Winter Quarter 2027" and
// "Winter Term 2027". Requiring the year to follow the season immediately meant
// "Quantitative Trading Intern - Winter Quarter 2027" matched no season at all,
// so it fell through to the source list's own Summer hint and was mailed as a
// Summer role.
// The separator is not always a space. "Software Developer Summer Internship -
// 2027" puts a dash between the term word and the year, which matched no season
// and left the posting with no cycle at all.
const SEP = String.raw`[\s\-–—:,]*`;
const TERM = String.raw`${SEP}(?:quarter|term|semester|session|co-?op|internship|intern|program)?${SEP}(?:of\s*)?`;
const season = (names: string, year: string) => new RegExp(String.raw`\b(?:${names})${TERM}${year}\b|\b${year}\s*(?:${names})\b`, 'i');
const seasons: Array<[Cycle, RegExp]> = [
  ['Fall 2026', season('fall|autumn', '2026')],
  ['Winter 2027', season('winter', '2027')],
  ['Spring 2027', season('spring', '2027')],
  ['Summer 2027', season('summer|may|june|july|august', '2027')]
];

export function classifyCycle(title: string, description = '', hint = ''): Cycle | null {
  const classify = (text: string): Cycle | null => seasons.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  // Title before description: a Winter posting whose body advertises the whole
  // summer program must stay Winter, and the title is the part that is about
  // this requisition.
  const explicitCycle = classify(title) ?? classify(description);
  if (explicitCycle) return explicitCycle;
  const hintedCycle = classify(hint);
  if (hintedCycle) return hintedCycle;
  const text = `${hint} ${title} ${description}`;
  // \bintern\b does not match "Internship": the word boundary fails on the "s"
  // that follows. "Quant Analyst Internships 2027" names no season, so this
  // fallback was its only route to a cycle and it was dropped as off-cycle.
  const INTERN = /\b(?:interns?(?:hips?)?|co-?ops?|students?)\b/i;
  if (/\b2027\b/i.test(text) && INTERN.test(text)) return 'Later compatible';
  if (/\b(2028|2029)\b/i.test(text) && INTERN.test(text)) return 'Later compatible';
  return null;
}

// Location only ever moved the score, so an internship in Hong Kong or
// Amsterdam was a perfectly valid digest row. It is not a role an F-1 student
// in San Diego can take, and every one of them costs a slot under the cap.
const US_STATES = 'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|puerto rico';
const US_LOCATION = new RegExp(String.raw`\b(?:united states|usa|u\.s\.a?\.?|${US_STATES}|remote|nationwide|multiple us)\b|,\s*(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b`, 'i');
// Countries and territories, not cities: "Ontario, CA" is in California and
// "London, KY" is in Kentucky, so a city list would throw away US roles. A
// posting that names no country at all is kept rather than guessed at.
// Georgia is deliberately absent: as a location string it is the US state far
// more often than the country.
const NON_US_LOCATION = /\b(?:afghanistan|albania|algeria|andorra|angola|argentina|armenia|australia|austria|azerbaijan|bahamas|bahrain|bangladesh|barbados|belarus|belgium|belize|benin|bermuda|bhutan|bolivia|bosnia|botswana|brazil|brunei|bulgaria|burkina faso|burundi|cambodia|cameroon|canada|cape verde|cayman islands|chad|chile|china|colombia|congo|costa rica|croatia|cuba|cyprus|czechia|czech republic|denmark|dominican republic|ecuador|egypt|el salvador|estonia|eswatini|ethiopia|fiji|finland|france|gabon|gambia|germany|ghana|gibraltar|greece|greenland|guatemala|guinea|guyana|haiti|honduras|hong kong|hungary|iceland|india|indonesia|iran|iraq|ireland|isle of man|israel|italy|ivory coast|jamaica|japan|jordan|kazakhstan|kenya|kosovo|kuwait|kyrgyzstan|laos|latvia|lebanon|lesotho|liberia|libya|liechtenstein|lithuania|luxembourg|macau|madagascar|malawi|malaysia|maldives|mali|malta|mauritania|mauritius|mexico|moldova|monaco|mongolia|montenegro|morocco|mozambique|myanmar|namibia|nepal|netherlands|new zealand|nicaragua|niger|nigeria|north macedonia|norway|oman|pakistan|palestine|panama|papua new guinea|paraguay|peru|philippines|poland|portugal|qatar|romania|russia|rwanda|saudi arabia|senegal|serbia|singapore|slovakia|slovenia|somalia|south africa|south korea|korea|spain|sri lanka|sudan|suriname|sweden|switzerland|syria|taiwan|tajikistan|tanzania|thailand|togo|trinidad|tunisia|turkey|türkiye|turkmenistan|uganda|ukraine|united arab emirates|uae|united kingdom|uk|england|scotland|wales|northern ireland|great britain|uruguay|uzbekistan|venezuela|vietnam|yemen|zambia|zimbabwe)\b/i;

export function classifyLocation(location: string): { eligible: boolean; evidence: string } {
  if (US_LOCATION.test(location)) return { eligible: true, evidence: 'Location names a US state, territory, or the United States.' };
  const match = location.match(NON_US_LOCATION);
  if (match) return { eligible: false, evidence: `Location is outside the United States: ${match[0]}.` };
  return { eligible: true, evidence: 'Location names no country, so it is not treated as foreign.' };
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

// The community lists state this in the title, and far more reliably than any
// prose pattern: 🛂 "Does NOT offer Sponsorship", 🇺🇸 "Requires U.S. Citizenship".
// Both disqualify an F-1 candidate outright, so they outrank the pattern files -
// which otherwise abstain to UNKNOWN on these rows, since community entries
// carry no description to match against.
const NO_SPONSORSHIP_MARKER = /\u{1F6C2}/u;
const US_CITIZENSHIP_MARKER = /\u{1F1FA}\u{1F1F8}/u;

export function classifySponsorship(text: string, patterns: SponsorshipPatterns): { status: SponsorshipStatus; evidence: string } {
  if (NO_SPONSORSHIP_MARKER.test(text)) return { status: 'UNSUPPORTED', evidence: 'Listed with 🛂, does not offer sponsorship.' };
  if (US_CITIZENSHIP_MARKER.test(text)) return { status: 'UNSUPPORTED', evidence: 'Listed with 🇺🇸, requires U.S. citizenship.' };
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
