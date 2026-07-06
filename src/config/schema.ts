import { z } from "zod";

export const ProviderConfigSchema = z.object({
  api_key: z.string().optional(),
  // Optional model override (CODEX_MODEL / CLAUDE_MODEL equivalents).
  model: z.string().optional(),
  // Codex only: model_reasoning_effort for `codex exec` (default "low" at runtime).
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

export const CitioConfigSchema = z.object({
  name: z.string().default("citio"),
  version: z.number().default(1),

  slack: z.object({
    bot_token: z.string(),
    app_token: z.string(),
    channel_id: z.string().optional(),
    // Ambient mode: answer plain (unmentioned) messages in channel_id,
    // skipping messages that @mention someone else. Default on.
    respond_without_mention: z.boolean().default(true),
    authorized_users: z.array(z.string()).default([]),  // who can @mention in channels (empty = all)
    admin_users: z.array(z.string()).default([]),        // who can DM the bot (empty = all)
  }),

  engine: z.object({
    default_provider: z.enum(["codex", "claude"]).default("codex"),
    max_session_duration_minutes: z.number().default(60),
    max_concurrent_sessions: z.number().default(1),
    providers: z.object({
      codex: ProviderConfigSchema.optional(),
      claude: ProviderConfigSchema.optional(),
    }),
  }),

  skills: z
    .object({
      installed: z.array(z.string()).default([]),
      directory: z.string().default("/workspace/.citio/skills/"),
    })
    .default({ installed: [], directory: "/workspace/.citio/skills/" }),

  workspace: z.object({
    repos: z.array(
      z.object({
        url: z.string(),
        branch: z.string().default("main"),
      })
    ),
    rules: z.array(z.string()).default([]),
    git: z.object({
      user_name: z.string().default("Citio"),
      user_email: z.string().optional(),
    }).default({ user_name: "Citio" }),
  }),

  deploy: z
    .object({
      provider: z.enum(["aws"]).default("aws"),
      aws: z
        .object({
          region: z.string().default("us-east-1"),
          ecr_repo: z.string().default("citio"),
          ecs_cluster: z.string().default("default"),
          ecs_service: z.string().default("citio"),
          task_cpu: z.number().default(2048),
          task_memory: z.number().default(8192),
          ephemeral_storage_gb: z.number().default(100),
        })
        .optional(),
    })
    .optional(),
});

export type CitioConfig = z.infer<typeof CitioConfigSchema>;
