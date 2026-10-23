/*
 * packages/ui draws what the server said and nothing else: no fetch, no
 * permission judgement, no state-transition policy (Kollegium v1 §12.4). If a
 * component here needs to know whether something is allowed, the prop is wrong.
 *
 * Nothing here knows the API's contracts; the pieces that take their types
 * live in @werft-ai/react/components.
 */

export * from "./foundations/index.ts";
export * from "./patterns/index.ts";
export * from "./primitives/index.ts";
