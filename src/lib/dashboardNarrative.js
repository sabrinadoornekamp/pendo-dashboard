import { parseInsightBodyToBlocks } from './insightMarkdown';

function trunc(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function norm(s) {
  return String(s ?? '').toLowerCase();
}

/**
 * @param {{ title: string, body: string }[]} sections
 * @param {...string} keywords
 */
export function pickSectionByKeywords(sections, ...keywords) {
  if (!sections?.length) return null;
  return (
    sections.find((sec) =>
      keywords.some((k) => norm(sec.title).includes(norm(k)))
    ) || null
  );
}

export function getAnalysisSummaryText(sections) {
  const s =
    pickSectionByKeywords(sections, 'korte samenvatting', 'samenvatting') ||
    sections[0];
  if (!s?.body) return '';
  const blocks = parseInsightBodyToBlocks(s.body);
  const paras = blocks.filter((b) => b.type === 'p').map((b) => b.text);
  const joined = paras.join(' ').trim();
  return joined || trunc(s.body, 520);
}

/**
 * @param {{ title: string, body: string }[]} sections
 * @param {{ fromLabel: string, toLabel: string } | null | undefined} topDrop
 */
export function extractHeroOpportunity(sections, topDrop) {
  const rec = pickSectionByKeywords(
    sections,
    'aanbevelingen om de flow',
    'aanbevelingen'
  );
  let title = '';
  let body = '';

  if (rec?.body) {
    const blocks = parseInsightBodyToBlocks(rec.body);
    const ol = blocks.find((b) => b.type === 'ol');
    if (ol?.items?.length) {
      title = trunc(ol.items[0], 140);
      body = ol.items.slice(1, 4).join('\n\n').trim() || ol.items[0];
    } else {
      const ul = blocks.find((b) => b.type === 'ul');
      if (ul?.items?.length) {
        title = trunc(ul.items[0], 140);
        body = ul.items.slice(1, 4).join('\n\n').trim();
      } else {
        const paras = blocks.filter((b) => b.type === 'p');
        if (paras[0]) {
          title = trunc(paras[0].text, 140);
          body = paras
            .slice(1, 4)
            .map((b) => b.text)
            .join('\n\n')
            .trim();
        }
      }
    }
  }

  if (!title && topDrop) {
    title = `Verbeter de overgang na “${trunc(topDrop.fromLabel, 42)}”`;
    body = `Hier is de sterkste relatieve daling in de funnel (naar “${trunc(topDrop.toLabel, 42)}”). Richt onderzoek en designhier op zichtbaarheid van de vervolgstap, verwachting en vertrouwen.`;
  }

  const start = pickSectionByKeywords(
    sections,
    'waar het team',
    'starten'
  );
  let impact = '';
  if (start?.body) {
    const blocks = parseInsightBodyToBlocks(start.body);
    const ul = blocks.find((b) => b.type === 'ul');
    if (ul?.items?.[0]) {
      impact = ul.items[0];
    } else {
      const p = blocks.find((b) => b.type === 'p');
      if (p) impact = trunc(p.text, 260);
    }
  }

  if (!title) return null;
  return {
    title,
    body: body.trim(),
    impact: impact.trim() || null,
  };
}

export function countSubstantiveSections(sections) {
  if (!sections?.length) return 0;
  return sections.filter((s) => {
    const t = norm(s.title);
    return t && !t.includes('toelichting');
  }).length;
}
