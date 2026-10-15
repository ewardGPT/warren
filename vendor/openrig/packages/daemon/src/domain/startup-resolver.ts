import type { StartupBlock, StartupFile, StartupAction, StartupProofSelection } from "./types.js";
import { validateStartupAction } from "./startup-validation.js";

export interface StartupLayerInputs {
  specStartup: StartupBlock;
  profileStartup?: StartupBlock;
  rigCultureFile?: string;
  rigStartup?: StartupBlock;
  podStartup?: StartupBlock;
  memberStartup?: StartupBlock;
  operatorStartup?: StartupBlock;
}

/**
 * Build effective startup in fixed additive order:
 * 1. Agent base startup
 * 2. Profile startup
 * 3. Rig culture file (synthetic StartupFile)
 * 4. Rig startup overlays
 * 5. Pod shared startup
 * 6. Member startup overlays
 * 7. Operator debug append (always last)
 *
 * Files and actions are concatenated in order. No deduplication —
 * adapters handle replay tolerance per the startup contract.
 *
 * @param inputs - all startup sources
 * @returns merged StartupBlock
 */
export function resolveStartup(inputs: StartupLayerInputs): StartupBlock {
  const files: StartupFile[] = [];
  const actions: StartupAction[] = [];

  // 1. Agent base startup
  appendBlock(inputs.specStartup, files, actions);

  // 2. Profile startup
  if (inputs.profileStartup) {
    appendBlock(inputs.profileStartup, files, actions);
  }

  // 3. Rig culture file (synthetic file entry)
  if (inputs.rigCultureFile) {
    files.push({
      path: inputs.rigCultureFile,
      deliveryHint: "auto",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    });
  }

  // 4. Rig startup overlays
  if (inputs.rigStartup) {
    appendBlock(inputs.rigStartup, files, actions);
  }

  // 5. Pod shared startup
  if (inputs.podStartup) {
    appendBlock(inputs.podStartup, files, actions);
  }

  // 6. Member startup overlays
  if (inputs.memberStartup) {
    appendBlock(inputs.memberStartup, files, actions);
  }

  // 7. Operator debug append (always last)
  if (inputs.operatorStartup) {
    appendBlock(inputs.operatorStartup, files, actions);
  }

  return { files, actions };
}

function appendBlock(block: StartupBlock, files: StartupFile[], actions: StartupAction[]): void {
  files.push(...block.files);
  actions.push(...block.actions);
}

/** Last applicable authored selection wins; omission adds no exercise. */
export function resolveStartupProof(
  actions: StartupAction[],
  context: "fresh_start" | "restore",
): StartupProofSelection {
  let selection: StartupProofSelection = { mode: "none", source: "default" };
  for (const [actionIndex, action] of actions.entries()) {
    if (action.type !== "startup_proof") continue;
    // Persisted/direct inputs must obey the same contract as authored YAML,
    // including overridden and inapplicable declarations.
    const errors = validateStartupAction({ ...action, applies_on: action.appliesOn }, actionIndex, "startup.");
    if (errors.length) throw new Error(errors.join("; "));
    if (action.appliesOn.includes(context)) {
      selection = { mode: action.value as StartupProofSelection["mode"], source: "authored", actionIndex };
    }
  }
  return selection;
}
