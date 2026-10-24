// Features built on a finished scan. The fix plan reads a result only; the others replay
// the scan's session (session.ts) and never change it.
export { adviceFor, learnMoreFor, fixPlan, whatIf, winBack, FIX_TEXT, VIEWER_TEXT, FRESH_WALLET, NOW_RULES } from './fix-plan.ts';
export type { Advice, FixItem, FixKind, FixPlan, Viewer } from './fix-plan.ts';
export { replayLookup, rerun } from './replay.ts';
export type { ReplayLookup, RerunOptions } from './replay.ts';
export { beforeYouSend, PLANNED_HASH } from './before-you-send.ts';
export type { Destination, DestinationKind, PlannedTransfer, SendChange, SendCheck, SendOptions } from './before-you-send.ts';
export { compareWallets } from './compare.ts';
export type { Comparison, CompareOptions, CompareReason, CompareReasonKind, CompareTrail } from './compare.ts';
export { replayContext } from './replay.ts';
export { privacyTimeline } from './timeline.ts';
export type { Timeline, TimelineDrop, TimelineOptions, TimelinePoint } from './timeline.ts';
export { linkGraph, scanLinks, pairLink, assembleGraph, notPersonal, GRAPH_LIMITS, MAX_CONFIDENCE } from './link-graph.ts';
export type { GraphLimits, GraphLink, GraphNode, GraphNodeState, GraphReason, LinkGraph, LinkGraphOptions, LinkGraphRun } from './link-graph.ts';
