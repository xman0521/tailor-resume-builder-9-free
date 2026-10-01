import fs from 'fs/promises';
import path from 'path';
import { Profile } from '../types/profile';
import {
  DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  pickFileNameStyle,
  renderOutputFolderNameTemplate,
  renderOutputFileNameTemplate,
  renderOutputPathTemplate,
  renderStyledFileNames,
  resolveStoredFilePath,
  sanitizePathSegment,
} from './outputStorage';
import { getOutputStorageSettings } from '../config/aiModelConfig';
import { naturalRoleTitle, roleFamily } from '../services/utils/roleTitle';

function getCurrentDateFolder(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeSourceRowNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return '';
  }
  return String(value);
}

export interface GeneratedPathInfo {
  relativeBase: string;
  absoluteDir: string;
  storagePathBase: string;
  profileSlug: string;
  resumeFileStem: string;
  coverLetterFileStem: string;
  companyFolderName: string;
  roleSlug: string;
}

export function getResumeOutputFilename(pathInfo: GeneratedPathInfo, extension: 'pdf' | 'docx'): string {
  return `${pathInfo.resumeFileStem || pathInfo.profileSlug}.${extension}`;
}

export function getCoverLetterOutputFilename(pathInfo: GeneratedPathInfo, extension: 'pdf' | 'docx'): string {
  return `${pathInfo.coverLetterFileStem || `${pathInfo.profileSlug}_cover_letter`}.${extension}`;
}

export async function getGeneratedOutputPath(
  profile: Profile,
  companyName: string,
  role: string,
  sourceRowNumber?: number
): Promise<GeneratedPathInfo> {
  const { outputBaseDir, outputPathTemplate } = await getOutputStorageSettings();
  const profileSlug = sanitizePathSegment(profile.name) || 'unknown';
  const roleSlug = sanitizePathSegment(role || 'resume') || 'resume';
  const rowNumber = normalizeSourceRowNumber(sourceRowNumber);
  const baseTemplateVariables = {
    date: getCurrentDateFolder(),
    profileName: profile.name || 'unknown',
    companyName: companyName || 'unknown',
    rowNumber,
    // The posting's own title, tidied: this names the FOLDER, where telling two
    // jobs at one company apart is the whole point.
    jobTitle: naturalRoleTitle(role) || role || 'resume',
    // And the discipline, which is what a FILE is named after: a listing reads
    // better as "Weitian_Wu_DevOps_Engineer" than as
    // "Weitian_Wu_DevOps_Engineer_III_AI_Business_Automation".
    roleFamily: roleFamily(role) || naturalRoleTitle(role) || role || 'resume',
  };
  const companyFolderName = renderOutputFolderNameTemplate(
    profile.profileSettings?.companyFolderNameTemplate || DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
    baseTemplateVariables,
    DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE
  );
  const pathTemplateVariables = {
    ...baseTemplateVariables,
    companyName: companyFolderName,
  };
  const relativeBase = renderOutputPathTemplate(outputPathTemplate, pathTemplateVariables);
  /*
   * The two file names, in one of the shapes drawn per application.
   *
   * A PROFILE THAT NAMES ITS OWN TEMPLATE PINS ITSELF. The pool is what a
   * profile gets when it has not said otherwise, so an operator who wants every
   * file for one candidate to look identical still can, by setting the template
   * in Admin. Both names come from the same draw: a folder holding
   * "Weitian_Wu_DevOps_Engineer.pdf" beside "devops_engineer_weitian_wu_cl.pdf"
   * reads as two different people's work.
   */
  const ownResumeTemplate = profile.profileSettings?.resumeFileNameTemplate?.trim();
  const ownCoverTemplate = profile.profileSettings?.coverLetterFileNameTemplate?.trim();
  const styled = renderStyledFileNames(pickFileNameStyle(), baseTemplateVariables);

  const resumeFileStem = ownResumeTemplate
    ? renderOutputFileNameTemplate(ownResumeTemplate, baseTemplateVariables, DEFAULT_RESUME_FILE_NAME_TEMPLATE)
    : styled.resume;
  const coverLetterFileStem = ownCoverTemplate
    ? renderOutputFileNameTemplate(ownCoverTemplate, baseTemplateVariables, DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE)
    : styled.coverLetter;
  if (!outputBaseDir) {
    throw new Error('Output base directory is not configured.');
  }

  const absoluteDir = path.join(outputBaseDir, ...relativeBase.split('/'));
  const storagePathBase = relativeBase;

  return {
    relativeBase,
    absoluteDir,
    storagePathBase,
    profileSlug,
    resumeFileStem,
    coverLetterFileStem,
    companyFolderName,
    roleSlug,
  };
}

export async function getGeneratedFilePath(relativePathValue: string): Promise<string | null> {
  const normalizedValue = relativePathValue.replace(/\\/g, '/').trim();
  if (!normalizedValue) {
    return null;
  }

  const { outputBaseDir } = await getOutputStorageSettings();
  const resolved = resolveStoredFilePath(outputBaseDir, normalizedValue);

  if (!resolved) {
    return null;
  }

  try {
    await fs.access(resolved);
    return resolved;
  } catch {
    return null;
  }
}
