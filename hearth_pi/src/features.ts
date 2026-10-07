// Exact opt-in only: absent, false, 0 and misspelled values stay disabled.
// HA's typed App option supplies the fallback because Supervisor does not
// expose arbitrary operator environment variables in its Configuration UI.
export function anthropicAuthEnabled(
  option = false,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.HEARTH_ANTHROPIC_AUTH_ENABLED === undefined
    ? option
    : env.HEARTH_ANTHROPIC_AUTH_ENABLED === "true";
}
