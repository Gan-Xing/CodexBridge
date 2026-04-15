export function formatWeixinText(content) {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }
  const lines = normalized.split('\n').map((line) => rewriteHeading(line));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function splitWeixinText(content, maxLength = 4000) {
  const normalized = String(content ?? '').trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const units = normalized
    .split(/\n{2,}/u)
    .map((unit) => unit.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (unit.length <= maxLength) {
      current = unit;
      continue;
    }
    chunks.push(...splitOversizedUnit(unit, maxLength));
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function rewriteHeading(line) {
  if (/^#\s+/.test(line)) {
    return `【${line.replace(/^#\s+/u, '').trim()}】`;
  }
  if (/^##+\s+/.test(line)) {
    return `**${line.replace(/^##+\s+/u, '').trim()}**`;
  }
  return line;
}

function splitOversizedUnit(unit, maxLength) {
  const lines = unit.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (line.length <= maxLength) {
      current = line;
      continue;
    }
    chunks.push(...splitLongLine(line, maxLength));
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function splitLongLine(line, maxLength) {
  const chunks = [];
  let offset = 0;
  while (offset < line.length) {
    chunks.push(line.slice(offset, offset + maxLength));
    offset += maxLength;
  }
  return chunks;
}
