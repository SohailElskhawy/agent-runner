import type { Project, ProjectConfiguration } from "@agentic-dev-runner/core";
import type { AgentStatusEntry } from "./ports.js";

export type DoctorCheckStatus = "PASS" | "WARN" | "FAIL";

export type DoctorCheck = {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly detail: string;
};

export type DoctorReport = {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
};

export type DoctorEnvironment = {
  readonly nodeVersion: string;
  readonly projectRoot: string;
  readonly storePath: string;
  readonly worktreesDir: string;
  readonly configuration: ProjectConfiguration | null;
  readonly configurationError: string | null;
  readonly projects: readonly Project[];
  readonly agents: readonly AgentStatusEntry[];
  readonly runGitVersion: () => Promise<{ ok: boolean; detail: string }>;
  readonly ensureWorktreesDir: () => Promise<{ ok: boolean; detail: string }>;
};

const MIN_NODE_MAJOR = 24;

export async function runDoctorChecks(
  env: DoctorEnvironment,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number.parseInt(env.nodeVersion.split(".")[0] ?? "0", 10);
  checks.push(
    nodeMajor >= MIN_NODE_MAJOR
      ? {
          name: "node",
          status: "PASS",
          detail: `node v${env.nodeVersion} (>= ${String(MIN_NODE_MAJOR)})`,
        }
      : {
          name: "node",
          status: "FAIL",
          detail: `node v${env.nodeVersion} is unsupported; install Node >= ${String(MIN_NODE_MAJOR)}`,
        },
  );
  const git = await env.runGitVersion();
  checks.push({ name: "git", status: git.ok ? "PASS" : "FAIL", detail: git.detail });
  checks.push(
    env.projects.length > 0
      ? { name: "project", status: "PASS", detail: `runner state at ${env.storePath}` }
      : {
          name: "project",
          status: "WARN",
          detail: 'runner is not initialized; run "agentic init"',
        },
  );
  if (env.configurationError !== null) {
    checks.push({
      name: "configuration",
      status: "FAIL",
      detail: env.configurationError,
    });
  } else if (env.configuration === null) {
    checks.push({
      name: "configuration",
      status: "WARN",
      detail:
        "no agentic.yaml found; tasks cannot route agents or resolve verification checks",
    });
  } else {
    checks.push({
      name: "configuration",
      status: "PASS",
      detail: `${String(env.configuration.agentProfiles.length)} agent profile(s), ${String(env.configuration.verificationChecks.length)} verification check(s)`,
    });
  }
  const available = env.agents.filter((agent) => agent.available);
  checks.push(
    available.length > 0
      ? {
          name: "agents",
          status: "PASS",
          detail: available
            .map(
              (agent) =>
                `${agent.id}${agent.version === null ? "" : ` ${agent.version}`}`,
            )
            .join(", "),
        }
      : {
          name: "agents",
          status: "WARN",
          detail: `no coding agent is available on PATH (${env.agents.map((agent) => agent.id).join(", ")})`,
        },
  );
  const worktrees = await env.ensureWorktreesDir();
  checks.push({
    name: "worktrees",
    status: worktrees.ok ? "PASS" : "FAIL",
    detail: `${env.worktreesDir} (${worktrees.detail})`,
  });
  return { checks, ok: checks.every((check) => check.status !== "FAIL") };
}
