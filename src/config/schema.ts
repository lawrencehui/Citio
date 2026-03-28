import { z } from "zod";

export const ProviderConfigSchema = z.object({
  api_key: z.string().optional(),
});

export const CitioConfigSchema = z.object({
  name: z.string().default("citio"),
  version: z.number().default(1),

  slack: z.object({
    bot_token: z.string(),
    app_token: z.string(),
    channel_id: z.string(),
    authorized_users: z.array(z.string()).default([]),
  }),

  engine: z.object({
    default_provider: z.enum(["codex", "claude"]).default("codex"),
    max_session_duration_minutes: z.number().default(60),
    max_concurrent_sessions: z.number().default(2),
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
