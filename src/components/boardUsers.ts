import type { JiraUser } from "../jira";
import { errorMessage } from "../ui";

export type MentionUsersResult = { users: JiraUser[]; warning?: string };

/** Give a nonfatal warning one visible paint before the editor takes the terminal. */
export async function waitForMentionWarningDisplay(result: MentionUsersResult): Promise<void> {
  if (result.warning) await Bun.sleep(600);
}

export function createBoardUsersLoader(
  load: (projectKey: string) => Promise<JiraUser[]>,
): (projectKey: string) => Promise<MentionUsersResult> {
  let cached: { projectKey: string; users: Promise<MentionUsersResult> } | null = null;

  return (projectKey) => {
    if (!projectKey) return Promise.resolve({ users: [] });
    if (cached?.projectKey === projectKey) return cached.users;

    const users = load(projectKey)
      .then((value) => ({ users: value }))
      .catch((error) => {
        if (cached?.users === users) cached = null;
        return {
          users: [],
          warning: `Mention suggestions could not load: ${errorMessage(error)}. Plain @text is not a Jira mention.`,
        };
      });
    cached = { projectKey, users };
    return users;
  };
}
