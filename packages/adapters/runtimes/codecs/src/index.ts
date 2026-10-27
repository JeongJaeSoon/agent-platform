import {
  CLAUDE_DESCRIPTOR,
  claudeCheckpointCodec,
  claudeEventCodec,
} from "@werft-ai/runtime-claude-codec";
import type {
  CheckpointCodec,
  EventCodec,
  RuntimeDescriptor,
} from "@werft-ai/runtime-core";

export const installedCheckpointCodecs: readonly CheckpointCodec[] = [
  claudeCheckpointCodec,
];

export const installedDescriptors: readonly RuntimeDescriptor[] = [
  CLAUDE_DESCRIPTOR,
];

export const installedEventCodecs: readonly EventCodec[] = [claudeEventCodec];
