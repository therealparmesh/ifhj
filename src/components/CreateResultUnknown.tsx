import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";

import { useDimensions } from "../hooks";
import { useInput } from "../input";
import { errorMessage, openInBrowser, theme, truncate } from "../ui";
import { ErrorMessage } from "./ErrorMessage";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";

function projectIssuesUrl(server: string, projectKey: string): string {
  const escapedProject = projectKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const jql = `project = "${escapedProject}" ORDER BY created DESC`;
  return `${server}/issues/?jql=${encodeURIComponent(jql)}`;
}

export function CreateResultUnknown({
  server,
  projectKey,
  title,
  onClose,
}: {
  server: string;
  projectKey: string;
  title: string;
  onClose: () => void;
}) {
  const { cols } = useDimensions();
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const openingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (input !== "o" || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    setStatus(null);
    void openInBrowser(projectIssuesUrl(server, projectKey))
      .then(() => {
        if (mountedRef.current) setStatus("Opened recent project issues.");
        return undefined;
      })
      .catch((error) => {
        if (mountedRef.current) setStatus(`Could not open Jira: ${errorMessage(error)}`);
      })
      .finally(() => {
        openingRef.current = false;
        if (mountedRef.current) setOpening(false);
      });
  });

  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.warning}>
      <Text color={theme.warning} bold>
        Create accepted · issue key unavailable
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Jira accepted the request, but its issue key is unavailable.</Text>
        <Text color={theme.muted}>Do not submit it again from this screen.</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.accent}>Project · {projectKey}</Text>
        <Text wrap="truncate">Title · {truncate(title, Math.max(1, cols - 12))}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>Review recent project issues in Jira before trying again.</Text>
      </Box>
      {opening ? <LoadingLine label="Opening recent project issues…" /> : null}
      {status ? (
        status.startsWith("Could not") ? (
          <ErrorMessage message={status} width={Math.max(1, cols - 6)} />
        ) : (
          <Text color={theme.success}>{status}</Text>
        )
      ) : null}
      <Box marginTop={1}>
        {!opening ? <Hint k="o" label="review recent issues" /> : null}
        <Hint k="esc" label="close" />
      </Box>
    </Box>
  );
}
