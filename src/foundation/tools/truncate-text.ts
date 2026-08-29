/**
 * Truncates a string to `maxChars`, appending a note when content was cut.
 * @param text - The text to truncate.
 * @param maxChars - The maximum number of characters to keep.
 * @returns The truncated text and whether truncation happened.
 */
export function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}
