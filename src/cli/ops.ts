import * as p from "@clack/prompts";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { parse } from "yaml";

interface DeployTarget {
  region: string;
  profileFlag: string;
  cluster: string;
  service: string;
  ecrRepo: string;
}

function aws(cmd: string, target: DeployTarget, timeout = 30000): string {
  return execSync(`aws ${cmd} --region ${target.region} ${target.profileFlag}`, {
    encoding: "utf-8",
    stdio: "pipe",
    timeout,
  }).trim();
}

function tryAws(cmd: string, target: DeployTarget, timeout = 30000): string | null {
  try {
    return aws(cmd, target, timeout);
  } catch {
    return null;
  }
}

/** Read deploy target from ./citio.yaml (written by the installer). */
export function loadDeployTarget(): DeployTarget {
  if (!existsSync("citio.yaml")) {
    p.log.error("No citio.yaml in this directory. Run the installer first, or cd to where you ran it.");
    process.exit(1);
  }
  const config = parse(readFileSync("citio.yaml", "utf-8")) as {
    deploy?: { aws?: { region?: string; profile?: string; ecs_cluster?: string; ecs_service?: string; ecr_repo?: string } };
  };
  const awsCfg = config?.deploy?.aws || {};
  const profile = awsCfg.profile || "";
  return {
    region: awsCfg.region || "us-east-1",
    profileFlag: profile && profile !== "default" ? `--profile ${profile}` : "",
    cluster: awsCfg.ecs_cluster || "citio",
    service: awsCfg.ecs_service || "citio",
    ecrRepo: awsCfg.ecr_repo || "citio",
  };
}

// --- citio status ------------------------------------------------------------

export async function statusCommand(): Promise<void> {
  const target = loadDeployTarget();
  p.intro(`Citio deployment status — cluster "${target.cluster}" (${target.region})`);

  const serviceJson = tryAws(
    `ecs describe-services --cluster ${target.cluster} --services ${target.service} --query 'services[0].{status:status,running:runningCount,pending:pendingCount,desired:desiredCount,image:taskDefinition}' --output json`,
    target
  );
  if (!serviceJson || serviceJson === "null") {
    p.log.warn("Service not found — nothing is deployed (or wrong region/profile in citio.yaml).");
    p.outro("Not deployed.");
    return;
  }
  const service = JSON.parse(serviceJson) as { status: string; running: number; pending: number; desired: number; image: string };
  const healthy = service.status === "ACTIVE" && service.running >= service.desired && service.desired > 0;
  const stateLine = `service: ${service.status} · running ${service.running}/${service.desired}${service.pending ? ` (${service.pending} pending)` : ""}`;
  if (healthy) p.log.success(stateLine); else p.log.warn(stateLine);
  p.log.info(`task definition: ${service.image.split("/").pop()}`);

  const events = tryAws(
    `ecs describe-services --cluster ${target.cluster} --services ${target.service} --query 'services[0].events[0:3].message' --output text`,
    target
  );
  if (events) p.log.info(`recent events:\n  ${events.split("\t").join("\n  ")}`);

  // Most recent stopped task often explains an unhealthy service.
  if (!healthy) {
    const stoppedArn = tryAws(
      `ecs list-tasks --cluster ${target.cluster} --desired-status STOPPED --query 'taskArns[0]' --output text`,
      target
    );
    if (stoppedArn && stoppedArn !== "None") {
      const reason = tryAws(
        `ecs describe-tasks --cluster ${target.cluster} --tasks ${stoppedArn} --query 'tasks[0].stoppedReason' --output text`,
        target
      );
      if (reason && reason !== "None") p.log.warn(`last stopped task: ${reason}`);
    }
  }

  const logs = tryAws(
    `logs tail /ecs/${target.service} --since 10m --format short`,
    target,
    20000
  );
  if (logs) {
    const tail = logs.split("\n").slice(-8).join("\n  ");
    p.log.info(`last log lines:\n  ${tail}`);
    const ready = logs.includes('"type":"ready"');
    const slackOk = logs.includes('"type":"slack_connected"');
    if (ready && slackOk) p.log.success("agent booted and connected to Slack ✓");
  } else {
    p.log.info("no recent logs (task may be starting, or log group absent).");
  }

  p.outro(healthy ? "Healthy — message the bot in Slack." : "Not healthy — see above.");
}

// --- citio destroy -----------------------------------------------------------

export async function destroyCommand(): Promise<void> {
  const target = loadDeployTarget();
  // Non-interactive flags: --yes deletes service/cluster/ECR/logs; --delete-efs adds EFS.
  const args = process.argv.slice(3);
  const yesFlag = args.includes("--yes") || args.includes("-y");
  const efsFlag = args.includes("--delete-efs");
  p.intro(`Tear down Citio — cluster "${target.cluster}" (${target.region})`);

  p.note(
    "This deletes AWS resources created by the installer:\n" +
    `  • ECS service + cluster "${target.cluster}"\n` +
    `  • ECR repository "${target.ecrRepo}" (all pushed images)\n` +
    "  • CloudWatch log group\n" +
    "  • EFS filesystem (creation-token citio-memory) — ONLY if you confirm:\n" +
    "    it holds the agent's org memory, workspace state, and provider auth\n" +
    "\n" +
    "Kept: IAM roles + the citio-sg security group (harmless, reused on redeploy).",
    "What will be removed"
  );

  const confirm = yesFlag || ((await p.confirm({ message: "Delete the ECS service, cluster, ECR repo and logs?", initialValue: false })) as boolean);
  if (p.isCancel(confirm) || !confirm) {
    p.outro("Nothing deleted.");
    return;
  }

  const s = p.spinner();

  s.start("Scaling service to 0 and deleting it...");
  tryAws(`ecs update-service --cluster ${target.cluster} --service ${target.service} --desired-count 0`, target);
  tryAws(`ecs delete-service --cluster ${target.cluster} --service ${target.service} --force`, target, 60000);
  s.stop("Service deleted (or was absent).");

  s.start("Waiting for tasks to drain and deleting the cluster...");
  for (let attempt = 0; attempt < 18; attempt++) {
    const tasks = tryAws(`ecs list-tasks --cluster ${target.cluster} --query 'taskArns' --output text`, target);
    if (!tasks) break;
    if (tasks === "" || tasks === "None") break;
    execSync("sleep 10");
  }
  tryAws(`ecs delete-cluster --cluster ${target.cluster}`, target, 60000);
  s.stop("Cluster deleted (or was absent).");

  s.start("Deleting ECR repository...");
  tryAws(`ecr delete-repository --repository-name ${target.ecrRepo} --force`, target, 60000);
  s.stop("ECR repository deleted (or was absent).");

  s.start("Deleting log group...");
  tryAws(`logs delete-log-group --log-group-name /ecs/${target.service}`, target);
  s.stop("Log group deleted (or was absent).");

  // EFS is the dangerous one — separate, explicit confirmation.
  const efsId = tryAws(
    `efs describe-file-systems --creation-token citio-memory --query 'FileSystems[0].FileSystemId' --output text`,
    target
  );
  if (efsId && efsId !== "None") {
    const nukeEfs = efsFlag || ((await p.confirm({
      message: `Also delete EFS ${efsId}? This erases org memory, workspace state and provider auth (you'll re-auth on next deploy).`,
      initialValue: false,
    })) as boolean);
    if (!p.isCancel(nukeEfs) && nukeEfs) {
      const s2 = p.spinner();
      s2.start("Deleting EFS mount targets, then the filesystem...");
      const mountTargets = tryAws(
        `efs describe-mount-targets --file-system-id ${efsId} --query 'MountTargets[].MountTargetId' --output text`,
        target
      );
      if (mountTargets) {
        for (const mt of mountTargets.split(/\s+/).filter(Boolean)) {
          tryAws(`efs delete-mount-target --mount-target-id ${mt}`, target);
        }
        // Mount targets take ~30-60s to delete; the filesystem delete fails until they're gone.
        for (let attempt = 0; attempt < 12; attempt++) {
          const remaining = tryAws(
            `efs describe-mount-targets --file-system-id ${efsId} --query 'length(MountTargets)' --output text`,
            target
          );
          if (remaining === "0") break;
          execSync("sleep 10");
        }
      }
      const deleted = tryAws(`efs delete-file-system --file-system-id ${efsId}`, target);
      s2.stop(deleted === null ? "EFS delete failed — mount targets may still be draining; retry in a minute." : "EFS deleted.");
    } else {
      p.log.info(`EFS ${efsId} kept — your agent memory and auth survive the redeploy.`);
    }
  }

  p.outro("Teardown complete. Re-run the installer to deploy fresh.");
}
