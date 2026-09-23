import { Box, Text } from "ink";
import { useState } from "react";

import { useInput } from "../input";
import { errorMessage, openInBrowser, theme } from "../ui";

export function UnsupportedAdfEdit({
  server,
  issueKey,
  message,
  onClose,
}: {
  server: string;
  issueKey: string;
  message: string;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  useInput((input, key) => {
    if (key.escape || input === "q") return onClose();
    if (key.return || input === "o") {
      void openInBrowser(`${server}/browse/${issueKey}`).catch((reason) =>
        setError(errorMessage(reason)),
      );
    }
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.warning}>
        Rich text needs Jira
      </Text>
      <Text>{message}</Text>
      {error ? <Text color={theme.error}>{error}</Text> : null}
      <Text color={theme.muted}>Enter/o open {issueKey} in browser · Esc back</Text>
    </Box>
  );
}
