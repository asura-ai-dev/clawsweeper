import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface ActionStep {
  id?: string;
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface CompositeAction {
  inputs?: Record<string, { default?: unknown }>;
  runs?: { steps?: ActionStep[] };
}

interface Workflow {
  jobs?: Record<string, { steps?: ActionStep[] }>;
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

const configuredStateRepository = "${{ vars.CLAWSWEEPER_STATE_REPOSITORY }}";

test("state composite actions receive the configured repository through inputs", () => {
  const createToken = parse(
    readFileSync(".github/actions/create-state-token/action.yml", "utf8"),
  ) as CompositeAction;
  const setupState = parse(
    readFileSync(".github/actions/setup-state/action.yml", "utf8"),
  ) as CompositeAction;

  assert.equal(createToken.inputs?.["state-repository"]?.default, "");
  assert.equal(createToken.inputs?.owner?.default, "openclaw");
  assert.equal(createToken.inputs?.repository?.default, "clawsweeper-state");
  assert.equal(setupState.inputs?.["state-repository"]?.default, "");
  assert.equal(setupState.inputs?.repository?.default, "openclaw/clawsweeper-state");

  const resolveRepository = createToken.runs?.steps?.find((step) => step.id === "state-repository");
  assert.equal(
    resolveRepository?.env?.CONFIGURED_STATE_REPOSITORY,
    "${{ inputs.state-repository }}",
  );

  const checkout = setupState.runs?.steps?.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout?.with?.repository, "${{ inputs.state-repository || inputs.repository }}");
  const exportStateRoot = setupState.runs?.steps?.find((step) => step.name === "Export state root");
  assert.equal(
    exportStateRoot?.env?.STATE_REPOSITORY,
    "${{ inputs.state-repository || inputs.repository }}",
  );
});

test("composite actions do not directly reference workflow vars", () => {
  for (const path of yamlFiles(".github/actions").filter((path) => /\/action\.ya?ml$/.test(path))) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /\bvars\./, path);
  }
});

test("every state action call passes the configured repository", () => {
  const counts = { "create-state-token": 0, "setup-state": 0 };
  const stateActionPattern =
    /^\.\/(?:clawsweeper\/)?\.github\/actions\/(create-state-token|setup-state)$/;

  for (const path of yamlFiles(".github/workflows")) {
    const workflow = parse(readFileSync(path, "utf8")) as Workflow;
    for (const step of Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? [])) {
      const match = step.uses?.match(stateActionPattern);
      if (!match) continue;
      const action = match[1] as keyof typeof counts;
      counts[action] += 1;
      assert.equal(
        step.with?.["state-repository"],
        configuredStateRepository,
        `${path}: ${action}`,
      );
    }
  }

  assert.deepEqual(counts, { "create-state-token": 27, "setup-state": 26 });
});
