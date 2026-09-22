import type { JiraUser } from "../jira";

export function createBoardUsersLoader(
  load: (projectKey: string) => Promise<JiraUser[]>,
): (projectKey: string) => Promise<JiraUser[]> {
  let cached: { projectKey: string; users: Promise<JiraUser[]> } | null = null;

  return (projectKey) => {
    if (!projectKey) return Promise.resolve([]);
    if (cached?.projectKey === projectKey) return cached.users;

    const users = load(projectKey).catch(() => {
      if (cached?.users === users) cached = null;
      return [];
    });
    cached = { projectKey, users };
    return users;
  };
}
