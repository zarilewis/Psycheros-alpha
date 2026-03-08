/**
 * Initialization module for Psycheros
 *
 * Handles setup of user data directories from templates on first run.
 * Ensures fresh installations have the necessary identity file structure.
 */

import { join } from "@std/path";

const IDENTITY_SUBDIRS = ["self", "user", "relationship", "custom"] as const;

/**
 * Check if a directory is empty (contains no files, only . and ..)
 */
async function isDirectoryEmpty(dirPath: string): Promise<boolean> {
  try {
    const entries = [];
    for await (const entry of Deno.readDir(dirPath)) {
      // Skip .snapshots directory and hidden files
      if (entry.name === ".snapshots" || entry.name.startsWith(".")) {
        continue;
      }
      entries.push(entry);
    }
    return entries.length === 0;
  } catch {
    // Directory doesn't exist, consider it empty
    return true;
  }
}

/**
 * Ensure a directory exists, creating it if necessary
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await Deno.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) {
      throw error;
    }
  }
}

/**
 * Copy all files from a template directory to a target directory
 * Only copies if target directory is empty
 */
async function copyTemplateFiles(
  templateDir: string,
  targetDir: string,
): Promise<{ copied: number; skipped: boolean }> {
  // Check if target is empty
  if (!(await isDirectoryEmpty(targetDir))) {
    return { copied: 0, skipped: true };
  }

  // Ensure target directory exists
  await ensureDir(targetDir);

  let copied = 0;

  try {
    for await (const entry of Deno.readDir(templateDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        const srcPath = join(templateDir, entry.name);
        const destPath = join(targetDir, entry.name);

        // Read template and write to target
        const content = await Deno.readTextFile(srcPath);
        await Deno.writeTextFile(destPath, content);
        copied++;
      }
    }
  } catch (error) {
    // Template directory doesn't exist, skip silently
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`[Init] Error copying from ${templateDir}:`, error);
    }
  }

  return { copied, skipped: false };
}

/**
 * Initialize identity directories from templates
 *
 * For each subdirectory (self, user, relationship, custom):
 * - If the directory is empty, copy template files into it
 * - If the directory has files, leave it untouched (user data exists)
 *
 * This allows fresh installations to start with default identity files,
 * while preserving any existing user data.
 */
export async function initializeFromTemplates(
  projectRoot: string,
): Promise<void> {
  const templatesDir = join(projectRoot, "templates", "identity");
  const identityDir = join(projectRoot, "identity");

  let totalCopied = 0;

  for (const subdir of IDENTITY_SUBDIRS) {
    const templatePath = join(templatesDir, subdir);
    const targetPath = join(identityDir, subdir);

    const result = await copyTemplateFiles(templatePath, targetPath);

    if (result.skipped) {
      console.log(`[Init] identity/${subdir}/ already has files, skipping`);
    } else if (result.copied > 0) {
      console.log(
        `[Init] Copied ${result.copied} file(s) to identity/${subdir}/`,
      );
      totalCopied += result.copied;
    }
  }

  if (totalCopied > 0) {
    console.log(`[Init] Initialized ${totalCopied} identity file(s) from templates`);
  }
}

/**
 * Run all initialization tasks
 */
export async function initialize(projectRoot: string): Promise<void> {
  await initializeFromTemplates(projectRoot);
}
