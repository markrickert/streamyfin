/** A non-2xx answer from the GitHub REST API. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`GitHub answered ${status} for ${url}`);
  }
}

/** Calls the GitHub REST API at `path`, relative to `https://api.github.com`. */
export const github = async <T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) throw new GitHubError(response.status, url);
  return (await response.json()) as T;
};
