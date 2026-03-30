#!/usr/bin/env node
import * as p from "@clack/prompts";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { stringify } from "yaml";

interface InitConfig {
  provider: "codex" | "claude";
  authMethod: "oauth" | "api_key";
  providerApiKey: string;
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  githubToken: string;
  repos: Array<{ url: string; branch: string }>;
  rules: string[];
  skills: string[];
  awsRegion: string;
  awsProfile: string;
  enableEfs: boolean;
}

const SKILL_REGISTRY: Record<string, { url: string; description: string; installMethod: "git" | "npx-skills" | "npx" }> = {
  gstack: {
    url: "https://github.com/garrytan/gstack.git",
    description: "QA, shipping, investigation, deploy, design review",
    installMethod: "git",
  },
  "frontend-design": {
    url: "anthropics/claude-code --skill frontend-design",
    description: "Production-grade UI generation, avoids default design patterns",
    installMethod: "npx-skills",
  },
  "code-reviewer": {
    url: "anthropics/claude-code --skill simplify",
    description: "Code quality review, deduplication, performance checks",
    installMethod: "npx-skills",
  },
  "antigravity-awesome-skills": {
    url: "npx antigravity-awesome-skills --claude",
    description: "1,234+ curated skills: brainstorming, architecture, debugging, API design",
    installMethod: "npx",
  },
};

function checkPrerequisites(): void {
  const missing: string[] = [];

  try {
    execSync("docker --version", { stdio: "pipe" });
  } catch {
    missing.push("docker");
  }

  try {
    execSync("aws --version", { stdio: "pipe" });
  } catch {
    missing.push("aws-cli");
  }

  try {
    execSync("git --version", { stdio: "pipe" });
  } catch {
    missing.push("git");
  }

  if (missing.length > 0) {
    p.log.error(
      `Missing prerequisites: ${missing.join(", ")}. Please install them first.`
    );
    process.exit(1);
  }
}

async function collectConfig(): Promise<InitConfig> {
  // Provider selection
  const provider = (await p.select({
    message: "Which agent engine?",
    options: [
      {
        value: "codex",
        label: "Codex (OpenAI)",
        hint: "OpenAI / ChatGPT Plus",
      },
      {
        value: "claude",
        label: "Claude Code (Anthropic)",
      },
    ],
  })) as "codex" | "claude";

  if (p.isCancel(provider)) process.exit(0);

  // Provider auth method
  const authMethod = (await p.select({
    message: "How should the agent authenticate?",
    options: [
      {
        value: "oauth",
        label: "OAuth login (recommended)",
        hint: provider === "claude"
          ? "runs 'claude login' — uses your Claude Pro/Max subscription"
          : "runs 'codex login --device-auth' — uses your OpenAI account",
      },
      {
        value: "api_key",
        label: "API key",
        hint: "pay-per-token, enter key manually",
      },
    ],
  })) as "oauth" | "api_key";

  if (p.isCancel(authMethod)) process.exit(0);

  let providerApiKey = "";
  if (authMethod === "oauth") {
    // Check if already authenticated locally
    const homeDir = process.env.HOME || "";
    const authPath = provider === "codex"
      ? `${homeDir}/.codex/auth.json`
      : `${homeDir}/.claude`;

    if (existsSync(authPath)) {
      p.log.success(
        `Found existing ${provider === "codex" ? "Codex" : "Claude Code"} credentials at ${authPath}. ` +
        `These will be uploaded to EFS during deploy.`
      );
    } else {
      // No local credentials — run auth locally (user has a TTY here)
      p.log.info(
        provider === "codex"
          ? "No Codex credentials found. Running device auth now..."
          : "No Claude Code credentials found. Running login now..."
      );
      try {
        if (provider === "codex") {
          execSync("codex login --device-auth", { stdio: "inherit", timeout: 300000 });
        } else {
          execSync("claude login", { stdio: "inherit", timeout: 300000 });
        }
        p.log.success("Authenticated! Credentials will be uploaded to EFS during deploy.");
      } catch {
        p.log.error("Auth failed. You can re-run `citio` later to try again.");
        process.exit(1);
      }
    }
  } else {
    providerApiKey = (await p.password({
      message: provider === "codex"
        ? "Enter your OpenAI API key (OPENAI_API_KEY):"
        : "Enter your Anthropic API key (ANTHROPIC_API_KEY):",
    })) as string;
    if (p.isCancel(providerApiKey)) process.exit(0);
  }

  // Slack setup
  p.log.info(
    "Create a Slack app at https://api.slack.com/apps with Socket Mode enabled.\nYou need: Bot Token (xoxb-...) and App Token (xapp-...)."
  );

  const slackBotToken = (await p.password({
    message: "Slack Bot Token (xoxb-...):",
  })) as string;
  if (p.isCancel(slackBotToken)) process.exit(0);

  const slackAppToken = (await p.password({
    message: "Slack App Token (xapp-...):",
  })) as string;
  if (p.isCancel(slackAppToken)) process.exit(0);

  const slackChannelId = (await p.text({
    message: "Slack Channel ID (e.g. C0123456789):",
    placeholder: "C0123456789",
  })) as string;
  if (p.isCancel(slackChannelId)) process.exit(0);

  // GitHub token
  p.log.info(
    "Create a fine-grained GitHub PAT at https://github.com/settings/tokens\nPermissions needed: contents:write, pull_requests:write on your repos."
  );

  const githubToken = (await p.password({
    message: "GitHub Personal Access Token:",
  })) as string;
  if (p.isCancel(githubToken)) process.exit(0);

  // Repos — fetch available repos from GitHub using the PAT
  let repos: Array<{ url: string; branch: string }> = [];
  const repoSpinner = p.spinner();
  repoSpinner.start("Fetching repos your token has access to...");

  try {
    // List repos accessible by the token (handles both classic and fine-grained PATs)
    const repoJson = execSync(
      `curl -s -H "Authorization: token ${githubToken}" "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member" 2>/dev/null`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const repoList = JSON.parse(repoJson) as Array<{ full_name: string; clone_url: string; default_branch: string; private: boolean; updated_at: string }>;

    if (Array.isArray(repoList) && repoList.length > 0) {
      repoSpinner.stop(`Found ${repoList.length} repos`);

      const selectedRepos = (await p.multiselect({
        message: "Select repos for Citio to work on (use space to select, enter to confirm):",
        options: repoList.slice(0, 50).map((r) => ({
          value: r.clone_url,
          label: r.full_name,
          hint: `${r.private ? "private" : "public"} · ${r.default_branch} · updated ${r.updated_at.split("T")[0]}`,
        })),
        required: true,
      })) as string[];

      if (p.isCancel(selectedRepos)) process.exit(0);

      repos = selectedRepos.map((url) => {
        const match = repoList.find((r) => r.clone_url === url);
        return { url, branch: match?.default_branch || "main" };
      });
    } else {
      repoSpinner.stop("No repos found (token may not have repo access)");
    }
  } catch {
    repoSpinner.stop("Could not fetch repos from GitHub");
  }

  // Fallback to manual entry if auto-fetch failed or returned nothing
  if (repos.length === 0) {
    const repoInput = (await p.text({
      message: "Repository URL(s) (comma-separated):",
      placeholder: "https://github.com/org/repo.git",
    })) as string;
    if (p.isCancel(repoInput)) process.exit(0);

    repos = repoInput.split(",").map((url) => ({
      url: url.trim(),
      branch: "main",
    }));
  }

  // Rules
  const rulesInput = (await p.text({
    message: "Agent rules (one per line, or press Enter for defaults):",
    placeholder: "Always create PRs. Never push to main.",
    defaultValue:
      "Always create PRs for code changes. Never push directly to main.\nWhen investigating bugs, check logs first before making code changes.\nReport findings back to the team with clear summaries.",
  })) as string;
  if (p.isCancel(rulesInput)) process.exit(0);

  const rules = rulesInput.split("\n").filter((r) => r.trim());

  // Skills
  const skillChoices = (await p.multiselect({
    message: "Install community skills? (use space to select, enter to confirm)",
    options: Object.entries(SKILL_REGISTRY).map(([name, info]) => ({
      value: name,
      label: name,
      hint: info.description,
    })),
    required: false,
  })) as string[];
  if (p.isCancel(skillChoices)) process.exit(0);

  // AWS config
  const awsRegion = (await p.text({
    message: "AWS Region:",
    placeholder: "us-east-1",
    defaultValue: "us-east-1",
  })) as string;
  if (p.isCancel(awsRegion)) process.exit(0);

  let awsProfile = "";
  try {
    const profiles = execSync(
      "aws configure list-profiles 2>/dev/null || echo default",
      { encoding: "utf-8" }
    )
      .trim()
      .split("\n");

    if (profiles.length > 1) {
      awsProfile = (await p.select({
        message: "AWS Profile:",
        options: profiles.map((profile) => ({
          value: profile,
          label: profile,
        })),
      })) as string;
      if (p.isCancel(awsProfile)) process.exit(0);
    } else {
      awsProfile = profiles[0];
    }
  } catch {
    awsProfile = "default";
  }

  const enableEfs = (await p.confirm({
    message: "Enable org memory (EFS volume)? Recommended for persistent learning.",
    initialValue: true,
  })) as boolean;
  if (p.isCancel(enableEfs)) process.exit(0);

  return {
    provider,
    authMethod,
    providerApiKey,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    githubToken,
    repos,
    rules,
    skills: skillChoices,
    awsRegion,
    awsProfile,
    enableEfs,
  };
}

function writeConfigFile(config: InitConfig): void {
  const yamlConfig = {
    name: "citio",
    version: 1,
    slack: {
      bot_token: "${SLACK_BOT_TOKEN}",
      app_token: "${SLACK_APP_TOKEN}",
      channel_id: config.slackChannelId,
      authorized_users: [],
    },
    engine: {
      default_provider: config.provider,
      max_session_duration_minutes: 60,
      max_concurrent_sessions: 2,
      auth_method: config.authMethod,
      providers: {
        codex: config.provider === "codex" && config.authMethod === "api_key"
          ? { api_key: "${OPENAI_API_KEY}" } : {},
        claude: config.provider === "claude" && config.authMethod === "api_key"
          ? { api_key: "${ANTHROPIC_API_KEY}" } : {},
      },
    },
    skills: {
      installed: config.skills,
      directory: "/workspace/.citio/skills/",
    },
    workspace: {
      repos: config.repos,
      rules: config.rules,
    },
    deploy: {
      provider: "aws",
      aws: {
        region: config.awsRegion,
        ecr_repo: "citio",
        ecs_cluster: "citio",
        ecs_service: "citio",
        task_cpu: 1024,
        task_memory: 4096,
        ephemeral_storage_gb: 100,
      },
    },
  };

  writeFileSync("citio.yaml", stringify(yamlConfig), "utf-8");

  // Write .env file (not committed)
  const envLines = [
    `SLACK_BOT_TOKEN=${config.slackBotToken}`,
    `SLACK_APP_TOKEN=${config.slackAppToken}`,
    `GH_TOKEN=${config.githubToken}`,
    `AWS_DEFAULT_REGION=${config.awsRegion}`,
  ];

  if (config.authMethod === "api_key" && config.providerApiKey) {
    envLines.push(
      config.provider === "codex"
        ? `OPENAI_API_KEY=${config.providerApiKey}`
        : `ANTHROPIC_API_KEY=${config.providerApiKey}`
    );
  }

  writeFileSync(".env", envLines.join("\n") + "\n", "utf-8");
}

function installSkills(skills: string[], githubToken: string): void {
  if (skills.length === 0) return;

  const skillsDir = ".citio/skills";
  mkdirSync(skillsDir, { recursive: true });

  const env = {
    ...process.env,
    GH_TOKEN: githubToken,
    GIT_ASKPASS: "echo",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const skill of skills) {
    const info = SKILL_REGISTRY[skill];
    if (!info) continue;

    p.log.step(`Installing skill: ${skill}`);

    try {
      if (info.installMethod === "git") {
        const skillPath = `${skillsDir}/${skill}`;
        if (existsSync(skillPath)) {
          execSync(`git -C "${skillPath}" pull --ff-only`, { stdio: "pipe", env });
        } else {
          const authedUrl = githubToken
            ? info.url.replace("https://github.com/", `https://${githubToken}@github.com/`)
            : info.url;
          execSync(`git clone --depth 1 "${authedUrl}" "${skillPath}"`, {
            stdio: "pipe",
            env,
          });
        }
      } else if (info.installMethod === "npx-skills") {
        // Uses `npx skills add <source>` — the official skill installer
        execSync(`npx skills add ${info.url}`, {
          stdio: "pipe",
          env,
          timeout: 120000,
        });
      } else if (info.installMethod === "npx") {
        // Direct npx command
        execSync(info.url, {
          stdio: "pipe",
          env,
          timeout: 120000,
        });
      }
      p.log.success(`Installed ${skill}`);
    } catch {
      p.log.warn(
        `Failed to install ${skill}. You can install it manually later.`
      );
    }
  }
}

async function deployToAws(config: InitConfig): Promise<void> {
  const s = p.spinner();
  const profileFlag = config.awsProfile
    ? `--profile ${config.awsProfile}`
    : "";
  const region = config.awsRegion;

  // All build/docker commands must run from the Citio project directory
  const projectDir = path.resolve(
    new URL(".", import.meta.url).pathname, "..", ".."
  );

  // 1. Get account ID
  s.start("Getting AWS account info...");
  const accountId = execSync(
    `aws sts get-caller-identity --query Account --output text ${profileFlag}`,
    { encoding: "utf-8" }
  ).trim();
  s.stop(`AWS Account: ${accountId}`);

  // 2. Create ECR repository
  s.start("Creating ECR repository...");
  try {
    execSync(
      `aws ecr create-repository --repository-name citio --region ${region} ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
  } catch {
    // Already exists
  }
  const ecrUri = `${accountId}.dkr.ecr.${region}.amazonaws.com/citio`;
  s.stop(`ECR: ${ecrUri}`);

  // 3. Build and push Docker image
  s.start("Building Docker image...");
  execSync("npm run build", { stdio: "pipe", cwd: projectDir });

  // Auth is handled at RUNTIME via env vars in the ECS task definition,
  // never baked into the Docker image.

  // Build for linux/amd64 (ECS Fargate requires it, even if building on ARM Mac)
  execSync("docker build --platform linux/amd64 -t citio:latest .", {
    stdio: "pipe",
    timeout: 600000,
    cwd: projectDir,
  });

  s.stop("Docker image built");

  s.start("Pushing to ECR...");
  execSync(
    `aws ecr get-login-password --region ${region} ${profileFlag} | docker login --username AWS --password-stdin ${accountId}.dkr.ecr.${region}.amazonaws.com`,
    { stdio: "pipe" }
  );
  execSync(`docker tag citio:latest ${ecrUri}:latest`, { stdio: "pipe" });
  execSync(`docker push ${ecrUri}:latest`, { stdio: "pipe", timeout: 600000 });
  s.stop("Image pushed to ECR");

  // 4. Create ECS cluster
  s.start("Setting up ECS cluster...");
  try {
    execSync(
      `aws ecs create-cluster --cluster-name citio --region ${region} ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
  } catch {
    // Already exists
  }
  s.stop("ECS cluster ready");

  // 5. Create EFS if enabled
  let efsId = "";
  if (config.enableEfs) {
    s.start("Creating EFS filesystem for org memory...");
    try {
      const efsResult = execSync(
        `aws efs create-file-system --creation-token citio-memory --region ${region} ${profileFlag} --output json`,
        { encoding: "utf-8" }
      );
      const efsData = JSON.parse(efsResult);
      efsId = efsData.FileSystemId;
      s.stop(`EFS created: ${efsId}`);
    } catch {
      s.stop("EFS already exists or creation failed. Continuing without EFS.");
    }
  }

  // 6. Create task execution role
  s.start("Setting up IAM roles...");
  const trustPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ecs-tasks.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });

  try {
    execSync(
      `aws iam create-role --role-name citio-task-execution --assume-role-policy-document '${trustPolicy}' ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
    execSync(
      `aws iam attach-role-policy --role-name citio-task-execution --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
    // Add CloudWatch Logs permissions (needed for awslogs-create-group)
    const logsPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        Resource: "arn:aws:logs:*:*:*"
      }]
    });
    execSync(
      `aws iam put-role-policy --role-name citio-task-execution --policy-name citio-logs --policy-document '${logsPolicy}' ${profileFlag} 2>/dev/null || true`,
      { encoding: "utf-8" }
    );
  } catch {
    // Roles may already exist
  }
  s.stop("IAM roles configured");

  // 7. Register task definition
  s.start("Registering ECS task definition...");
  const envVars = [
    { name: "SLACK_BOT_TOKEN", value: config.slackBotToken },
    { name: "SLACK_APP_TOKEN", value: config.slackAppToken },
    { name: "GH_TOKEN", value: config.githubToken },
    { name: "HOME", value: "/home/citio" },
  ];

  // Embed config as base64 so it doesn't need a file mount
  const configYaml = readFileSync("citio.yaml", "utf-8");
  const configB64 = Buffer.from(configYaml).toString("base64");
  envVars.push({ name: "CITIO_CONFIG_B64", value: configB64 });

  if (config.authMethod === "api_key" && config.providerApiKey) {
    if (config.provider === "codex") {
      envVars.push({ name: "OPENAI_API_KEY", value: config.providerApiKey });
    } else {
      envVars.push({ name: "ANTHROPIC_API_KEY", value: config.providerApiKey });
    }
  } else if (config.authMethod === "oauth") {
    // OAuth: credentials uploaded to EFS after deploy (see post-deploy section below)
    // No CITIO_NEEDS_AUTH — container doesn't do interactive auth
  }

  const homeVolume = config.authMethod === "oauth"
    ? {
        name: "citio-home",
        efsVolumeConfiguration: {
          fileSystemId: efsId || "<EFS_ID>",
          rootDirectory: "/",
          transitEncryption: "ENABLED",
        },
      }
    : null;

  const taskDef = {
    family: "citio",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "4096",
    ephemeralStorage: { sizeInGiB: 100 },
    executionRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
    taskRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
    volumes: homeVolume ? [homeVolume] : undefined,
    containerDefinitions: [
      {
        name: "citio",
        image: `${ecrUri}:latest`,
        essential: true,
        portMappings: [{ containerPort: 3001, protocol: "tcp" }],
        environment: envVars,
        mountPoints: homeVolume
          ? [{ sourceVolume: "citio-home", containerPath: "/home/citio", readOnly: false }]
          : undefined,
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": "/ecs/citio",
            "awslogs-region": region,
            "awslogs-stream-prefix": "ecs",
            "awslogs-create-group": "true",
          },
        },
        healthCheck: {
          command: [
            "CMD-SHELL",
            "curl -f http://localhost:3001/healthz || exit 1",
          ],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 30,
        },
        stopTimeout: 60,
      },
    ],
  };

  const taskDefPath = "/tmp/citio-task-def.json";
  writeFileSync(taskDefPath, JSON.stringify(taskDef, null, 2));
  execSync(
    `aws ecs register-task-definition --cli-input-json file://${taskDefPath} --region ${region} ${profileFlag}`,
    { stdio: "pipe" }
  );
  s.stop("Task definition registered");

  // 8. Get default VPC and subnets
  s.start("Configuring networking...");
  let subnetId: string;
  let sgId: string;

  try {
    const vpcId = execSync(
      `aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0].VpcId" --output text --region ${region} ${profileFlag}`,
      { encoding: "utf-8" }
    ).trim();

    subnetId = execSync(
      `aws ec2 describe-subnets --filters "Name=vpc-id,Values=${vpcId}" --query "Subnets[0].SubnetId" --output text --region ${region} ${profileFlag}`,
      { encoding: "utf-8" }
    ).trim();

    // Create security group
    try {
      const sgResult = execSync(
        `aws ec2 create-security-group --group-name citio-sg --description "Citio agent - outbound only" --vpc-id ${vpcId} --region ${region} ${profileFlag} --output text --query GroupId`,
        { encoding: "utf-8" }
      ).trim();
      sgId = sgResult;
    } catch {
      sgId = execSync(
        `aws ec2 describe-security-groups --filters "Name=group-name,Values=citio-sg" --query "SecurityGroups[0].GroupId" --output text --region ${region} ${profileFlag}`,
        { encoding: "utf-8" }
      ).trim();
    }
  } catch (err) {
    s.stop("Failed to configure networking. Using defaults.");
    p.log.error(
      `Networking error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
  s.stop("Networking configured");

  // 9. Create/update ECS service
  s.start("Deploying ECS service...");
  try {
    execSync(
      `aws ecs create-service \
        --cluster citio \
        --service-name citio \
        --task-definition citio \
        --desired-count 1 \
        --launch-type FARGATE \
        --network-configuration "awsvpcConfiguration={subnets=[${subnetId}],securityGroups=[${sgId}],assignPublicIp=ENABLED}" \
        --region ${region} ${profileFlag}`,
      { stdio: "pipe" }
    );
  } catch {
    // Service may already exist, update it
    execSync(
      `aws ecs update-service \
        --cluster citio \
        --service citio \
        --task-definition citio \
        --force-new-deployment \
        --region ${region} ${profileFlag}`,
      { stdio: "pipe" }
    );
  }
  s.stop("ECS service deployed!");

  p.log.success("ECS service deployed!");

  // Post-deploy: upload local OAuth credentials to EFS via one-off Alpine task
  if (config.authMethod === "oauth") {
    const homeDir = process.env.HOME || "";
    const localAuthPath = config.provider === "codex"
      ? `${homeDir}/.codex/auth.json`
      : `${homeDir}/.claude`;

    if (existsSync(localAuthPath)) {
      s.start("Uploading credentials to EFS...");
      try {
        const svcSubnet = execSync(
          `aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag} --query 'services[0].networkConfiguration.awsvpcConfiguration.subnets[0]' --output text`,
          { encoding: "utf-8", stdio: "pipe" }
        ).trim();
        const svcSg = execSync(
          `aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag} --query 'services[0].networkConfiguration.awsvpcConfiguration.securityGroups[0]' --output text`,
          { encoding: "utf-8", stdio: "pipe" }
        ).trim();

        let authB64: string;
        let destPath: string;
        if (config.provider === "codex") {
          authB64 = Buffer.from(readFileSync(`${homeDir}/.codex/auth.json`, "utf-8")).toString("base64");
          destPath = ".codex/auth.json";
        } else {
          // Claude: find main credential file
          const credFiles = execSync(`find "${homeDir}/.claude" -maxdepth 1 -type f 2>/dev/null`, { encoding: "utf-8", stdio: "pipe" }).trim().split("\n").filter(Boolean);
          const mainCred = credFiles[0] || `${homeDir}/.claude/credentials.json`;
          authB64 = Buffer.from(readFileSync(mainCred, "utf-8")).toString("base64");
          destPath = `.claude/${mainCred.split("/").pop()}`;
        }

        const destDir = destPath.split("/").slice(0, -1).join("/");
        const efsTaskDef = JSON.stringify({
          family: "citio-auth-setup",
          networkMode: "awsvpc",
          requiresCompatibilities: ["FARGATE"],
          cpu: "256", memory: "512",
          executionRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
          taskRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
          volumes: [{ name: "citio-home", efsVolumeConfiguration: { fileSystemId: efsId || "<EFS_ID>", rootDirectory: "/", transitEncryption: "ENABLED" } }],
          containerDefinitions: [{ name: "auth-setup", image: "alpine:latest", essential: true,
            command: ["sh", "-c", `mkdir -p /efs/${destDir} && echo '${authB64}' | base64 -d > /efs/${destPath} && chmod 600 /efs/${destPath} && echo AUTH_OK`],
            mountPoints: [{ sourceVolume: "citio-home", containerPath: "/efs", readOnly: false }],
            logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": "/ecs/citio", "awslogs-region": region, "awslogs-stream-prefix": "auth-setup", "awslogs-create-group": "true" } }
          }]
        });

        writeFileSync("/tmp/citio-auth-task.json", efsTaskDef);
        const authRev = execSync(`aws ecs register-task-definition --cli-input-json file:///tmp/citio-auth-task.json --region ${region} ${profileFlag} --query 'taskDefinition.revision' --output text`, { encoding: "utf-8", stdio: "pipe" }).trim();
        const authTaskArn = execSync(`aws ecs run-task --cluster citio --task-definition "citio-auth-setup:${authRev}" --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${svcSubnet}],securityGroups=[${svcSg}],assignPublicIp=ENABLED}" --region ${region} ${profileFlag} --query 'tasks[0].taskArn' --output text`, { encoding: "utf-8", stdio: "pipe" }).trim();

        // Wait for completion
        for (let i = 0; i < 12; i++) {
          execSync("sleep 10", { stdio: "pipe" });
          const status = execSync(`aws ecs describe-tasks --cluster citio --tasks "${authTaskArn}" --region ${region} ${profileFlag} --query 'tasks[0].lastStatus' --output text`, { encoding: "utf-8", stdio: "pipe" }).trim();
          if (status === "STOPPED") {
            const code = execSync(`aws ecs describe-tasks --cluster citio --tasks "${authTaskArn}" --region ${region} ${profileFlag} --query 'tasks[0].containers[0].exitCode' --output text`, { encoding: "utf-8", stdio: "pipe" }).trim();
            s.stop(code === "0" ? "Credentials uploaded to EFS!" : "Credential upload may have failed.");
            break;
          }
        }

        // Restart main service to pick up credentials
        execSync(`aws ecs update-service --cluster citio --service citio --force-new-deployment --region ${region} ${profileFlag}`, { stdio: "pipe" });
      } catch (err) {
        s.stop("Could not upload credentials.");
        p.log.warn(`Set ${config.provider === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} env var as fallback.`);
      }
    }
  }

  // Post-deploy verification
  const verifyS = p.spinner();
  verifyS.start("Waiting for ECS service to stabilize...");

  let serviceHealthy = false;
  const maxRetries = 12; // 12 x 15s = 3 minutes
  for (let i = 0; i < maxRetries; i++) {
    try {
      const serviceJson = execSync(
        `aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag} --query 'services[0].{status:status,running:runningCount,desired:desiredCount,events:events[0].message}' --output json`,
        { encoding: "utf-8", stdio: "pipe" }
      );
      const svc = JSON.parse(serviceJson);

      if (svc.running >= svc.desired && svc.running > 0) {
        serviceHealthy = true;
        break;
      }

      // Show what's happening
      verifyS.message(`Task status: ${svc.running}/${svc.desired} running. ${svc.events || "Starting..."}`);
    } catch {
      // Service might not be queryable yet
    }

    // Wait 15 seconds before checking again
    execSync("sleep 15", { stdio: "pipe" });
  }

  if (serviceHealthy) {
    verifyS.stop("ECS service is running!");
  } else {
    verifyS.stop("ECS service not yet healthy.");

    // Check for errors in logs
    p.log.warn("The service may still be starting. Checking logs for errors...");
    try {
      const logs = execSync(
        `aws logs filter-log-events --log-group-name /ecs/citio --region ${region} ${profileFlag} --limit 10 --query 'events[].message' --output text 2>/dev/null`,
        { encoding: "utf-8", stdio: "pipe", timeout: 15000 }
      );
      if (logs.trim()) {
        p.log.info("Recent logs:\n" + logs.trim());
      }
    } catch {
      p.log.info("No logs available yet (log group may not exist until the task runs).");
    }

    // Check the task's stopped reason
    try {
      const stoppedReason = execSync(
        `aws ecs describe-tasks --cluster citio --tasks $(aws ecs list-tasks --cluster citio --service-name citio --desired-status STOPPED --region ${region} ${profileFlag} --query 'taskArns[0]' --output text 2>/dev/null) --region ${region} ${profileFlag} --query 'tasks[0].stoppedReason' --output text 2>/dev/null`,
        { encoding: "utf-8", stdio: "pipe", timeout: 15000 }
      ).trim();
      if (stoppedReason && stoppedReason !== "None") {
        p.log.error(`Task stopped: ${stoppedReason}`);
      }
    } catch {
      // No stopped tasks to inspect
    }
  }

  // Codex device auth relay
  if (config.authMethod === "oauth" && config.provider === "codex" && serviceHealthy) {
    p.log.info("\nCodex needs device auth. Tailing logs for the auth URL...");
    p.log.info("Look for a URL like https://login.openai.com/device and a code.");
    p.log.info("Press Ctrl+C once you've completed auth in your browser.\n");
    try {
      execSync(
        `aws logs tail /ecs/citio --region ${region} ${profileFlag} --follow --since 2m`,
        { stdio: "inherit", timeout: 180000 }
      );
    } catch {
      // Ctrl+C throws, that's expected
    }
  }

  // Final status
  p.log.success(serviceHealthy ? "\nCitio is live!" : "\nDeployment started.");
  p.log.info(
    `Monitor:  aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag}` +
    `\nLogs:     aws logs tail /ecs/citio --region ${region} ${profileFlag} --follow` +
    `\nHealth:   Check the task's public IP on port 3001/healthz`
  );
}

async function main(): Promise<void> {
  p.intro("Welcome to Citio - Autonomous CTO Agent");

  checkPrerequisites();

  const config = await collectConfig();

  const s = p.spinner();

  // Write config files
  s.start("Writing configuration...");
  writeConfigFile(config);
  s.stop("Configuration saved to citio.yaml and .env");

  // Install skills
  if (config.skills.length > 0) {
    installSkills(config.skills, config.githubToken);
  }

  // Deploy
  const shouldDeploy = (await p.confirm({
    message: "Deploy to AWS now?",
    initialValue: true,
  })) as boolean;

  if (p.isCancel(shouldDeploy)) process.exit(0);

  if (shouldDeploy) {
    await deployToAws(config);
  } else {
    const authMount = config.authMethod === "oauth"
      ? config.provider === "claude"
        ? " -v ~/.claude:/home/citio/.claude:ro"
        : " -v ~/.codex/auth.json:/home/citio/.codex/auth.json:ro"
      : "";
    p.log.info(
      `Skipping deploy. Run manually with:\n  docker build -t citio . && docker run --env-file .env${authMount} citio`
    );
  }

  p.outro("Citio is ready! Send a message in your Slack channel to test.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
