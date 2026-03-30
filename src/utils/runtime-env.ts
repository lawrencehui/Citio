const TASK_ROLE_ENV_KEYS = [
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

export function pickDefinedEnv(keys: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};

  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      picked[key] = value;
    }
  }

  return picked;
}

export function getTaskRoleEnv(): Record<string, string> {
  return pickDefinedEnv(TASK_ROLE_ENV_KEYS);
}
