# AWS setup for Citio

Citio deploys into **your own AWS account** (ECS Fargate + ECR + optional EFS). This guide takes you from "no AWS CLI" to "ready to run `npx @lawrencehui/citio`" in ~10 minutes. If `aws sts get-caller-identity` already prints your account, skip to [Permissions](#3-permissions).

## 1. Install the AWS CLI

| OS | Command |
|---|---|
| macOS | `brew install awscli` |
| Ubuntu/Debian | `sudo apt install awscli` (or the [official installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) for v2) |
| Windows | [MSI installer](https://awscli.amazonaws.com/AWSCLIV2.msi) |

Verify: `aws --version` (v2.x recommended).

## 2. Connect the CLI to your account

**No AWS account yet?** Create one at [aws.amazon.com](https://aws.amazon.com/free/) (free tier — but see [Costs](#5-costs) below; Citio's container itself is not free-tier).

Pick ONE of these:

### Option A — IAM user + access key (simplest for a personal account)
1. AWS Console → **IAM → Users → Create user** (e.g. `citio-admin`).
2. Attach permissions — see [Permissions](#3-permissions) below.
3. Open the user → **Security credentials → Create access key** → choose *Command Line Interface (CLI)* → copy the key pair.
4. In your terminal:
   ```bash
   aws configure
   # AWS Access Key ID:      <paste>
   # AWS Secret Access Key:  <paste>
   # Default region name:    e.g. us-east-1 or eu-west-2
   # Default output format:  json
   ```

### Option B — IAM Identity Center / SSO (if your org uses it)
```bash
aws configure sso        # follow the browser prompts
aws sso login --profile <your-profile>
```
Then run the installer with that profile selected (it lists your profiles automatically).

**Verify either way:**
```bash
aws sts get-caller-identity
```
You should see your `Account` ID. The installer runs this same check before deploying.

## 3. Permissions

The deploy creates: an ECR repository, an ECS cluster/service/task definition, IAM task roles, a security group, CloudWatch log groups, and (optionally) an EFS filesystem.

**Simplest (personal account):** attach the AWS-managed **`AdministratorAccess`** policy to your IAM user. Fine for a personal/sandbox account; skip the JSON below.

**Least-privilege (shared or work account):** attach this policy instead — it is service-scoped to exactly what the installer calls:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "STS",  "Effect": "Allow", "Action": ["sts:GetCallerIdentity"], "Resource": "*" },
    { "Sid": "ECR",  "Effect": "Allow", "Action": ["ecr:GetAuthorizationToken", "ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], "Resource": "*" },
    { "Sid": "ECS",  "Effect": "Allow", "Action": ["ecs:CreateCluster", "ecs:RegisterTaskDefinition", "ecs:CreateService", "ecs:UpdateService", "ecs:DescribeServices", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:RunTask"], "Resource": "*" },
    { "Sid": "EFS",  "Effect": "Allow", "Action": ["elasticfilesystem:CreateFileSystem", "elasticfilesystem:DescribeFileSystems", "elasticfilesystem:CreateMountTarget", "elasticfilesystem:DescribeMountTargets"], "Resource": "*" },
    { "Sid": "EC2",  "Effect": "Allow", "Action": ["ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress"], "Resource": "*" },
    { "Sid": "Logs", "Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:DescribeLogGroups", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartLiveTail"], "Resource": "*" },
    { "Sid": "Secrets", "Effect": "Allow", "Action": ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret"], "Resource": "arn:aws:secretsmanager:*:*:secret:citio/*" },
    { "Sid": "IAM",  "Effect": "Allow", "Action": ["iam:CreateRole", "iam:GetRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PassRole"], "Resource": "arn:aws:iam::*:role/citio*" }
  ]
}
```

> Citio stores your Slack/GitHub/provider tokens in **AWS Secrets Manager** (`citio/runtime`), not as plaintext task-def environment variables — the `Secrets` statement lets the installer create/rotate them, and the task's own role reads them at container start.

> The `iam:PassRole` scoped to `role/citio*` is required so the ECS task can assume the roles the installer creates — this is the one people usually miss.

## 4. Region

Use the region closest to you (`us-east-1`, `eu-west-2`, …). The installer auto-detects your CLI's default region and offers it. All Citio resources land in one region — remember which, for teardown.

## 5. Costs

Fargate bills **per second**, so cost tracks how long the task actually runs:

| Task size (`citio.yaml` → `deploy.aws`) | ~Always-on / month | Good for |
|---|---|---|
| **1 vCPU / 2 GB** (default) | **~$36** | most use; bump memory if a big repo OOMs |
| 0.5 vCPU / 1 GB (`task_cpu: 512, task_memory: 1024`) | ~$18 | light/personal, small repos |
| 2 vCPU / 8 GB (`task_cpu: 2048, task_memory: 8192`) | ~$85 | large monorepos / heavy tasks |

Plus pennies for ECR storage and EFS (~$0.30/GB-mo). Not free-tier. Edit the size in `citio.yaml` and redeploy to change it.

**You rarely pay the monthly figure** — two ways to keep it near-zero:

```bash
# Pause when idle — stops compute charges, keeps the deployment + EFS:
citio pause      # (scales to 0 tasks; Slack goes quiet)
citio resume     # (~1–2 min to come back)

# Just recording a demo? Deploy, record, then remove everything:
citio destroy -- --yes --delete-efs
```
A one-hour demo session costs well under **$1**.

## 6. Teardown

```bash
aws ecs update-service --cluster citio --service citio --desired-count 0
aws ecs delete-service --cluster citio --service citio
aws ecs delete-cluster --cluster citio
aws ecr delete-repository --repository-name citio --force
aws secretsmanager delete-secret --secret-id citio/runtime --force-delete-without-recovery
# if you enabled EFS (find the ID first):
aws efs describe-file-systems --creation-token citio-memory --query 'FileSystems[0].FileSystemId'
aws efs delete-file-system --file-system-id <fs-...>   # delete mount targets first if prompted
```

## Troubleshooting

- **`Unable to locate credentials`** → run `aws configure` (Option A above).
- **`ExpiredToken` / SSO session expired** → `aws sso login --profile <profile>`.
- **`AccessDenied` on iam:PassRole** → attach the IAM statement from the policy above.
- **Docker push fails with `no basic auth credentials`** → the installer logs you into ECR automatically; if running by hand: `aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com`.
