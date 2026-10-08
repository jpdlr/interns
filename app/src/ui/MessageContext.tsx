/**
 * Which message a markdown body belongs to, for the in-message blocks that
 * answer it (quick replies, checklists, rule chips). Cards and other
 * markdown have no provider, so those blocks render read-only there.
 */
import React, { createContext, useContext } from "react";
import type { Attachment, InternsApi } from "../api";

export interface MessageContextValue {
  /** thread key the message lives in */
  thread: string;
  messageId: string;
  /** the intern who wrote it (speaker), when an intern did */
  speaker: string | null;
  /** JP has written in the thread since this message — its chips are spent */
  answered: boolean;
  /** send JP's reply to this message; `quoteAttachmentId` names the picture it is about */
  reply: (text: string, opts?: { quoteAttachmentId?: string }) => Promise<void>;
  /** the message's files (a pick block shows its pictures from these) */
  attachments?: Attachment[];
  api?: InternsApi;
  /** open a picture full screen, swiping through `gallery` */
  openAttachment?: (attachment: Attachment, gallery: Attachment[]) => void;
  /** put text in the composer (as a reply to this message) without sending */
  compose: (text: string) => void;
}

const Ctx = createContext<MessageContextValue | null>(null);

export function MessageProvider({ value, children }: { value: MessageContextValue; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMessageContext(): MessageContextValue | null {
  return useContext(Ctx);
}
