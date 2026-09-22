import type { ReceiptStatus } from "@agent-platform/contracts";
import type { JSX, ReactNode } from "react";

import { cn } from "../lib/cn.ts";
import { describeStatus } from "../status/vocabulary.ts";

export interface ReceiptLinkProps {
  readonly receiptId: string;
  readonly status: ReceiptStatus;
  /** Built by the screen that owns routing; this package never builds URLs. */
  readonly href: string;
  readonly children?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/** A receipt id you can follow, carrying its status as tone *and* text. */
export function ReceiptLink({
  receiptId,
  status,
  href,
  children,
  className,
}: ReceiptLinkProps): JSX.Element {
  const descriptor = describeStatus("receipt", status);

  return (
    <a
      className={cn("ap-receipt-link", className)}
      href={href}
      data-tone={descriptor.tone}
      data-status={status}
    >
      <span className="ap-receipt-link__dot" aria-hidden="true" />
      <span className="ap-receipt-link__text">{children ?? "접수 내역"}</span>
      {/* Visible, not hidden: the dot's colour is the same signal, and colour
          alone is not a signal for everyone (§4·§6). */}
      <span className="ap-receipt-link__status">{descriptor.label}</span>
      <span className="ap-visually-hidden">, 접수 번호 </span>
      <span className="ap-receipt-link__id">{receiptId}</span>
    </a>
  );
}
