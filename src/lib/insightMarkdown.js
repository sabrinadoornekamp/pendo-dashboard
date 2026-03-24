/**
 * Splits eenvoudige markdown met ##-koppen in secties (Claude pijnpunten).
 */
export function splitMarkdownH2Sections(markdown) {
  const text = (markdown || '').trim();
  if (!text) return [];

  const lines = text.split('\n');
  const sections = [];
  let currentTitle = null;
  let currentLines = [];

  const pushCurrent = () => {
    const body = currentLines.join('\n').trim();
    if (currentTitle != null) {
      sections.push({ title: currentTitle, body });
    } else if (body) {
      sections.push({ title: 'Toelichting', body });
    }
    currentTitle = null;
    currentLines = [];
  };

  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      pushCurrent();
      currentTitle = m[1].trim();
    } else {
      currentLines.push(line);
    }
  }
  pushCurrent();
  return sections;
}

/**
 * @returns {Array<{ type: 'p'|'ul'|'ol', text?: string, items?: string[] }>}
 */
export function parseInsightBodyToBlocks(body) {
  const lines = (body || '').split('\n');
  const blocks = [];
  let para = [];
  /** @type {{ type: 'ul'|'ol', items: string[] } | null} */
  let list = null;

  const flushPara = () => {
    const t = para.join(' ').replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ type: 'p', text: t });
    para = [];
  };

  const startList = (ordered) => {
    flushPara();
    const want = ordered ? 'ol' : 'ul';
    if (list && list.type === want) return;
    list = { type: want, items: [] };
    blocks.push(list);
  };

  for (const line of lines) {
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    const dash = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ordered) {
      startList(true);
      list.items.push(ordered[1].trim());
    } else if (dash) {
      startList(false);
      list.items.push(dash[1].trim());
    } else if (!line.trim()) {
      flushPara();
      list = null;
    } else {
      if (list) list = null;
      para.push(line.trim());
    }
  }
  flushPara();
  return blocks;
}

export function insightSectionSlug(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56);
}
