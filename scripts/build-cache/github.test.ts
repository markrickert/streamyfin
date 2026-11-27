import {
  type FetchLike,
  fetchPullRequestCommits,
  githubJson,
  listArtifacts,
} from "./github";
import type { Artifact } from "./pick";

const makeArtifact = (id: number): Artifact => ({
  id,
  name: "test-artifact",
  expired: false,
  created_at: "2026-11-20T00:00:00Z",
  workflow_run: {
    id: 100 + id,
    head_branch: "develop",
    head_repository_id: 1,
    head_sha: `sha-${id}`,
    repository_id: 1,
  },
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("github API helpers", () => {
  it("stops after one request on a short first page (fewer than 100) even when total_count is larger", async () => {
    let requests = 0;
    const fetchFn: FetchLike = async () => {
      requests += 1;
      return jsonResponse({
        total_count: 500,
        artifacts: Array.from({ length: 42 }, (_, i) => makeArtifact(i)),
      });
    };

    const artifacts = await listArtifacts(
      "owner/repo",
      "test-artifact",
      "token",
      fetchFn,
    );
    expect(requests).toBe(1);
    expect(artifacts).toHaveLength(42);
  });

  it("makes no second request for exactly 100 items with total_count: 100", async () => {
    let requests = 0;
    const fetchFn: FetchLike = async () => {
      requests += 1;
      if (requests > 1) {
        throw new Error("Unexpected second request");
      }
      return jsonResponse({
        total_count: 100,
        artifacts: Array.from({ length: 100 }, (_, i) => makeArtifact(i)),
      });
    };

    const artifacts = await listArtifacts(
      "owner/repo",
      "test-artifact",
      "token",
      fetchFn,
    );
    expect(requests).toBe(1);
    expect(artifacts).toHaveLength(100);
  });

  it("makes exactly two requests and returns 101 artifacts for 100 items, then 1 item with total_count: 101", async () => {
    let requests = 0;
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests += 1;
      urls.push(url);
      if (requests === 1) {
        return jsonResponse({
          total_count: 101,
          artifacts: Array.from({ length: 100 }, (_, i) => makeArtifact(i)),
        });
      }
      return jsonResponse({
        total_count: 101,
        artifacts: [makeArtifact(100)],
      });
    };

    const artifacts = await listArtifacts(
      "owner/repo",
      "test-artifact",
      "token",
      fetchFn,
    );
    expect(requests).toBe(2);
    expect(artifacts).toHaveLength(101);
    expect(urls[0]).toContain("page=1");
    expect(urls[1]).toContain("page=2");
  });

  it("pages twice (100, then 3) and returns all 103 SHAs for pull request commits listing", async () => {
    let requests = 0;
    const urls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests += 1;
      urls.push(url);
      if (requests === 1) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, i) => ({ sha: `commit-${i}` })),
        );
      }
      return jsonResponse([
        { sha: "commit-100" },
        { sha: "commit-101" },
        { sha: "commit-102" },
      ]);
    };

    const commits = await fetchPullRequestCommits(
      "owner/repo",
      42,
      "token",
      fetchFn,
    );
    expect(requests).toBe(2);
    expect(commits.size).toBe(103);
    expect(commits.has("commit-0")).toBe(true);
    expect(commits.has("commit-99")).toBe(true);
    expect(commits.has("commit-100")).toBe(true);
    expect(commits.has("commit-102")).toBe(true);
    expect(urls[0]).toContain("page=1");
    expect(urls[1]).toContain("page=2");
  });

  it("throws with the status in the message on a non-2xx answer", async () => {
    const fetchFn: FetchLike = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    await expect(
      listArtifacts("owner/repo", "test-artifact", "token", fetchFn),
    ).rejects.toThrow(
      "GitHub answered 404 for https://api.github.com/repos/owner/repo/actions/artifacts?name=test-artifact&per_page=100&page=1",
    );

    await expect(
      githubJson("https://api.github.com/test", "token", fetchFn),
    ).rejects.toThrow("GitHub answered 404 for https://api.github.com/test");
  });
});
