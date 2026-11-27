import { type Artifact, needsBuild, pickSource, type RunContext } from "./pick";

const REPO = 1000;
const FORK = 2000;

let nextId = 1;
const artifact = (
  headBranch: string,
  createdAt: string,
  overrides: Partial<Artifact> & {
    headRepositoryId?: number;
    headSha?: string;
    repositoryId?: number;
  } = {},
): Artifact => {
  const {
    headRepositoryId = REPO,
    headSha,
    repositoryId = REPO,
    ...rest
  } = overrides;
  const id = nextId++;
  return {
    id,
    name: "streamyfin-ios-phone-debug-simulator-unsigned-r1-fp-abc",
    expired: false,
    created_at: createdAt,
    expires_at: "2027-02-01T00:00:00Z",
    workflow_run: {
      id: id * 10,
      head_branch: headBranch,
      head_repository_id: headRepositoryId,
      head_sha: headSha ?? `sha-${id}`,
      repository_id: repositoryId,
    },
    ...rest,
  };
};

const ctx: RunContext = { repositoryId: REPO };

describe("pickSource local policy", () => {
  it("picks the newest non-expired artifact from any same-repo branch", () => {
    const older = artifact("develop", "2026-11-01T12:00:00Z");
    const feature = artifact("feat/other", "2026-11-05T12:00:00Z");
    expect(pickSource([older, feature], ctx, "local")).toBe(feature);
  });

  it("rejects fork artifacts under both ci and local policies", () => {
    const forkArtifact = artifact("develop", "2026-11-10T12:00:00Z", {
      headRepositoryId: FORK,
    });
    const prCtx: RunContext = {
      repositoryId: REPO,
      pullRequest: {
        headRef: "develop",
        headRepositoryId: FORK,
        commits: new Set([forkArtifact.workflow_run.head_sha]),
      },
    };
    expect(pickSource([forkArtifact], prCtx, "ci")).toBeUndefined();
    expect(pickSource([forkArtifact], ctx, "local")).toBeUndefined();
  });

  it("rejects artifacts whose workflow_run.repository_id differs from the repo under local policy", () => {
    const otherRepo = artifact("develop", "2026-11-10T12:00:00Z", {
      repositoryId: FORK,
      headRepositoryId: REPO,
    });
    expect(pickSource([otherRepo], ctx, "local")).toBeUndefined();
  });

  it("skips expired artifacts under local policy", () => {
    const expired = artifact("feat/new", "2026-11-10T12:00:00Z", {
      expired: true,
    });
    const live = artifact("feat/old", "2026-11-01T12:00:00Z");
    expect(pickSource([expired, live], ctx, "local")).toBe(live);
  });
});

describe("needsBuild", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

  it("returns true when no trusted artifact exists", () => {
    const otherPr = artifact("feat/other", "2026-11-01T00:00:00Z");
    expect(needsBuild([otherPr], ctx, now)).toBe(true);
    expect(needsBuild([], ctx, now)).toBe(true);
  });

  it("returns true when the newest trusted artifact is expired", () => {
    const expired = artifact("develop", "2026-11-01T00:00:00Z", {
      expired: true,
    });
    expect(needsBuild([expired], ctx, now)).toBe(true);
  });

  it("returns true when expires_at is missing or unparseable", () => {
    const missing = artifact("develop", "2026-10-15T00:00:00Z", {
      expires_at: undefined,
    });
    const unparseable = artifact("develop", "2026-10-15T00:00:00Z", {
      expires_at: "not-a-date",
    });
    expect(needsBuild([missing], ctx, now)).toBe(true);
    expect(needsBuild([unparseable], ctx, now)).toBe(true);
  });

  it("returns true when expires_at is less than 14 days after now", () => {
    const justUnder = new Date(now + fourteenDaysMs - 1).toISOString();
    const soon = artifact("develop", "2026-10-15T00:00:00Z", {
      expires_at: justUnder,
    });
    expect(needsBuild([soon], ctx, now)).toBe(true);
  });

  it("returns false when expires_at is at or beyond the 14-day floor", () => {
    const exactBoundary = new Date(now + fourteenDaysMs).toISOString();
    const fresh = artifact("develop", "2026-10-15T00:00:00Z", {
      expires_at: exactBoundary,
    });
    expect(needsBuild([fresh], ctx, now)).toBe(false);
  });
});
