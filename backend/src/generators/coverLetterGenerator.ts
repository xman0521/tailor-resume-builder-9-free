import { launchBrowser } from '../config/browser';
import fs from 'fs/promises';
import path from 'path';
/// <reference path="../types/html-to-docx.d.ts" />
import HTMLtoDOCX from 'html-to-docx';
import { Profile } from '../types/profile';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getCoverLetterOutputFilename } from '../utils/generatedPath';
import { withRenderPermit } from './renderConcurrency';

const COVER_LETTER_GREETINGS = ['Hello Hiring Team,', 'Hi Hiring Team,', 'Hello Team,', 'Hi Team,', 'Hi,', 'Hello,', 'Hi Hiring Manager,', 'Hello, Hiring Manager'];

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
 * like a dozen copies of one template - which is exactly what a reader notices
 * and what the letter is supposed to deny.
 *
 * WHY THEY ARE COMPOSED RATHER THAN LISTED. Fifty hand-written blocks would be
 * fifty places to make a typo and fifty things to keep consistent; every one of
 * them would repeat the same six fields with slightly different numbers. So the
 * catalogue is built from axes that are each sane on their own - a typeface, a
 * reading rhythm, an ink, a signature treatment - and combined. Ten typefaces
 * times five rhythms is exactly fifty, and the pairing is what guarantees no
 * two are alike: the other axes only add spice on top.
 *
 * WHAT DELIBERATELY DOES NOT VARY. All fifty are one column of ordinary
 * paragraphs. A cover letter is parsed by the same scanners the resume is, and
 * a layout that reads well to a person and badly to a parser would trade a real
 * advantage for a cosmetic one. Nor does any of them add or remove a word: the
 * ask was for a different look, not a different letter, and a "letterhead" that
 * repeated the sender's name would be content the caller never wrote.
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
  /** Space between paragraphs. The main lever on how dense the page feels. */
  paragraphGap: string;
  greeting: string;
  signOff: string;
  signature: string;
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
 * Five reading rhythms, from dense to generous.
 *
 * Serif faces carry a slightly larger body size at the same rhythm: the two
 * groups have different x-heights, and matching the number rather than the
 * apparent size is what made the old single style look cramped in some faces
 * and loose in others.
 */
const RHYTHMS: Array<{
  key: string;
  serifSize: string;
  sansSize: string;
  lineHeight: string;
  paragraphGap: string;
}> = [
  { key: 'compact', serifSize: '11pt', sansSize: '10pt', lineHeight: '1.45', paragraphGap: '10pt' },
  { key: 'plain', serifSize: '11.5pt', sansSize: '10.5pt', lineHeight: '1.55', paragraphGap: '12pt' },
  { key: 'open', serifSize: '12pt', sansSize: '11pt', lineHeight: '1.65', paragraphGap: '13pt' },
  { key: 'airy', serifSize: '12pt', sansSize: '11pt', lineHeight: '1.8', paragraphGap: '15pt' },
  { key: 'formal', serifSize: '12.5pt', sansSize: '11.5pt', lineHeight: '1.5', paragraphGap: '14pt' },
];

/** Inks. Near-black, bar two restrained blues that read as deliberate. */
const INKS = ['#1A1A1A', '#000000', '#22272E', '#1F2933', '#123A5A'];

/** How the name under "Best regards," is set. */
const SIGNATURES = [
  'margin: 0; font-weight: bold; color: #000000;',
  'margin: 0; font-weight: 600; font-size: 1.1em;',
  'margin: 0; letter-spacing: 0.5pt;',
  'margin: 0; font-weight: bold; letter-spacing: 0.3pt; font-size: 1.05em;',
  'margin: 0;',
];

/** Extra breathing room before the sign-off, where a wet signature would go. */
const SIGN_OFF_GAPS = ['14pt', '16pt', '18pt', '20pt', '22pt'];

function buildCoverLetterStyles(): CoverLetterStyle[] {
  const styles: CoverLetterStyle[] = [];

  for (let index = 0; index < FAMILIES.length * RHYTHMS.length; index += 1) {
    const family = FAMILIES[index % FAMILIES.length];
    const rhythm = RHYTHMS[Math.floor(index / FAMILIES.length) % RHYTHMS.length];

    // Strides that share no factor with 5 walk the whole axis rather than
    // landing on the same two entries over and over.
    const ink = INKS[(index * 3) % INKS.length];
    const signature = SIGNATURES[(index * 7) % SIGNATURES.length];
    const signOffGap = SIGN_OFF_GAPS[(index * 9) % SIGN_OFF_GAPS.length];

    styles.push({
      name: `${family.key}-${rhythm.key}`,
      fontFamily: family.stack,
      fontSize: family.serif ? rhythm.serifSize : rhythm.sansSize,
      lineHeight: rhythm.lineHeight,
      color: ink,
      paragraphGap: rhythm.paragraphGap,
      greeting: `margin: 0 0 ${rhythm.paragraphGap} 0;`,
      signOff: `margin: ${signOffGap} 0 6pt 0;`,
      signature,
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

/** Convert plain text content to HTML paragraphs */
function contentToHtmlParagraphs(content: string, style: CoverLetterStyle): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());
  return paragraphs
    .map(
      (p) =>
        `<p style="margin: 0 0 ${style.paragraphGap} 0; line-height: ${style.lineHeight};">` +
        `${esc(p.trim().replace(/\n/g, ' '))}</p>`
    )
    .join('\n  ');
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
  </style>
</head>
<body style="font-family: ${style.fontFamily}; font-size: ${style.fontSize}; color: ${style.color}; line-height: ${style.lineHeight};">
  <p style="${style.greeting}">${getCoverLetterGreeting()}</p>
  ${contentToHtmlParagraphs(content, style)}
  <p style="${style.signOff}">Best regards,</p>
  <p style="${style.signature}">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Build cover letter HTML for DOCX with explicit line breaks between sections.
 * Structure: greeting, (line break), {content}, (line break), Best regards, {profile name}
 */
function buildCoverLetterHTMLForDocx(content: string, profileName: string): string {
  const style = pickCoverLetterStyle(profileName);
  const lineBreak = `<p style="margin: 0 0 ${style.paragraphGap} 0;"></p>`;
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

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
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
