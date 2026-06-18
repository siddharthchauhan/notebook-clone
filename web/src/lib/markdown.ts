import { marked } from "marked";
import DOMPurify from "dompurify";

// Render Markdown to sanitized HTML. marked handles CommonMark/GFM; DOMPurify
// strips anything unsafe before it reaches the DOM.
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html);
}
