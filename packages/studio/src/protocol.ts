import type {
  PatchEditOperation,
  PatchFieldPath,
  PatchScalar,
  StudioDocumentSnapshot,
} from "./edit-types.js";

export const STUDIO_PROTOCOL_VERSION = 1 as const;

export type StudioKeyboardInput =
  | Readonly<{ type: "keyDown" | "keyUp"; code: string }>
  | Readonly<{ type: "releaseAll" }>;

export type StudioEditInput =
  | Readonly<{
      type: "preview";
      protocol: 1;
      requestId: string;
      gestureId: string;
      baseRevision: string;
      path: PatchFieldPath;
      value: PatchScalar;
    }>
  | Readonly<{
      type: "cancelPreview";
      protocol: 1;
      requestId: string;
      gestureId: string;
    }>
  | Readonly<{
      type: "commit";
      protocol: 1;
      requestId: string;
      gestureId: string | null;
      baseRevision: string;
      operation: PatchEditOperation;
    }>
  | Readonly<{ type: "undo" | "redo"; protocol: 1; requestId: string; baseRevision: string }>;

export type StudioInput = StudioKeyboardInput | StudioEditInput;

export type StudioEditResult = Readonly<{
  type: "editResult";
  protocol: 1;
  requestId: string;
  status: "previewed" | "cancelled" | "committed" | "conflict" | "rejected";
  revision: string;
  message?: string;
  document?: StudioDocumentSnapshot;
}>;

export type StudioServerMessage =
  | Readonly<{ type: "state"; state: unknown }>
  | StudioEditResult
  | Readonly<{ type: "document"; protocol: 1; document: StudioDocumentSnapshot }>;
