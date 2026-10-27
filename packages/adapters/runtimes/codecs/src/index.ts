import {
  CLAUDE_DESCRIPTOR,
  claudeCheckpointCodec,
} from "@werft-ai/runtime-claude-codec";
import type {
  CheckpointCodec,
  RuntimeDescriptor,
} from "@werft-ai/runtime-core";

export const installedCheckpointCodecs: readonly CheckpointCodec[] = [
  claudeCheckpointCodec,
];

export const installedDescriptors: readonly RuntimeDescriptor[] = [
  CLAUDE_DESCRIPTOR,
];
