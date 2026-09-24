/**
 * Slugify a human label into a URL-safe slug: lowercase, with runs of
 * non-alphanumerics collapsed to single hyphens and edges trimmed. Bounded so it
 * fits the slug fields (default 48 chars, matching the create-form schemas).
 *
 * Pure and dependency-free so it's unit-testable and reusable by any create
 * dialog that auto-derives a slug from a name (the Vercel pattern).
 */
export function slugify(input: string, maxLen = 48): string {
  const base = (input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumerics -> hyphen
    .replace(/^-+|-+$/g, ""); // trim edge hyphens
  // Truncate, then re-trim any hyphen the cut may have left dangling.
  return base.slice(0, maxLen).replace(/-+$/g, "");
}
