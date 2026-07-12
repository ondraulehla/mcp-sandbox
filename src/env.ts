/**
 * Resolves --env flags into the allowlisted environment for the sandboxed
 * server. Two forms:
 *   --env KEY=value   explicit value
 *   --env KEY         forward KEY from the local environment (must exist)
 * Nothing else crosses the boundary — the whole point of sandboxing.
 */
export function resolveEnvAllowlist(
  flags: string[],
  localEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const flag of flags) {
    const eq = flag.indexOf('=');
    if (eq > 0) {
      resolved[flag.slice(0, eq)] = flag.slice(eq + 1);
      continue;
    }
    const value = localEnv[flag];
    if (value === undefined) {
      throw new Error(`--env ${flag}: not set in the local environment`);
    }
    resolved[flag] = value;
  }
  return resolved;
}
