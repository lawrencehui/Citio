#!/usr/bin/env node
import * as p from "@clack/prompts";
import { execSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync } from "fs";
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
  "excalidraw-diagrams": {
    url: "https://github.com/coleam00/excalidraw-diagram-skill.git",
    description: "Architecture diagrams from natural language",
    installMethod: "git",
  },
  "shannon-security": {
    url: "https://github.com/unicodeveloper/shannon.git",
    description: "Autonomous pen testing, 96% exploit success rate",
    installMethod: "git",
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
        hint: "recommended",
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
    const s = p.spinner();
    s.start(`Authenticating ${provider === "claude" ? "Claude Code" : "Codex"}...`);
    try {
      if (provider === "claude") {
        // Check if already logged in
        try {
          execSync("claude -p 'test' --output-format text 2>/dev/null", { timeout: 15000, stdio: "pipe" });
          s.stop("Claude Code already authenticated.");
        } catch {
          s.stop("Opening browser for Claude login...");
          p.log.info("Please complete the login in your browser. The container will use the credentials from ~/.claude/");
          execSync("claude login", { stdio: "inherit", timeout: 120000 });
        }
      } else {
        try {
          execSync("codex --version 2>/dev/null", { timeout: 5000, stdio: "pipe" });
          s.stop("Opening Codex device auth...");
          p.log.info("Complete the device auth in your browser.");
          execSync("codex login --device-auth", { stdio: "inherit", timeout: 120000 });
        } catch {
          s.stop("Codex CLI not found. Install with: npm install -g @openai/codex");
          process.exit(1);
        }
      }
    } catch (err) {
      s.stop("Auth failed — falling back to API key.");
      providerApiKey = (await p.password({
        message: provider === "codex"
          ? "Enter your OpenAI API key (OPENAI_API_KEY):"
          : "Enter your Anthropic API key (ANTHROPIC_API_KEY):",
      })) as string;
      if (p.isCancel(providerApiKey)) process.exit(0);
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

  // Repos
  const repoInput = (await p.text({
    message: "Repository URL(s) (comma-separated):",
    placeholder: "https://github.com/org/repo.git",
  })) as string;
  if (p.isCancel(repoInput)) process.exit(0);

  const repos = repoInput.split(",").map((url) => ({
    url: url.trim(),
    branch: "main",
  }));

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
        task_cpu: 2048,
        task_memory: 8192,
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

  execSync("docker build -t citio:latest .", {
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
    { name: "CITIO_CONFIG", value: "/app/citio.yaml" },
  ];

  if (config.provider === "codex") {
    envVars.push({ name: "OPENAI_API_KEY", value: config.providerApiKey });
  } else {
    envVars.push({ name: "ANTHROPIC_API_KEY", value: config.providerApiKey });
  }

  const taskDef = {
    family: "citio",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "2048",
    memory: "8192",
    ephemeralStorage: { sizeInGiB: 100 },
    executionRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
    taskRoleArn: `arn:aws:iam::${accountId}:role/citio-task-execution`,
    containerDefinitions: [
      {
        name: "citio",
        image: `${ecrUri}:latest`,
        essential: true,
        portMappings: [{ containerPort: 3001, protocol: "tcp" }],
        environment: envVars,
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

  p.log.success(
    `\nCitio is deploying to ECS!\n\nMonitor: aws ecs describe-services --cluster citio --services citio --region ${region} ${profileFlag}\nLogs: aws logs tail /ecs/citio --region ${region} ${profileFlag} --follow`
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
    p.log.info(
      "Skipping deploy. Run `citio init` again or deploy manually with:\n  docker build -t citio . && docker run --env-file .env citio"
    );
  }

  p.outro("Citio is ready! Send a message in your Slack channel to test.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
