import { launchBrowser } from '../config/browser';
import fs from 'fs/promises';
import path from 'path';
/// <reference path="../types/html-to-docx.d.ts" />
import HTMLtoDOCX from 'html-to-docx';
import { Profile } from '../types/profile';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getCoverLetterOutputFilename } from '../utils/generatedPath';
import { withRenderPermit } from './renderConcurrency';
import { normalizeDashes } from '../services/utils/dashes';

const COVER_LETTER_GREETINGS = ['Hello Hiring Team,', 'Hi Hiring Team,', 'Hello Team,', 'Hi Team,', 'Hi,', 'Hello,', 'Hi Hiring Manager,', 'Hello Hiring Manager'];

function getCoverLetterGreeting(): string {
  return COVER_LETTER_GREETINGS[Math.floor(Math.random() * COVER_LETTER_GREETINGS.length)];
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The looks a cover letter can be rendered in.
 *
 * WHY THIS EXISTS. Every letter this app produced was the same block of 11pt
 * Arial, so a batch sent on behalf of a dozen different people arrived looking
 * like a dozen copies of one template.
 *
 * WHY IT WAS REWRITTEN. The first attempt at fifty looks varied the typeface
 * and then, honestly, nothing else: a point of body size, a tenth of leading,
 * two points of paragraph gap, and four near-blacks nobody can tell apart. Set
 * two of them side by side and the only difference you could name was the font.
 * Fifty names, one letter.
 *
 * So the second axis is the SHAPE OF THE PAGE, not another nudge to a number.
 * A block letter and an indented one are different documents to look at; so are
 * a 0.55in margin and a 1.1in one, ragged right and justified, a narrow measure
 * and a full one, a rule and no rule. Those are the things a reader actually
 * sees, and the five forms below each bundle a set of them.
 *
 * WHAT DELIBERATELY DOES NOT VARY. All fifty are one column of ordinary
 * paragraphs in reading order. A cover letter is parsed by the same scanners
 * the resume is, and a layout that reads well to a person and badly to a parser
 * would trade a real advantage for a cosmetic one - so the rules are <hr>
 * decoration a parser skips, never a table or a box. Nor does any of them add
 * or remove a word: the ask was for a different look, not a different letter.
 *
 * Every stack ends in a generic family, because the font that renders is
 * whatever the machine doing the rendering happens to have: these run on a
 * Windows desktop and a Mac, and the two share almost nothing beyond the
 * families named here.
 */
type CoverLetterStyle = {
  name: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  color: string;
  /** Space between paragraphs. Zero on an indented form, which uses indent instead. */
  paragraphGap: string;
  /** First-line indent. Zero on a block form, which uses the gap instead. */
  paragraphIndent: string;
  textAlign: 'left' | 'justify';
  /** Page margin, handed to `page.pdf`. The single biggest lever on the look. */
  pageMargin: string;
  /** Caps the measure, so a form can read as a narrow column on a wide page. */
  maxWidth: string | null;
  greeting: string;
  signOff: string;
  signature: string;
  /** Decoration only - an <hr> a parser skips. */
  ruleAfterGreeting: boolean;
  ruleBeforeSignature: boolean;
  accent: string;
};

/** Ten typefaces, each with a fallback chain that survives either platform. */
const FAMILIES: Array<{ key: string; stack: string; serif: boolean }> = [
  { key: 'georgia', stack: "Georgia, 'Times New Roman', Times, serif", serif: true },
  { key: 'times', stack: "'Times New Roman', Times, Georgia, serif", serif: true },
  { key: 'palatino', stack: "Palatino, 'Palatino Linotype', 'Book Antiqua', Georgia, serif", serif: true },
  { key: 'cambria', stack: "Cambria, Georgia, 'Times New Roman', serif", serif: true },
  { key: 'garamond', stack: "Garamond, 'EB Garamond', Georgia, serif", serif: true },
  { key: 'helvetica', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", serif: false },
  { key: 'arial', stack: 'Arial, Helvetica, sans-serif', serif: false },
  { key: 'segoe', stack: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif", serif: false },
  { key: 'verdana', stack: "Verdana, Geneva, 'Segoe UI', sans-serif", serif: false },
  { key: 'trebuchet', stack: "'Trebuchet MS', 'Lucida Grande', Tahoma, sans-serif", serif: false },
];

/**
 * Five ways to lay the page out.
 *
 * Each changes several things at once on purpose. Varying one lever at a time
 * is what produced fifty letters that looked like one; a form has to commit.
 */
type LetterForm = Omit<CoverLetterStyle, 'name' | 'fontFamily' | 'fontSize' | 'color' | 'accent'> & {
  key: string;
  serifSize: string;
  sansSize: string;
};

const FORMS: LetterForm[] = [
  {
    // Block paragraphs, ragged right, ordinary margins. The default business
    // letter, and the baseline everything else departs from.
    key: 'block',
    serifSize: '11.5pt',
    sansSize: '10.5pt',
    lineHeight: '1.55',
    paragraphGap: '12pt',
    paragraphIndent: '0',
    textAlign: 'left',
    pageMargin: '0.75in',
    maxWidth: null,
    greeting: 'margin: 0 0 14pt 0; font-weight: 600;',
    signOff: 'margin: 16pt 0 6pt 0;',
    signature: 'margin: 0; font-weight: bold;',
    ruleAfterGreeting: false,
    ruleBeforeSignature: false,
  },
  {
    // The typed letter: first line indented, no space between paragraphs,
    // justified. Unmistakably not the one above, whatever face it is set in.
    key: 'indented',
    serifSize: '12pt',
    sansSize: '11pt',
    lineHeight: '1.5',
    paragraphGap: '0',
    paragraphIndent: '26pt',
    textAlign: 'justify',
    pageMargin: '0.9in',
    maxWidth: null,
    greeting: 'margin: 0 0 12pt 0;',
    signOff: 'margin: 18pt 0 6pt 0;',
    signature: 'margin: 0;',
    ruleAfterGreeting: false,
    ruleBeforeSignature: true,
  },
  {
    // Dense and edge to edge, with the greeting set as a heading. Reads as a
    // memo rather than a letter.
    key: 'memo',
    serifSize: '11pt',
    sansSize: '10pt',
    lineHeight: '1.45',
    paragraphGap: '9pt',
    paragraphIndent: '0',
    textAlign: 'left',
    pageMargin: '0.55in',
    maxWidth: null,
    greeting: 'margin: 0 0 6pt 0; text-transform: uppercase; letter-spacing: 1.2pt; font-size: 0.85em; font-weight: bold;',
    signOff: 'margin: 14pt 0 4pt 0;',
    signature: 'margin: 0; font-weight: bold;',
    ruleAfterGreeting: true,
    ruleBeforeSignature: false,
  },
  {
    /*
     * Wide margins and justified text: the most formal of the five.
     *
     * It used to leave 30pt under the sign-off, the way a printed letter
     * leaves room for a wet signature, on a document nobody prints and signs -
     * so "Best regards," and the name read as two separate things with a hole
     * between them. Its leading was 1.8 against 1.45-1.55 everywhere else,
     * which opened the body of the letter to match. Formality here is the
     * margins, the justification and the small-caps name, none of which costs
     * the reader a line of white space.
     */
    key: 'formal',
    serifSize: '12pt',
    sansSize: '11pt',
    lineHeight: '1.55',
    paragraphGap: '12pt',
    paragraphIndent: '0',
    textAlign: 'justify',
    pageMargin: '1.1in',
    maxWidth: null,
    greeting: 'margin: 0 0 14pt 0;',
    signOff: 'margin: 18pt 0 6pt 0;',
    signature: 'margin: 0; text-transform: uppercase; letter-spacing: 1.5pt; font-size: 0.9em;',
    ruleAfterGreeting: false,
    ruleBeforeSignature: false,
  },
  {
    // A narrow column on a full page: short lines, a lot of white to the right.
    key: 'narrow',
    serifSize: '11.5pt',
    sansSize: '10.5pt',
    lineHeight: '1.6',
    paragraphGap: '13pt',
    paragraphIndent: '0',
    textAlign: 'left',
    pageMargin: '0.85in',
    maxWidth: '4.6in',
    greeting: 'margin: 0 0 15pt 0; font-weight: 600;',
    signOff: 'margin: 20pt 0 6pt 0;',
    signature: 'margin: 0; font-weight: 600; font-size: 1.15em;',
    ruleAfterGreeting: false,
    ruleBeforeSignature: true,
  },
];

/** Body inks. Near-black: a letter is not a brochure. */
const INKS = ['#1A1A1A', '#000000', '#22272E', '#1F2933', '#101820'];

/**
 * Accents, used only where one line of colour is deliberate - a rule, or the
 * signature. Never on body text, which stays near-black in all fifty.
 */
const ACCENTS = ['#123A5A', '#1F2933', '#2D4739', '#5A2D2D', '#000000'];

function buildCoverLetterStyles(): CoverLetterStyle[] {
  const styles: CoverLetterStyle[] = [];

  for (let index = 0; index < FAMILIES.length * FORMS.length; index += 1) {
    const family = FAMILIES[index % FAMILIES.length];
    const form = FORMS[Math.floor(index / FAMILIES.length) % FORMS.length];

    // Strides that share no factor with 5 walk the whole axis rather than
    // landing on the same two entries over and over.
    const ink = INKS[(index * 3) % INKS.length];
    const accent = ACCENTS[(index * 7) % ACCENTS.length];

    const { key: _key, serifSize, sansSize, ...shape } = form;
    styles.push({
      ...shape,
      name: `${family.key}-${form.key}`,
      fontFamily: family.stack,
      fontSize: family.serif ? serifSize : sansSize,
      color: ink,
      accent,
    });
  }

  return styles;
}

const COVER_LETTER_STYLES: CoverLetterStyle[] = buildCoverLetterStyles();

/** A small stable hash, so the same name always lands on the same style. */
function hashName(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return hash;
}

/**
 * Which look this profile's letters are written in.
 *
 * Chosen from the NAME rather than at random, and the difference matters. A
 * random pick per call would give one person a different letter every time they
 * applied somewhere, which reads as carelessness to anyone who sees two of
 * them; keying it to the name varies the look across people - the thing that
 * was actually wrong - while keeping one person's letters recognisably theirs.
 *
 * COVER_LETTER_STYLE=classic|modern|formal|airy|compact pins it, for an
 * operator who wants one look for everybody.
 */
export function pickCoverLetterStyle(
  profileName: string,
  env: NodeJS.ProcessEnv = process.env
): CoverLetterStyle {
  const forced = (env.COVER_LETTER_STYLE ?? '').trim().toLowerCase();
  if (forced) {
    const match = COVER_LETTER_STYLES.find((style) => style.name === forced);
    if (match) return match;
  }
  const key = profileName.trim().toLowerCase();
  return COVER_LETTER_STYLES[hashName(key) % COVER_LETTER_STYLES.length];
}

/**
 * The body paragraphs.
 *
 * A form either separates paragraphs with space OR indents their first line -
 * doing both is the mark of somebody who set neither on purpose, and doing
 * neither runs the letter together. The first paragraph after a greeting is
 * never indented, which is the ordinary typographic rule.
 */
function contentToHtmlParagraphs(content: string, style: CoverLetterStyle): string {
  // Both the PDF and the DOCX come through here, and so does the letter
  // written without a job description, which no resume funnel ever sees.
  const trimmed = normalizeDashes(content).trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());
  return paragraphs
    .map((paragraph, index) => {
      const indent = index === 0 ? '0' : style.paragraphIndent;
      return (
        `<p style="margin: 0 0 ${style.paragraphGap} 0; line-height: ${style.lineHeight}; ` +
        `text-indent: ${indent}; text-align: ${style.textAlign};">` +
        `${esc(paragraph.trim().replace(/\n/g, ' '))}</p>`
      );
    })
    .join('\n  ');
}

/**
 * A decorative rule.
 *
 * An hr and nothing else: a parser skips it, and it carries no text that could
 * be mistaken for part of the letter.
 */
function rule(style: CoverLetterStyle, margin: string): string {
  return `<hr style="border: none; border-top: 0.75pt solid ${style.accent}; margin: ${margin};">`;
}

/**
 * The document title, which is also the PDF's title in a viewer's tab.
 *
 * Without one the tab read "about:blank": the page is loaded with
 * `setContent`, so it has no URL to fall back on and no title to use instead.
 */
function coverLetterTitle(profileName: string): string {
  const name = profileName.trim();
  return name ? `${name} - Cover Letter` : 'Cover Letter';
}

/**
 * Build professional PDF-style HTML for the cover letter.
 * Structure: greeting, {content}, Best regards, {Profile name}
 */
function buildCoverLetterHTML(content: string, profileName: string): string {
  const style = pickCoverLetterStyle(profileName);
  // A narrow form caps the measure; the rest run the full width of the page.
  const measure = style.maxWidth ? ` max-width: ${style.maxWidth};` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${esc(coverLetterTitle(profileName))}</title>
  <style>
    /* Same reason the resume disables them: Chrome writes "fi" and "fl" as one
       ligature glyph mapped to U+FB01/U+FB02, so the text copies out - and is
       read by a scanner - as "Artiﬁcial" rather than "Artificial". */
    *, *::before, *::after { font-variant-ligatures: none; }
    /* Justified text without hyphenation opens rivers of white space, worst in
       a narrow measure. This is what makes the justified forms readable. */
    p { hyphens: auto; -webkit-hyphens: auto; orphans: 2; widows: 2; }
  </style>
</head>
<body style="font-family: ${style.fontFamily}; font-size: ${style.fontSize}; color: ${style.color}; line-height: ${style.lineHeight};${measure}">
  <p style="${style.greeting}">${getCoverLetterGreeting()}</p>
  ${style.ruleAfterGreeting ? rule(style, '0 0 12pt 0') : ''}
  ${contentToHtmlParagraphs(content, style)}
  ${style.ruleBeforeSignature ? rule(style, '18pt 0 0 0') : ''}
  <p style="${style.signOff}">Best regards,</p>
  <p style="${style.signature} color: ${style.accent};">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Build cover letter HTML for DOCX with explicit line breaks between sections.
 * Structure: greeting, (line break), {content}, (line break), Best regards, {profile name}
 */
function buildCoverLetterHTMLForDocx(content: string, profileName: string): string {
  const style = pickCoverLetterStyle(profileName);
  // A gap of zero belongs to an indented form, where the indent does the
  // separating. A DOCX still needs something between the blocks.
  const lineBreak = `<p style="margin: 0 0 ${style.paragraphGap === '0' ? '12pt' : style.paragraphGap} 0;"></p>`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${esc(coverLetterTitle(profileName))}</title>
</head>
<body style="font-family: ${style.fontFamily}; font-size: ${style.fontSize}; color: ${style.color}; line-height: ${style.lineHeight};">
  <p style="${style.greeting}">${getCoverLetterGreeting()}</p>
  ${lineBreak}
  ${contentToHtmlParagraphs(content, style)}
  ${lineBreak}
  <p style="${style.signOff}">Best regards,</p>
  <p style="${style.signature}">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Save cover letter as PDF in the same directory as the resume.
 * Path: {profile}/{count+1}_{company}/{role}/{profile}_cover_letter.pdf
 */
export async function saveCoverLetter(
  profile: Profile,
  content: string,
  pathInfo: GeneratedPathInfo
): Promise<string> {
  const filename = getCoverLetterOutputFilename(pathInfo, 'pdf');
  const relativePath = `${pathInfo.storagePathBase}/${filename}`;
  const filepath = path.join(pathInfo.absoluteDir, filename);

  const html = buildCoverLetterHTML(content.trim(), profile.name);

  // The heaviest render in the app: a whole Chrome per cover letter, not a tab
  // in a shared one. It takes a permit from the same pool the resume renders
  // do, because it is the same machine being asked for the memory.
  return await withRenderPermit(async () => {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 595, height: 842, deviceScaleFactor: 1 }); // A4 at 72 DPI
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'load' });

    // From the style, not a constant. The page margin is the single biggest
    // lever on whether two letters read as different documents - 0.55in and
    // 1.1in are not the same page - and it lives here because ${TICK}page.pdf${TICK} owns
    // it rather than CSS.
    const { pageMargin } = pickCoverLetterStyle(profile.name);
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: pageMargin, right: pageMargin, bottom: pageMargin, left: pageMargin },
      printBackground: true,
    });

    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, Buffer.from(pdfBuffer));

    return relativePath;
  } finally {
    await browser.close();
  }
  });
}

/**
 * Save cover letter as DOCX in the same directory as the resume.
 * Path: {profile}/{date}/{company}/{role}/{profile}_cover_letter.docx
 */
export async function saveCoverLetterDOCX(
  profile: Profile,
  content: string,
  pathInfo: GeneratedPathInfo
): Promise<string> {
  const filename = getCoverLetterOutputFilename(pathInfo, 'docx');
  const relativePath = `${pathInfo.storagePathBase}/${filename}`;
  const filepath = path.join(pathInfo.absoluteDir, filename);

  const html = buildCoverLetterHTMLForDocx(content.trim(), profile.name);

  const docxBuffer = await HTMLtoDOCX(html, null, {
    font: 'Arial',
    fontSize: 22, // 11pt = 22 half-points
    margins: { top: 1080, right: 1080, bottom: 1080, left: 1080 }, // 0.75in in twips
    orientation: 'portrait',
  });

  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, Buffer.from(docxBuffer as ArrayBuffer));

  return relativePath;
}
