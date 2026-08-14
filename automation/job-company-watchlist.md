# Job Company Watchlist

This registry defines the minimum U.S. employer universe for `daily-job-lead-tracker`. It is a floor, not a whitelist. Search subsidiaries, acquired brands, and alternate ATS names. On every run, rotate through at least one cohort from each section and inspect all companies with a known opening date in the next 45 days.

## Tier A: Global technology and platforms

Alphabet/Google, Meta, Amazon/AWS, Apple, Microsoft/GitHub/LinkedIn, Netflix, NVIDIA, Salesforce, Adobe, Oracle, IBM/Red Hat/HashiCorp, Cisco, Intel, AMD, Qualcomm, Samsung, Sony, Dell, HP, HPE, Broadcom/VMware, SAP, ServiceNow, Workday, Zoom, Dropbox, Box, Atlassian, Autodesk, Palantir.

## Tier A: Consumer, marketplace, and social

Uber, Lyft, Airbnb, DoorDash, Instacart, TikTok/ByteDance, Snap, Pinterest, Reddit, Discord, Roblox, Spotify, Match Group/Hinge, Bumble, Yelp, Duolingo, Expedia, Booking Holdings, Zillow, Opendoor, eBay, Etsy, Wayfair, Chewy, StubHub, SeatGeek, DraftKings, FanDuel.

## Tier A/B: Fintech, payments, and financial software

Stripe, Block/Square/Cash App, PayPal/Venmo, Plaid, Ramp, Brex, Rippling, Chime, SoFi, Robinhood, Coinbase, Gemini, Affirm, Klarna, Adyen, Visa, Mastercard, American Express, Discover, Fiserv, Fidelity National Information Services, Jack Henry, Marqeta, Mercury, Modern Treasury, Carta, Navan, BILL, Toast, Flexport.

## Banks, asset managers, and insurance

JPMorgan Chase, Bank of America, Citi, Wells Fargo, Goldman Sachs, Morgan Stanley, Capital One, BlackRock, Fidelity, Charles Schwab, State Street, BNY, U.S. Bank, PNC, Truist, KeyBank, Citizens, Huntington, Fifth Third, Regions, M&T Bank, Ally, Synchrony, Navy Federal, T. Rowe Price, Vanguard, Franklin Templeton, Northern Trust, UBS, Deutsche Bank, Barclays, HSBC, RBC, TD, Scotiabank, Manulife, Prudential, MetLife, New York Life, Liberty Mutual, Travelers, Progressive, Allstate, State Farm, USAA, Nationwide, The Hartford.

## AI labs, compute, cloud, and data infrastructure

OpenAI, Anthropic, xAI, Scale AI, Perplexity, Glean, Sierra, Harvey, Anysphere/Cursor, Cognition, Reflection AI, Safe Superintelligence, Thinking Machines Lab, Physical Intelligence, Together AI, Fireworks AI, Modal, Baseten, Replicate, Hugging Face, Runway, ElevenLabs, Deepgram, Groq, Cerebras, SambaNova, CoreWeave, Crusoe, Lambda, GMI Cloud, Nebius, Vultr, DigitalOcean, Cloudflare, Databricks, Snowflake, Datadog, MongoDB, Confluent, Elastic, Cockroach Labs, ClickHouse, Grafana Labs, Temporal, Sentry, Vercel, Supabase, Pinecone, Weights & Biases, ScaleFlux.

## Product software and developer tools

Figma, Notion, Airtable, Asana, Monday.com, Smartsheet, Linear, Retool, Canva, Miro, Webflow, GitLab, Twilio, Okta, Cloudflare, Docker, Postman, Snyk, Wiz, CrowdStrike, Palo Alto Networks, Zscaler, SentinelOne, 1Password, Vanta, Verkada, Samsara, Anduril, Shield AI, Applied Intuition, Waymo, Aurora, Nuro, Zoox, Tesla, Rivian, Lucid, Cruise.

## Quantitative trading and market infrastructure

Jane Street, Hudson River Trading, Citadel, Citadel Securities, Jump Trading, Two Sigma, D. E. Shaw, IMC, Optiver, SIG, Five Rings, Point72, PDT Partners, Virtu, Akuna, Tower Research, DRW, Chicago Trading Company, Old Mission, Wolverine Trading, Belvedere Trading, Radix Trading, Aquatic Capital, Headlands Technologies, XTX Markets, Millennium, Schonfeld, AQR, Nasdaq, Cboe, CME Group, Intercontinental Exchange, Interactive Brokers.

## Gaming, entertainment, and media technology

Electronic Arts/Respawn Entertainment, Activision Blizzard/King, Riot Games, Epic Games, Valve, Take-Two/Rockstar/2K, Unity, Roblox, Discord, Twitch, Netflix Games, Sony Interactive Entertainment/PlayStation, Nintendo, Warner Bros. Games, Bungie, Niantic, Scopely, Zynga, DreamWorks, Pixar, Disney, NBCUniversal, Paramount, Warner Bros. Discovery, Spotify.

## Enterprise, industrial, aerospace, and healthcare technology

GE Aerospace, RTX, Boeing, Lockheed Martin, Northrop Grumman, General Dynamics, L3Harris, SpaceX, Blue Origin, Rocket Lab, Relativity Space, Viasat, Honeywell, Siemens, Bosch, Schneider Electric, Caterpillar, John Deere, Cummins, Ford, General Motors, Toyota, Medtronic, Stryker, Abbott, Johnson & Johnson, Pfizer, Eli Lilly, Moderna, Illumina, Dexcom, ResMed, Epic Systems, Veeva, Datavant, Tempus, Flatiron Health.

## San Diego and Southern California emphasis

Qualcomm, Intuit, ServiceNow, Apple San Diego, Google San Diego, Amazon San Diego, Microsoft San Diego, Sony Interactive Entertainment, Viasat, Illumina, Dexcom, ResMed, General Atomics, Northrop Grumman, Shield AI, ASML/Cymer, LPL Financial, Sempra, Teradata, Cubic, Brain Corp, ClickUp, Tandem Diabetes Care, Petco, Flock Freight, Drata, Platform Science, TuSimple successor companies, GMI Cloud, Riot Games Los Angeles, Snap Los Angeles, TikTok/ByteDance Los Angeles, SpaceX/Hawthorne, Anduril/Costa Mesa, Rivian/Irvine, Blizzard/Irvine, EA/Respawn, Disney Streaming, StubHub Los Angeles.

## Opening-watch protocol

For every company, classify the daily state as `Open`, `Announced`, `Expected`, `No signal`, or `Closed` for each target cycle. `Announced` means a first-party page gives an opening month/date but the requisition is not yet live. `Expected` means prior-year cadence or a standing university program exists without a current date; do not treat this as a confirmed opening.

High-signal opening events must appear in the run output even when no Notion job row is created. Current seed signals as of 2026-07-31:

- Stripe: first-party posting says 2027 jobs open in September; verify whether this includes U.S. internships before creating a row.
- KeyBank: standing Digital Product and Technology & Operations programs; first-party page says recruiting for next-year placement begins in spring. Watch Workday for a 2027 technical requisition, including San Diego-compatible locations.
- Uber: 2027 Uber Career Prep SWE requisition was posted July 20, 2026 and is now removed; watch for the general 2027 SWE internship rather than re-adding the removed cohort-specific role.
- BlackRock: 2027 Technology applications opened in July 2026; program row is already collected.
- Hinge means Match Group's dating product unless the posting clearly refers to another company named Hinge.
- Respawn means Respawn Entertainment under Electronic Arts; search both employer names and EA ATS listings.
