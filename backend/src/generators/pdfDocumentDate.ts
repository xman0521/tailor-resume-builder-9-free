import { execFile } from 'child_process';
import { promises as fs } from 'fs';

/**
 * The date a resume PDF says it was made.
 *
 * ASKED FOR: "different date and time per profile, random date of a few months
 * ago" - for resumes only. Chrome stamps the moment of rendering into the
 * document's Created and Modified fields, so a batch of resumes all read as
 * made in the same second, minutes before they were sent.
 *
 * PER PROFILE, NOT PER FILE. One person's resumes carry one date, the way a
 * resume a person keeps and re-sends would. The date is drawn from the
 * profile's id, so it is the same on every file that profile produces on a
 * given day, different from every other profile's, and always 60-150 days
 * before today: a weekday, during working hours, at a minute and second that
 * look typed rather than rounded.
 */

const MIN_DAYS_AGO = 60;
const MAX_DAYS_AGO = 150;
const FIRST_HOUR = 9;
const WORKING_HOURS = 9;

/** FNV-1a: a small, well-mixed 32-bit hash, so nearby ids land far apart. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let at = 0; at < value.length; at += 1) {
    result ^= value.charCodeAt(at);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result;
}

export function resumeDocumentDate(profileKey: string, now: Date = new Date()): Date {
  const seed = hash(profileKey || 'resume');
  const daysAgo = MIN_DAYS_AGO + (seed % (MAX_DAYS_AGO - MIN_DAYS_AGO + 1));

  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
  // A Saturday or Sunday becomes the Friday before it.
  const weekday = date.getDay();
  if (weekday === 6) date.setDate(date.getDate() - 1);
  if (weekday === 0) date.setDate(date.getDate() - 2);

  const mixed = hash(`${profileKey}|time`);
  date.setHours(
    FIRST_HOUR + (mixed % WORKING_HOURS),
    (mixed >>> 8) % 60,
    (mixed >>> 16) % 60,
    0
  );
  return date;
}

const two = (value: number) => String(value).padStart(2, '0');

/** A PDF date in local time with its offset, as Word writes one: D:20260714103217-05'00'. */
export function pdfDateString(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `D:${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
    + `${sign}${two(hours)}'${two(minutes)}'`;
}

/**
 * The same PDF with its Created and Modified dates set to `date`.
 *
 * REWRITTEN IN PLACE, BYTE FOR BYTE. Chrome writes both as literal strings in
 * the document's info dictionary, with no XMP copy, and a PDF locates its
 * objects by byte offset - so a replacement of exactly the same length leaves
 * every offset true and the rest of the file untouched. Anything else - a date
 * in another form, a length that differs - leaves the file exactly as Chrome
 * wrote it, because a resume with the real date beats a resume that will not
 * open.
 */
export function withDocumentDate(pdf: Buffer, date: Date): { pdf: Buffer; rewritten: number } {
  const stamp = pdfDateString(date);
  const text = pdf.toString('latin1');
  const out = Buffer.from(pdf);
  let rewritten = 0;
  for (const match of text.matchAll(/\/(?:CreationDate|ModDate)\s*\((D:[^)]*)\)/g)) {
    const value = match[1];
    if (value.length !== stamp.length || match.index === undefined) continue;
    out.write(stamp, match.index + match[0].indexOf(value), 'latin1');
    rewritten += 1;
  }
  return { pdf: rewritten > 0 ? out : pdf, rewritten };
}

/**
 * The same date on the file itself: Created, Modified and Accessed, as
 * Explorer and a browser's file picker show them.
 *
 * ASKED FOR alongside the document dates, which a reader sees in Document
 * Properties; these are what the folder shows. Modified and Accessed are set
 * the portable way. Created has no portable setter - on Windows it is set
 * through .NET in a PowerShell child process, and elsewhere it is left as the
 * file system wrote it. The path and the time are handed over in the
 * environment, never spliced into the command, so no path can break the quoting.
 *
 * Never fatal: a file with today's time on it is still a resume.
 */
export async function stampFileTimes(filepath: string, date: Date): Promise<boolean> {
  try {
    await fs.utimes(filepath, date, date);
    if (process.platform !== 'win32') return true;
    await new Promise<void>((resolve, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$t = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:STAMP_TIME).UtcDateTime; '
            + '[IO.File]::SetCreationTimeUtc($env:STAMP_PATH, $t); '
            + '[IO.File]::SetLastWriteTimeUtc($env:STAMP_PATH, $t); '
            + '[IO.File]::SetLastAccessTimeUtc($env:STAMP_PATH, $t)',
        ],
        {
          env: { ...process.env, STAMP_PATH: filepath, STAMP_TIME: String(date.getTime()) },
          timeout: 15_000,
          windowsHide: true,
        },
        (error) => (error ? reject(error) : resolve())
      );
    });
    return true;
  } catch (error) {
    console.warn(
      `[Resume PDF] could not set the file's own dates on ${filepath}: `
        + `${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
