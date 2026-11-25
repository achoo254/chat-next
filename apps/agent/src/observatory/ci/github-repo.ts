// The GitHub repository (`owner/repo`) a project key names, for `gh -R`.
// A project key is the session folder's origin remote as usage/repo-key.ts
// reports it: `https://github.com/owner/repo.git`, `git@github.com:owner/repo`,
// `ssh://git@github.com/owner/repo`, or already `github.com/owner/repo`.
// Anything else (another host, `local:…`, `scratch`) has none: its CI is not
// followed.

const GITHUB_REMOTE =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d{1,5})?\/|[^@/\s:]+@github\.com:|github\.com\/)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/i;

/** `owner/repo` of a GitHub project key; undefined for any other key. */
export function githubRepoOf(projectKey: string): string | undefined {
  const m = GITHUB_REMOTE.exec(projectKey.trim());
  if (!m?.[1] || !m[2]) return undefined;
  const repo = m[2].replace(/\.git$/i, "");
  if (repo === "" || repo === "." || repo === "..") return undefined;
  return `${m[1]}/${repo}`;
}
