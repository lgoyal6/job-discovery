import { readFile } from 'node:fs/promises';

export interface WatchlistCompany { parent: string; aliases: string[]; section: string; priority: number }

export async function parseWatchlist(path: string): Promise<WatchlistCompany[]> {
  return parseWatchlistMarkdown(await readFile(path, 'utf8'));
}

export function parseWatchlistMarkdown(markdown: string): WatchlistCompany[] {
  const companies: WatchlistCompany[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const header = line.match(/^##\s+(.+)/);
    if (header?.[1]) { section = header[1].trim(); continue; }
    if (!section || section === 'Opening-watch protocol' || !line.trim() || line.startsWith('#') || line.startsWith('-')) continue;
    const cleaned = line.replace(/\.$/, '');
    for (const group of cleaned.split(/,\s*/)) {
      const aliases = group.split('/').map(value => value.trim()).filter(Boolean);
      const parent = aliases[0];
      if (!parent) continue;
      const priority = /Tier A|San Diego/i.test(section) ? 10 : /AI labs|Quantitative|Product software/i.test(section) ? 7 : 4;
      companies.push({ parent, aliases, section, priority });
    }
  }
  const unique = new Map<string, WatchlistCompany>();
  for (const company of companies) {
    const prior = unique.get(company.parent.toLowerCase());
    if (!prior || company.priority > prior.priority) unique.set(company.parent.toLowerCase(), company);
  }
  return [...unique.values()];
}

export function rotateWatchlist(companies: WatchlistCompany[], runSlot: number, count: number): WatchlistCompany[] {
  if (companies.length <= count) return companies;
  const priority = companies.filter(company => company.priority >= 10);
  const others = companies.filter(company => company.priority < 10);
  const priorityCount = Math.min(Math.ceil(count / 2), priority.length);
  const rotatingCount = count - priorityCount;
  const rotate = <T>(items: T[], take: number, slot: number): T[] => Array.from({ length: take }, (_, index) => items[(slot * take + index) % items.length]).filter((item): item is T => item !== undefined);
  return [...rotate(priority, priorityCount, runSlot), ...rotate(others, rotatingCount, runSlot)];
}
