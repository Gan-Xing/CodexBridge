export function parseSlashCommand(text) {
  const raw = text.trim();
  if (!raw.startsWith('/')) {
    return null;
  }
  const body = raw.slice(1).trim();
  if (!body) {
    return null;
  }
  const [namePart, ...argParts] = body.split(/\s+/u);
  const name = namePart.trim().toLowerCase();
  if (!name) {
    return null;
  }
  return {
    name,
    args: argParts,
    raw,
  };
}
