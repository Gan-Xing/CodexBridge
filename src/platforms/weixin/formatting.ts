const FENCE_RE = /^```/u;
const WEIXIN_DELIVERY_LIMIT_BYTES = 2048;

export function formatWeixinText(content: unknown) {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }
  const lines = normalized.split('\n').map((line) => rewriteHeading(line));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function splitWeixinText(content: unknown, maxLength = 4000) {
  const normalized = String(content ?? '').trim();
  if (!normalized) {
    return [];
  }
  const deliveryLimit = Math.min(Number(maxLength) || 4000, WEIXIN_DELIVERY_LIMIT_BYTES);
  const units = [];
  for (const unit of splitDeliveryUnits(normalized)) {
    if (utf8ByteLength(unit) <= deliveryLimit) {
      units.push(unit);
      continue;
    }
    units.push(...packMarkdownBlocks(unit, deliveryLimit));
  }
  const aggregated = aggregateUnits(units, deliveryLimit);
  return aggregated.length > 0 ? aggregated : [normalized];
}

function rewriteHeading(line: string) {
  if (/^#\s+/.test(line)) {
    return `【${line.replace(/^#\s+/u, '').trim()}】`;
  }
  if (/^##+\s+/.test(line)) {
    return `**${line.replace(/^##+\s+/u, '').trim()}**`;
  }
  return line;
}

function splitDeliveryUnits(content: string) {
  const units: string[] = [];
  for (const block of splitMarkdownBlocks(content)) {
    const firstLine = block.split('\n')[0]?.trim() ?? '';
    if (FENCE_RE.test(firstLine)) {
      units.push(block);
      continue;
    }

    let current: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\s+$/u, '');
      if (!line.trim()) {
        if (current.length > 0) {
          units.push(current.join('\n').trim());
          current = [];
        }
        continue;
      }

      const isContinuation = current.length > 0 && /^[ \t]/u.test(rawLine);
      if (isContinuation) {
        current.push(line);
        continue;
      }

      if (current.length > 0) {
        units.push(current.join('\n').trim());
      }
      current = [line];
    }

    if (current.length > 0) {
      units.push(current.join('\n').trim());
    }
  }
  return units.filter(Boolean);
}

function aggregateUnits(units: string[], maxLength: number) {
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    const normalizedUnit = String(unit ?? '').trim();
    if (!normalizedUnit) {
      continue;
    }
    const separator = current ? '\n' : '';
    const candidate = `${current}${separator}${normalizedUnit}`;
    if (current && utf8ByteLength(candidate) > maxLength) {
      chunks.push(current);
      current = normalizedUnit;
      continue;
    }
    if (!current && utf8ByteLength(normalizedUnit) > maxLength) {
      chunks.push(normalizedUnit);
      continue;
    }
    current = candidate;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function packMarkdownBlocks(content: string, maxLength: number) {
  if (utf8ByteLength(content) <= maxLength) {
    return [content];
  }

  const packed: string[] = [];
  let current = '';
  for (const block of splitMarkdownBlocks(content)) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (utf8ByteLength(candidate) <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) {
      packed.push(current);
      current = '';
    }
    if (utf8ByteLength(block) <= maxLength) {
      current = block;
      continue;
    }
    packed.push(...truncateMessage(block, maxLength));
  }

  if (current) {
    packed.push(current);
  }
  return packed;
}

function splitMarkdownBlocks(content: string) {
  const lines = String(content ?? '').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (FENCE_RE.test(trimmed)) {
      current.push(line);
      inFence = !inFence;
      continue;
    }

    if (!inFence && !trimmed) {
      if (current.length > 0) {
        blocks.push(current.join('\n').trim());
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join('\n').trim());
  }
  return blocks.filter(Boolean);
}

function truncateMessage(content: string, maxLength: number) {
  if (utf8ByteLength(content) <= maxLength) {
    return [content];
  }
  if (isFencedCodeBlock(content)) {
    return splitFencedCodeBlock(content, maxLength);
  }

  const chunks: string[] = [];
  let remaining = content;
  while (utf8ByteLength(remaining) > maxLength) {
    let splitAt = findTruncationBoundary(remaining, maxLength);
    if (splitAt <= 0) {
      splitAt = sliceByUtf8Bytes(remaining, maxLength).length;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).replace(/^[\n\s]+/u, '');
  }
  if (remaining) {
    chunks.push(remaining.trim());
  }
  return chunks.filter(Boolean);
}

function isFencedCodeBlock(content: string) {
  const lines = String(content ?? '').split('\n');
  return lines.length >= 2 && FENCE_RE.test(lines[0].trim()) && FENCE_RE.test(lines[lines.length - 1].trim());
}

function splitFencedCodeBlock(content: string, maxLength: number) {
  const lines = String(content ?? '').split('\n');
  const opening = lines.shift();
  const closing = lines.pop();
  const chunks: string[] = [];
  let current = opening;

  for (const line of lines) {
    const candidate = `${current}\n${line}\n${closing}`;
    if (current !== opening && utf8ByteLength(candidate) > maxLength) {
      chunks.push(`${current}\n${closing}`);
      current = `${opening}\n${line}`;
      continue;
    }
    if (current === opening && utf8ByteLength(candidate) > maxLength) {
      chunks.push(...splitLongFencedLine(opening, line, closing, maxLength));
      current = opening;
      continue;
    }
    current = `${current}\n${line}`;
  }

  if (current !== opening) {
    chunks.push(`${current}\n${closing}`);
  }
  return chunks.filter(Boolean);
}

function splitLongFencedLine(opening: string, line: string, closing: string, maxLength: number) {
  const chunks: string[] = [];
  let remaining = String(line ?? '');
  const frameBytes = utf8ByteLength(`${opening}\n\n${closing}`);
  const available = Math.max(1, maxLength - frameBytes);
  while (remaining) {
    const piece = sliceByUtf8Bytes(remaining, available);
    chunks.push(`${opening}\n${piece}\n${closing}`);
    remaining = remaining.slice(piece.length);
  }
  return chunks;
}

function findTruncationBoundary(text: string, maxBytes: number) {
  let bestBoundary = -1;
  let bestSentence = -1;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    bytes += utf8ByteLength(text[index]);
    if (bytes > maxBytes) {
      break;
    }
    if (text[index] === '\n') {
      bestBoundary = index;
    }
    if ('。！？.!?；;'.includes(text[index])) {
      bestSentence = index + 1;
    }
  }
  if (bestBoundary > 0) {
    return bestBoundary;
  }
  return bestSentence;
}

function sliceByUtf8Bytes(text: string, maxBytes: number) {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const next = utf8ByteLength(text[index]);
    if (bytes + next > maxBytes) {
      break;
    }
    bytes += next;
    index += 1;
  }
  return text.slice(0, index);
}

function utf8ByteLength(text: string) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}
