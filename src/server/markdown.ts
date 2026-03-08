import { marked } from "marked";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// Create a DOM for DOMPurify to work with
const jsdom = new JSDOM("");
const purify = DOMPurify(jsdom.window);

// Configure marked for Deno-compatible settings
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true, // GitHub Flavored Markdown
});

/**
 * Parse markdown to sanitized HTML.
 * Uses DOMPurify to prevent XSS attacks.
 *
 * @param text - Raw markdown text
 * @returns Sanitized HTML string
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  const html = marked.parse(text) as string;
  return purify.sanitize(html);
}