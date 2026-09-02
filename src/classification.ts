import type { Category, Cycle, RawJob, SponsorshipStatus } from './types.js';
import type { Profile, SponsorshipPatterns } from './config.js';

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
  // programmer: every game studio titles software roles that way, and the
  // Greenhouse board is fetched without descriptions, so the title is the only
  // evidence there is. "Gameplay Programmer Intern" at Epic Games read as
  // no_technical_signal, and with it every Programmer role at Riot, Bungie, EA
  // and Rockstar.
  ['SWE', /\b(software|firmware|embedded|developer|programmer|programming|frontend|front-end|backend|back-end|full[ -]?stack|mobile|ios|android|infrastructure|platform|cloud|systems?|security|cyber ?security|infosec|devops|site reliability|sre|data engineer|developer tool|distributed systems?|compilers?|kernel|databases?|observability|reliability engineer(?:ing)?|analytics engineer|data analytics|data analyst|(?:qa|test|quality|automation|release|build) engineer|network(?:ing)? (?:engineer|operations|infrastructure|systems?)|computer networks?|information technology|it (?:support|infrastructure|operations|systems?|services|security|help ?desk))\b/i]
];

// Plurals: "Internships" ends the match on a word character, so \b fails and
// "Quant Analyst Internships 2027" read as not a student role at all. The same
// held for "Interns" and "Students". "Internal" and "International" still do
// not match, because \b fails on the letter after "intern".
export const STUDENT_ROLE = /\b(interns?(?:hips?)?|co-?ops?|students?|early career|new grad(?:uate)?s?|university graduates?|campus hires?)\b/i;

// A new-grad requisition names no season, so it can never carry a target cycle
// the way an internship does. Requiring one rejected every full-time entry role
// as "outside_target_cycles", which is why 3 of 2,939 stored titles said new
// grad. The cycle gate exists to keep Summer 2026 internships out of a Summer
// 2027 digest; a role with no season is not that.
export const NEW_GRAD_ROLE = /\b(new grad(?:uate)?s?|university graduates?|campus hires?|graduate (?:programme?|scheme))\b/i;

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
// One such word, not two. American Express titles every campus role "Campus
// Undergraduate Summer Internship Program - 2027 Software Engineer", which puts
// two of them between the season and the year, matched no season, and left ten
// 2027 internships scoring 68 as "Later compatible" instead of 103.
const SEP = String.raw`[\s\-–—:,]*`;
const TERM = String.raw`${SEP}(?:(?:quarter|term|semester|session|co-?op|internship|intern|program)${SEP}){0,3}(?:of\s*)?`;
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
  // A hint describes the list a posting was found on, not the requisition, and
  // the same reasoning that puts the title above the description puts it above
  // the hint. "AI Engineer - Internship - Summer 2026" came off a Summer 2027
  // list and was mailed as Summer 2027: a cycle that had not started, for a role
  // whose own cycle was already over. Summer pairs only with 2027 here, so the
  // title matched no season and the hint was left to answer for it.
  //
  // Only a contradiction disqualifies the hint. A title naming no year still
  // needs it, and "Intern - 2026-2027" spans both so the hint still applies.
  const titleYears = new Set(`${title} ${description}`.match(/\b20\d\d\b/g) ?? []);
  const hintYears = hint.match(/\b20\d\d\b/g) ?? [];
  const hintContradicted = titleYears.size > 0 && hintYears.length > 0 && !hintYears.some(year => titleYears.has(year));
  if (!hintContradicted) {
    const hintedCycle = classify(hint);
    if (hintedCycle) return hintedCycle;
  }
  // A contradicted hint is kept out of the fallback too, or its year would
  // qualify the posting as "Later compatible" by the back door.
  const text = hintContradicted ? `${title} ${description}` : `${hint} ${title} ${description}`;
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

// A Canadian city with a bare province code names no country, so "Toronto, ON"
// read as eligible and Barclays' Toronto banking programme reached a digest
// whose whole premise is a US work authorisation. None of these codes is also a
// US state code, which is what makes them safe to read as foreign where a city
// name would not be: "Ontario, CA" is in California and "London, KY" is in
// Kentucky.
const CANADIAN_PROVINCE = /,\s*(?:ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b/;

/**
 * Cities with no US namesake worth protecting, which the country list misses.
 *
 * A general city list is unsafe and stays unwritten: "Ontario, CA" is in
 * California and "London, KY" is in Kentucky. These are safe for two reasons.
 * They are tested after the US check, so any posting that names a US state
 * alongside the city has already been claimed. And none of them is a US city
 * that appears in postings, which is what separates Abu Dhabi from Berlin.
 *
 * Written for the rows that actually reached the digest: Vatic's "Abu Dhabi",
 * Maven's "London" and Ontario Teachers' Toronto programme, each of which
 * named no country and so counted as eligible for a digest whose whole premise
 * is a US work authorisation.
 */
/**
 * Two-letter country codes, which postings write exactly where a US state code
 * goes: Magna files an internship as "Nanchang, Jiangxi, CN".
 *
 * Every code that is also a US state code is deliberately absent, which is most
 * of the interesting ones: IN is Indiana, DE is Delaware, CO is Colorado, IL is
 * Illinois, AR is Arkansas, ID is Idaho, LA is Louisiana. The US test runs
 * first regardless, so this only ever sees strings that named no state.
 */
const NON_US_COUNTRY_CODE = /,\s*(?:CN|NL|FR|JP|BR|MX|CH|SE|DK|FI|PL|CZ|AT|BE|IE|SG|HK|TW|KR|TH|VN|PH|MY|AE|ZA|EG|NG|KE|TR|RU|UA|GR|PT|ES|IT|GB|AU|NZ|KZ|QA|KW|BH|OM|JO|LB|PK|BD|LK|NP|KH|MM|GH|DZ|CI|SN|UG|ZM|ZW|BW|RS|HR|SI|SK|BG|RO|LT|LV|EE|IS|LU|CY|UZ|PE)\b/i;

const NON_US_CITY = /\b(?:abu dhabi|dubai|madrid|frankfurt|geneva|geneve|genève|amsterdam|eindhoven|rotterdam|utrecht|nanchang|san luis potosi|monterrey|guadalajara|toronto|vancouver|montreal|montréal|calgary|ottawa|edmonton|winnipeg|london|tel aviv|riyadh|doha|kuala lumpur|jakarta|bangkok|taipei|seoul|tokyo|osaka|mumbai|bengaluru|bangalore|hyderabad|gurgaon|gurugram|noida|shanghai|shenzhen|beijing|guangzhou|são paulo|sao paulo|rio de janeiro|buenos aires|bogotá|bogota|johannesburg|nairobi|lagos|casablanca|edinburgh|glasgow|belfast|barcelona|lisbon|brussels|copenhagen|stockholm|helsinki|oslo|warsaw|prague|budapest|bucharest|istanbul|zurich|zürich|geneva|düsseldorf|dusseldorf|sydney|brisbane|auckland)\b/i;

/**
 * The location field, and where it says nothing, the posting's own URL.
 *
 * `context` is only read when the location names no country at all, which is
 * the one case that used to end in an unconditional yes. Two rows in the last
 * digest were exactly that: Ontario Teachers' Toronto internship and Tikehau's
 * London one both arrived as "Unspecified", and both name their city in the
 * employer's own apply path. A URL is punctuation between words rather than
 * spaces, so it is flattened before matching or `\b` never fires inside
 * "..._private_equity_london_october_2026".
 */
export function classifyLocation(location: string, context = ''): { eligible: boolean; evidence: string } {
  // Before the US test, not after: the finance lists write "Toronto, ON, CA",
  // and CA is a US state code, so the US test claimed it for California.
  const province = location.match(CANADIAN_PROVINCE);
  if (province) return { eligible: false, evidence: `Location is a Canadian province: ${province[0].replace(/^,\s*/, '')}.` };
  if (US_LOCATION.test(location)) return { eligible: true, evidence: 'Location names a US state, territory, or the United States.' };
  const match = location.match(NON_US_LOCATION) ?? location.match(NON_US_COUNTRY_CODE) ?? location.match(NON_US_CITY);
  if (match) return { eligible: false, evidence: `Location is outside the United States: ${match[0]}.` };
  const flattened = context.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const fromContext = flattened.match(NON_US_LOCATION) ?? flattened.match(NON_US_CITY);
  if (fromContext && !US_LOCATION.test(flattened)) return { eligible: false, evidence: `Location is unstated and the posting is outside the United States: ${fromContext[0]}.` };
  return { eligible: true, evidence: 'Location names no country, so it is not treated as foreign.' };
}

// Laksh can finish at any UC San Diego quarter boundary from June 2027 onward,
// so the graduation date on a page is a choice rather than a fact to work
// around. Two dates are worth claiming and the posting decides which:
//   June 2027 for full-time new-grad roles, the only date that opens the class
//     of 2027, and the only one that closes a Summer 2027 internship.
//   June 2028 for internships, which makes Summer 2027 the rising-senior summer
//     the whole cycle recruits for.
// December 2027 exists as a deliberate exception, handled by the caller, not
// here: it only pays at an employer that hires on a rolling start date rather
// than a cohort. March 2028 was considered and dropped, since it carries
// December's off-cycle cost without December's speed.
export type ClaimedGraduation = 'JUNE_2027' | 'DECEMBER_2027' | 'JUNE_2028';

// Laksh finishes at a UC San Diego quarter boundary, and there are three:
// June 2027, December 2027, June 2028. A posting that names one of them is not
// a judgement call, it is an instruction, so read it rather than infer.
//
// A window entirely before June 2027 is the case this missed. "New Grad
// (December 2026)" states a class he cannot join, and the 2027 test did not
// match it, so it fell through to the no-window default and claimed June 2027
// on 14 roles that had already closed to him. An earlier class is a rejection,
// not an absent window.
const DECEMBER_2027_WINDOW = /\b(december|dec\.?|fall|winter)\s*'?\s*2027\b/i;
const PRE_2027_WINDOW = /\b(december|dec\.?|fall|winter|spring|may|summer)\s*'?\s*2026\b|\b2026\s+grad(?:uate)?s?\b/i;

export function classifyGraduation(title: string, description = ''): { eligible: boolean; evidence: string; claim: ClaimedGraduation } {
  const text = `${title} ${description}`;
  if (/\bnew grad(?:uate)?\b|university graduate/i.test(title)) {
    if (PRE_2027_WINDOW.test(text) && !/\b2027\b|\b2028\b/i.test(text)) {
      return { eligible: false, evidence: 'New-grad posting names a 2026 graduating class, which is earlier than any date Laksh can finish.', claim: 'JUNE_2027' };
    }
    if (DECEMBER_2027_WINDOW.test(text) && !/\b2028\b/i.test(text)) {
      return { eligible: true, evidence: 'New-grad posting names a December 2027 graduation, so claim December 2027.', claim: 'DECEMBER_2027' };
    }
    if (/graduat(?:e|ing|ion).{0,45}\b2027\b/i.test(text) && !/\b2028\b/i.test(text)) return { eligible: true, evidence: 'New-grad posting requires 2027 graduation, so claim June 2027.', claim: 'JUNE_2027' };
    if (/graduat(?:e|ing|ion).{0,60}\b2028\b/i.test(text)) return { eligible: true, evidence: 'New-grad graduation window explicitly includes 2028.', claim: 'JUNE_2028' };
    return { eligible: true, evidence: 'New-grad role states no graduation window, so claim June 2027 to reach the earlier class.', claim: 'JUNE_2027' };
  }
  const exclusions = [
    /graduat(?:e|ing|ion).{0,50}(?:december\s+2026|may\s+2027|june\s+2027)(?!\s*(?:-|through|or)\s*2028)/i,
    /must graduate (?:in|by) 2027/i,
    /class of 2027 only/i
  ];
  if (exclusions.some(pattern => pattern.test(text))) return { eligible: true, evidence: 'Graduation requirement excludes June 2028, so claim June 2027.', claim: 'JUNE_2027' };
  return { eligible: true, evidence: 'No graduation restriction excluding June 2028 was found.', claim: 'JUNE_2028' };
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

/**
 * The finance digest's rules, consulted only under JOB_PROFILE=finance.
 *
 * The reader asked for one thing: roles that invest money or research what to
 * invest in. Investment and asset management, wealth management, private and
 * public markets, equity research, investment banking and M&A, plus plain
 * finance internships. Explicitly not commercial banking, and not the tail the
 * finance lists are actually made of: accounting, audit, tax, insurance,
 * actuarial, underwriting, risk, compliance and back-office operations.
 *
 * Order is the whole design here, because these families share vocabulary.
 *
 * Commercial banking and back-office operations are tested FIRST, before any
 * front-office pattern: "Summer 2027 Commercial Banking Intern" contains
 * "banking intern" and "Summer Analyst - Corporate Functions, Operations"
 * contains "summer analyst", so testing them later means the front office
 * claims both. The commercial pattern requires the two words adjacent, which is
 * what keeps JPMorgan's "Commercial & Investment Bank - Markets Equity
 * Research" (an equity research internship, and one of the best rows the lists
 * carry) out of it.
 *
 * Accounting, insurance and risk are tested AFTER the front office, because
 * there the overlap runs the other way: "Investment Banking, Tax Advisory" has
 * to survive the tax reject, "Credit and Insurance, Private Credit Strategies
 * Summer Analyst" has to survive the insurance one, and "Equity Capital Markets
 * Underwriting" has to survive underwriting. Testing the specific patterns
 * first and the loose ones last is what gives every one of those the right
 * answer.
 *
 * Corporate finance is tested last of all, which is also what lets it end in a
 * bare "finance": "Intern, Finance (Summer 2027)" has to match, and anything
 * narrower is defeated by the word order.
 */
const commercialBanking = /\b(?:commercial|corporate|retail|consumer|community|business|middle[ -]market|personal)\s+bank(?:ing|er)?s?\b|\bbank\s+teller\b|\b(?:teller|branch manager|branch operations|deposit operations|commercial credit|commercial lending|small business lending|loan officer|loan operations|mortgage|treasury management|cash management)\b/i;
// Back office, and named as specifically as the titles allow. A bare
// "operations" is deliberate: "Investment Operations", "Trade Support" and
// "Fund Administration" are the roles this reader called shit, and every one of
// them is titled after the function it supports rather than the function it is.
const backOffice = /\b(operations?|middle office|back office|trade support|settlements?|reconciliation|fund admin\w*|client servic\w+|customer servic\w+|call cent\w+|servicing|help ?desk)\b/i;
// Seniority, which only became a problem when this digest started reading whole
// employer boards instead of student lists. BlackRock's board is 250 postings
// of which two are internships, so without this the email led with "ETF Product
// Platform - BlackRock Global Markets, Vice President". The student-title and
// graduation filters cannot do this job: they are deliberately off for this
// profile, because an internship names a cycle and a new-grad analyst role
// names nothing at all.
//
// "principal" is absent on purpose: "principal investments" is private equity,
// not a job level, and so is "staff": a Staff Accountant is the entry-level
// accounting title, whatever the word means in engineering. "lead" cannot match "leadership" and "manager" cannot match
// "management", so the leadership development programmes and the
// portfolio-management internships both survive.
const seniorRole = /\b(vice president|vp|svp|evp|avp|managing director|executive director|director|head of|chief|ceo|cfo|cio|coo|cto|senior|sr\.?|lead|manager|supervisor|executive|partner)\b/i;
const accountingAuditTax = /\b(accounting|accountant|accounts (?:payable|receivable)|audit(?:or|ing)?|tax|bookkeep\w*|payroll|controller|cpa|billing|collections)\b/i;
// Insurance and risk share a reject because they share a reason: neither is an
// investing role, and both arrive in volume from lists whose other half is
// accounting.
// Another discipline entirely, which the trading firms' boards are mostly made
// of: Chicago Trading Company's "Software Engineering Internship" and IMC's
// "Machine Learning Research Intern" both reached this digest, because their
// descriptions say "proprietary trading" and the description fallback below
// took that as a finance signal. A quant title still survives: the front office
// is tested before this, and "Quantitative Developer" matches there.
// Disciplines that are not finance however often their descriptions say
// "financial". The IT and legal entries were added after Neuralink's "IT
// Systems Administrator Intern" and Lambda's "Legal Intern" reached the finance
// digest: neither title named a finance track, so both fell through to the
// description, where one keyword was enough. Network and support are spelled
// out rather than left bare because DRW files a "Leadership Rotation Network
// Intern" that belongs in this digest.
const otherDiscipline = /\b(software|firmware|hardware|mechanical|electrical|engineer(?:ing)?|developer|programmer|data scien\w+|machine learning|artificial intelligence|infrastructure|devops|cyber ?security|information technology|systems? administrator|sysadmin|help ?desk|desktop support|technical support|network (?:engineer|administrator|operations)|legal|attorney|counsel|marketing|human resources|recruit\w+|paralegal|clinical|nurse|physician|pharmacist|veterinar\w+|teacher)\b/i;
/** The half of otherDiscipline that even a quant title cannot talk its way past. */
const buildsSoftware = /\b(software|developer|programmer|firmware|devops|systems? engineer|engineering manager)\b/i;
const insuranceRiskCompliance = /\b(insurance|underwrit\w+|actuar\w+|claims?|reinsurance|risk manage\w+|enterprise risk|operational risk|credit risk|compliance|regulatory|aml|kyc|fraud|internal control)\b/i;

// Ordered specific desk first, catch-all last. The IB pattern ends in a bare
// "summer analyst", which is how a bank titles its whole analyst class, so
// tested first it claimed every buy-side row too: "2027 Investment Management
// Summer Analyst" and "Private Credit Strategies Summer Analyst" both read as
// investment banking. The desks that name themselves are tested ahead of it.
const frontOffice: Array<[Category, RegExp]> = [
  // Private and public markets, which is how this reader named the two halves
  // of investing. "Private investments", "public credit" and "growth equity"
  // are the words the postings themselves use.
  ['PE/VC', /\b(private equity|venture capital|growth equity|buyout|private credit|private debt|private markets?|private investments?|private capital|principal investment|direct investment|real assets|infrastructure investments?|secondaries|co-?investments?)\b/i],
  // Quant is the one category both profiles share, and the technical digest
  // already earns its keep on these titles.
  // Developer and engineer are deliberately absent, where the technical digest's
  // copy of this pattern keeps them: a Quantitative Developer at a trading firm
  // writes software, and belongs in that digest rather than this one. Researcher,
  // trader, analyst, risk and strategist are the roles that decide or study what
  // to trade. A title left behind here falls to the other-discipline reject on
  // the word "developer", which is exactly where it should land.
  // Up to two words may sit between the discipline and the role, because desks
  // name themselves in the middle of the title: Susquehanna files a
  // "Quant Systematic Trading Analyst" and requiring adjacency dropped it.
  ['Quant', /\b(quantitative|quant)\s+(?:\w+\s+){0,2}(research(?:er)?|trading|trader|analyst|risk|strategist|portfolio)\b|\balgorithmic trading\b|\btrading intern(?:ship)?\b/i],
  ['AM/WM', /\b(asset management|wealth management|investment management|investment analy(?:st|sis|tics)|portfolio management|portfolio manager|portfolio analy(?:st|sis)|equity analyst|research analyst|research associate|investment research|credit research|securities research|fundamental (?:equit\w+|research)|public markets?|public investments?|public equit\w+|public credit|private client|private bank(?:ing)?|financial advis\w+|financial planner|financial planning(?!\s*(?:&|and)\s*analysis)|fund management|multi-?asset|hedge fund|endowment|pension investments?|investment strateg\w+|buy[ -]side)\b/i],
  ['IB', /\b(investment bank(?:ing|er)?|bank(?:ing)? (?:analyst|associate|intern(?:ship)?|summer)|capital markets|m&a|mergers (?:&|and) acquisitions|summer analyst|sales (?:&|and) trading|equity research|equity capital markets|debt capital markets|leveraged finance|restructuring|global markets|coverage banking|sell[ -]side)\b/i]
];
// Plain finance internships, which the reader asked to keep even where the
// employer is not an investment firm. They ride in their own digest section, so
// a Textron finance intern can never dilute the investing rows it is listed
// beneath.
const corporateFinance: Array<[Category, RegExp]> = [
  ['Corp Fin', /\b(finance|financial|corporate development|fp&a|treasury|investor relations|valuation|budget\w*|forecast\w*)\b/i]
];

/** Categories that answer "this role invests money or researches what to invest in". */
export const INVESTING_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['IB', 'PE/VC', 'AM/WM', 'Quant']);

/**
 * Asset management, except when it is inventory.
 *
 * "IT asset management" is tracking laptops and licences, and it shares every
 * word with the discipline that manages money. Lucid Motors' "IT Asset
 * Management Intern" matched the investing pattern on its title, and
 * Neuralink's systems administrator matched on a duty to "assist with hardware
 * asset management". Both reached a digest whose whole subject is investing.
 *
 * Removing the phrase rather than adding a negative lookbehind keeps it working
 * in the description too, where the qualifier and the phrase are often several
 * words apart.
 */
const TECHNOLOGY_ASSET_MANAGEMENT = /\b(?:it|i\.t\.|hardware|software|digital|data|media|records?|fixed|physical|equipment|inventory)[\s-]+asset[\s-]+management\b/gi;
function withoutInventoryLanguage(text: string): string {
  return text.replace(TECHNOLOGY_ASSET_MANAGEMENT, ' ');
}

export function classifyFinanceCategory(rawTitle: string, _rawDescription = ''): { category: Category; eligible: boolean; reason?: string } {
  const title = withoutInventoryLanguage(rawTitle);
  if (seniorRole.test(title)) return { category: 'Other', eligible: false, reason: 'not_early_career' };
  if (commercialBanking.test(title)) return { category: 'Other', eligible: false, reason: 'commercial_banking' };
  if (backOffice.test(title)) return { category: 'Other', eligible: false, reason: 'back_office_operations' };
  for (const [category, pattern] of frontOffice) {
    if (!pattern.test(title)) continue;
    // Schonfeld's "Software Engineer - Fundamental Equities" is a software role
    // that happens to sit on an equities desk, and the desk is the half this
    // matched on. Only the quant patterns, which name their discipline
    // themselves, may keep a title another discipline also claims; everything
    // else falls through to the reject on the next line.
    //
    // That exemption does not extend to writing software. "Quantitative
    // Research Software Developer" is a software role on a research desk, the
    // same shape as the Schonfeld title and the same answer: it belongs in the
    // technical digest, which has its own copy of these quant patterns and
    // keeps developer and engineer in them on purpose.
    if (otherDiscipline.test(title) && (category !== 'Quant' || buildsSoftware.test(title))) break;
    return { category, eligible: true };
  }
  if (otherDiscipline.test(title)) return { category: 'Other', eligible: false, reason: 'not_a_finance_discipline' };
  if (accountingAuditTax.test(title)) return { category: 'Other', eligible: false, reason: 'accounting_audit_or_tax' };
  if (insuranceRiskCompliance.test(title)) return { category: 'Other', eligible: false, reason: 'insurance_risk_or_compliance' };
  for (const [category, pattern] of corporateFinance) if (pattern.test(title)) return { category, eligible: true };
  // The title decides, and the description gets no vote.
  //
  // There used to be a fallback here: a title that named no track of its own
  // was allowed to match the front-office patterns against its description.
  // It was a reasonable idea and it did not survive measurement. At an
  // investment firm every description says markets, so the fallback classified
  // whatever the employer happened to be rather than what the job was, and it
  // admitted Neuralink's "IT Systems Administrator Intern", Lambda's "Legal
  // Intern", DRW's "FPGA Intern" as investment banking and its "AI/ML Research
  // Intern" as private equity.
  //
  // What it bought was nothing. Across 45 finance-profile boards, 80 postings
  // qualified on their title and exactly one qualified only through its
  // description: StepStone's "2027 AI Initiatives PhD Internship", which is an
  // AI role at a private equity firm and belongs in the other digest anyway.
  // The same count over a live digest was 135 on the title against one.
  //
  // A thin title that genuinely names a finance track is still caught, because
  // the patterns above already read every word of it.
  return { category: 'Other', eligible: false, reason: 'no_finance_signal' };
}

/**
 * What each digest requires of a posting before it can be mailed.
 *
 * The finance profile takes internships and full-time roles as they come, so it
 * cannot require a cycle: an internship names one and a new-grad analyst role
 * names nothing, and requiring it would drop every row on the new-grad list. The
 * graduation filter is off because `classifyGraduation` encodes one candidate's
 * June 2028 window and this digest is not theirs. The US gate and the whole
 * sponsorship treatment are shared, which is the half that already answers
 * "usable by a non-citizen in the US".
 */
/**
 * Whether a role is one a student or a new graduate can actually take.
 *
 * The finance profile cannot use `STUDENT_ROLE` for this. That filter is off
 * here on purpose, because an internship names a cycle and a full-time new-grad
 * analyst role names nothing, and requiring a student title would drop every
 * one of the latter. Seniority covers the other end, rejecting a Vice President
 * or a Director outright. Between the two sat the roles this reader kept being
 * shown: Vanguard's "Certified Financial Advisor" and Morgan Stanley's "Private
 * Wealth Management Investment Consultant" name no seniority and no cycle, and
 * both want years behind them.
 *
 * So the evidence has to be positive. A title that names an internship, a
 * graduate programme, a campus or summer analyst class, or an entry-level role
 * qualifies; so does an analyst or associate title carrying its class year,
 * which is how campus hiring writes itself. Failing that, a stated experience
 * requirement of two years or more disqualifies, and a body that names an
 * internship or a graduate programme still qualifies.
 *
 * A row with neither signal is dropped. That is deliberately strict and it does
 * cost some real entry-level rows, an "Equity Research Associate" whose posting
 * never says so among them, because a LinkedIn card carries no description at
 * the point this runs.
 */
const EARLY_CAREER = /\b(interns?(?:hips?)?|co-?ops?|students?|campus|undergraduate|new grad(?:uate)?s?|graduate (?:program|programme|scheme|analyst|rotational)|entry[ -]level|summer (?:analyst|associate|intern)|off[ -]cycle|rotational (?:program|programme)|analyst (?:program|programme|class)|trainee|apprentice\w*|early career|placement year|freshman|sophomore|junior year)\b/i;
// A class year beside an analyst or associate title, which is how campus and
// new-grad hiring names itself when it uses no other word for it: "2027 Harvest
// Analyst", "Investment Banking Analyst, Full-Time 2027".
const CLASS_YEAR_ROLE = /\b20[2-9]\d\b[^.]{0,45}\b(?:analyst|associate)\b|\b(?:analyst|associate)\b[^.]{0,45}\b20[2-9]\d\b/i;
// Two years or more, stated as a requirement. One year is common on entry-level
// postings that count internships towards it, so the floor starts at two.
const EXPERIENCE_REQUIRED = /\b(?:[2-9]|[1-9]\d)\s*(?:\+|-\s*\d+)?\s*years?(?:\s+of)?\s+(?:\w+\s+){0,3}experience\b/i;

export function classifyEarlyCareer(title: string, description = ''): { eligible: boolean; evidence: string } {
  if (EARLY_CAREER.test(title)) return { eligible: true, evidence: 'The title names an internship, a graduate programme or an entry-level role.' };
  if (CLASS_YEAR_ROLE.test(title)) return { eligible: true, evidence: 'The title pairs an analyst or associate role with its class year.' };
  const years = EXPERIENCE_REQUIRED.exec(`${title}\n${description}`);
  if (years) return { eligible: false, evidence: `The posting asks for ${years[0].trim()}.` };
  if (EARLY_CAREER.test(description)) return { eligible: true, evidence: 'The posting describes an internship or a graduate programme.' };
  return { eligible: false, evidence: 'Neither the title nor the posting names an internship, a graduate programme or an entry-level role.' };
}

export interface RolePolicy {
  classifyRole: (title: string, description?: string) => { category: Category; eligible: boolean; reason?: string };
  requireStudentRole: boolean;
  requireCycle: boolean;
  requireGraduationFit: boolean;
  /** Whether a role must show positive evidence of being open to a student or a new graduate. */
  requireEarlyCareer: boolean;
}

export const rolePolicies: Record<Profile, RolePolicy> = {
  // The technical digest already requires a student title and a target cycle,
  // which is a stricter test than this one and makes it redundant there.
  technical: { classifyRole: classifyCategory, requireStudentRole: true, requireCycle: true, requireGraduationFit: true, requireEarlyCareer: false },
  finance: { classifyRole: classifyFinanceCategory, requireStudentRole: false, requireCycle: false, requireGraduationFit: false, requireEarlyCareer: true }
};

const cyclePoints: Record<Cycle, number> = { 'Summer 2027': 50, 'Fall 2026': 40, 'Winter 2027': 35, 'Spring 2027': 30, 'Later compatible': 15 };
const categoryPoints: Record<Category, number> = { SWE: 30, 'ML/AI': 30, Quant: 20, 'GTM Eng': 15, Other: 10, IB: 30, 'PE/VC': 30, 'AM/WM': 28, 'Corp Fin': 20 };

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
