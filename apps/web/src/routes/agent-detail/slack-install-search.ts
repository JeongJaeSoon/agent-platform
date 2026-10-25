export function slackInstallSearch(search: Record<string, unknown>) {
  return {
    state: typeof search.state === "string" ? search.state : "",
    code: typeof search.code === "string" ? search.code : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  };
}
