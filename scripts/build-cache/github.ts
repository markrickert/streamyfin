/** Shared GitHub Actions API helpers for build-cache and CI scripts. */
import type { Artifact } from "./pick";

const PER_PAGE = 100;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const githubHeaders = (token: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

/** Fetches JSON from the GitHub REST API, throwing on non-2xx responses. */
export const githubJson = async <T>(
  url: string,
  token: string,
  fetchFn: FetchLike = fetch,
): Promise<T> => {
  const response = await fetchFn(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
};

/** Lists all matching GitHub Actions artifacts across pages. */
export const listArtifacts = async (
  repository: string,
  name: string,
  token: string,
  fetchFn: FetchLike = fetch,
): Promise<Artifact[]> => {
  const artifacts: Artifact[] = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (artifacts.length < total) {
    const body = await githubJson<{
      total_count: number;
      artifacts: Artifact[];
    }>(
      `https://api.github.com/repos/${repository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=${PER_PAGE}&page=${page}`,
      token,
      fetchFn,
    );
    total = body.total_count;
    artifacts.push(...body.artifacts);
    if (body.artifacts.length < PER_PAGE) break;
    page += 1;
  }
  return artifacts;
};

/** Fetches all commit SHAs belonging to a pull request. */
export const fetchPullRequestCommits = async (
  repository: string,
  prNumber: number,
  token: string,
  fetchFn: FetchLike = fetch,
): Promise<Set<string>> => {
  const commits = new Set<string>();
  let page = 1;
  for (;;) {
    const body = await githubJson<{ sha: string }[]>(
      `https://api.github.com/repos/${repository}/pulls/${prNumber}/commits?per_page=${PER_PAGE}&page=${page}`,
      token,
      fetchFn,
    );
    for (const commit of body) commits.add(commit.sha);
    if (body.length < PER_PAGE) return commits;
    page += 1;
  }
};
